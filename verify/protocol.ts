// Node-side checks against the running proofpay MCP server + sandbox services.
//   P*  protocol (initialize, headers, tools/list, ui:// resources, dual era)
//   T*  every tool through the SPEC §1 flow (voice lines word for word, plan numbers, policy gates)
//   S*  state: survives New session, a 2026-07-28 client, and a server process restart
//   W*  doorbell webhook: HMAC over raw bytes, bad/missing signature -> 401 and nothing stored
//   N*  negative controls (unknown session, foreign Origin, missing account link, strict protocol, bad input)
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "../src/core/doorbell/hmac.ts";
import { buttonPressWebhook } from "../src/core/doorbell/ring-format.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export type Row = { id: string; check: string; expected: string; actual: string; pass: boolean };
const ACCEPT = "application/json, text/event-stream";
const TARGET = "2025-11-25";
const MODERN = "2026-07-28";
const MODES = new Set(["live", "fixture", "sandbox", "simulated"]);

// SPEC §7.5 lines, word for word.
export const SPEC_LINES = {
  find: "Three electricians nearby. Quick Volt's license isn't in Florida's registry, so I left them out. Bright Current is licensed, 4.8 stars, 1,120 dollars. Want them?",
  readBack: "Bright Current, Thursday 10 to noon: six items, 1,120 dollars, paid only for items proven by a photo. They agreed your front door camera logs arrival and departure. Book it?",
  booked: "Booked. The confirmation is in your Alexa app.",
  review: "Five of six items are proven by photos from the visit. The hallway smoke detector has no photo, and a 300-dollar inspection wasn't in the scope. You can pay 1,050 now; 370 waits for you.",
  checkoutPrompt: "Paying 1,050 dollars to Bright Current with Visa ending 4242. Say your voice code.",
  checkoutDone: "Order confirmed. The other 370 stays unpaid until you say so.",
  status: "Two things: the hallway smoke detector needs a photo, and the 300-dollar inspection line is your call. Want a draft note to Bright Current?",
  warranty: "That's covered: Bright Current's 90-day labor warranty runs to January 13. I can book a free return visit with the original scope and photos attached.",
};
export const BEAT_1_4 = [SPEC_LINES.find, SPEC_LINES.readBack, SPEC_LINES.booked, SPEC_LINES.review, SPEC_LINES.checkoutPrompt, SPEC_LINES.checkoutDone];
export const secondsOf = (t: string) => t.trim().split(/\s+/).length / 2.5;
export const TOOLS = ["book_job", "cancel_booking", "draft_note", "find_pros", "job_status", "prepare_checkout", "review_invoice", "warranty_callback"];
export const VIEW_OF: Record<string, string | null> = { find_pros: "pros", book_job: "scope", cancel_booking: "scope", review_invoice: "payment", prepare_checkout: null, job_status: "status", draft_note: "draft", warranty_callback: "warranty" };
/** Tool names, API codes and internal ids must never reach the customer (SPEC §7.3). License numbers are public facts. */
export const TOOL_OR_ID = /\b(find_pros|book_job|cancel_booking|review_invoice|prepare_checkout|job_status|draft_note|warranty_callback|pay_proven|payment_failed|ready_for_complete)\b|\b(?:PB|CAP|ORD|INV|PH)-\d+\b|\bcs_\w+|\bpm_\w+|\bli_\d+|\bJ\d+\b|\bS\d\b|\bP\d\b|reconcile-v1|plan_hash|[{}]/;
const PAYMENT_FIELD = /voice|code|pin|card|payment|instrument|credential|cvv|pan\b/i;
const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : Array.isArray(o) ? o.flatMap(strings) : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);
const JOB = "master bath: replace outlets and smoke detectors"; // job_summary used by the checks

type Raw = { status: number; headers: Headers; body: any; text: string };
const auth = (user: string) => ({ Authorization: `Bearer pbp-sandbox-${user}` });

async function raw(url: string, method: string, message: unknown, headers: Record<string, string> = {}): Promise<Raw> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers }, body: message === undefined ? undefined : JSON.stringify(message) });
  const text = await res.text();
  let body: any;
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  try { body = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1].slice(5)) : text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, headers: res.headers, body, text };
}
const init = (protocolVersion: string, id = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "verify-raw", version: "0" } } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const listTools = (id = 2) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
async function rawSession(url: string, version: string, extra: Record<string, string>) {
  const r = await raw(url, "POST", init(version), extra);
  const sid = r.headers.get("mcp-session-id") ?? "";
  if (sid) await raw(url, "POST", initialized, { "mcp-session-id": sid, "mcp-protocol-version": r.body?.result?.protocolVersion ?? version, ...extra });
  return { r, sid };
}

async function session(url: string, user: string, opts?: Record<string, unknown>) {
  const c = new Client({ name: "verify-node", version: "0.1.0" }, opts as any);
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(user) } });
  await c.connect(t);
  return { c, t, close: async () => { await t.terminateSession().catch(() => {}); await c.close(); } };
}

type Out = { r: CallToolResult; sc: any; steps: any[]; speech: string };
let SURFACE: { tool: string; speech: string; card: string[] }[] | null = null;
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Out> {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const sc = (r.structuredContent ?? {}) as any;
  SURFACE?.push({ tool: name, speech: sc.speech ?? "", card: strings(sc.card ?? {}) });
  return { r, sc, steps: ((r._meta as any)?.steps ?? []) as any[], speech: sc.speech ?? "" };
}
type Ucp = { status: number; json: any; text: string };
async function ucpCall(base: string, user: string, method: string, path: string, body?: unknown, key?: string): Promise<Ucp> {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(user ? auth(user) : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, text };
}
const payBody = (pm: string) => ({ payment: { instruments: [{ id: "instr_v", handler_id: "partner_card_on_file", type: "card", credential: { type: "payment_method_reference", payment_method_id: pm } }] } });
async function charges(simBase: string): Promise<{ amount: number }[]> {
  return ((await (await fetch(`${simBase}/charges`)).json()) as { charges: { amount: number }[] }).charges;
}
const stepsValid = (steps: any[]) => steps.length > 0 && steps.every((s) => typeof s.service === "string" && typeof s.op === "string" && MODES.has(s.mode) && typeof s.ms === "number" && typeof s.summary === "string");
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function sim(simBase: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${simBase}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

function storedEvents(dataDir: string): number {
  const d = join(dataDir, "users");
  if (!existsSync(d)) return 0;
  let n = 0;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(join(d, f), "utf8"));
    for (const j of s.jobs ?? []) n += (j.cameraEvents ?? []).length;
  }
  return n;
}

// A separate server process (own pid file) so a restart is a real process restart.
async function spawnServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server/server.ts", "--port", String(port)], { cwd: ROOT, stdio: "ignore", env: { ...process.env, ...env } });
  writeFileSync(join(ROOT, ".pids", "restart-check.pid"), String(child.pid));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`restart-check server exited early (${child.exitCode})`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("restart-check server did not come up");
}
async function killServer(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(join(ROOT, ".pids", "restart-check.pid"), { force: true });
}

export async function runProtocolChecks(opts: { mcpUrl: string; simBase: string; dataDir: string; serverEnv: Record<string, string> }, log: (s: string) => void): Promise<Row[]> {
  const { mcpUrl, simBase, dataDir } = opts;
  const partner = simBase.replace(/\/sim$/, ""); // partner backend root: /checkout-sessions, /partner/*
  const surface: { tool: string; speech: string; card: string[] }[] = [];
  const webhookUrl = mcpUrl.replace("/mcp", "/webhooks/doorbell");
  const rows: Row[] = [];
  const add = (id: string, check: string, expected: string, actual: string, pass: boolean) => {
    rows.push({ id, check, expected, actual, pass });
    log(`${pass ? "PASS" : "FAIL"} ${id} ${check} :: ${actual}`);
  };
  const stamp = Date.now().toString(36);
  const userA = `verify-a-${stamp}`; // main SPEC flow
  const userB = `verify-b-${stamp}`; // booking cancelled in a later session
  await sim(simBase, "/reset", { scenario: "demo" });
  SURFACE = surface;

  // ---------- P: protocol ----------
  const seen: { method: string; reqProto: string | null }[] = [];
  const recordingFetch: typeof fetch = async (input, initArg) => {
    const res = await fetch(input, initArg);
    let method = "?";
    try { method = JSON.parse(String(initArg?.body ?? "{}")).method ?? "?"; } catch { /* body-less */ }
    seen.push({ method, reqProto: new Headers(initArg?.headers).get("mcp-protocol-version") });
    return res;
  };
  const cA = new Client({ name: "verify-node", version: "0.1.0" });
  const tA = new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: recordingFetch, requestInit: { headers: auth(userA) } });
  await cA.connect(tA);
  add("P1", "initialize negotiates protocolVersion (official client)", `"${TARGET}" + Mcp-Session-Id`, `${JSON.stringify(cA.getNegotiatedProtocolVersion())} sid=${tA.sessionId ? "present" : "MISSING"}`, cA.getNegotiatedProtocolVersion() === TARGET && !!tA.sessionId);
  const toolList = (await cA.listTools()).tools;
  const names = toolList.map((t) => t.name).sort();
  add("P2", "tools/list: the eight proofpay tools (pay_proven removed)", TOOLS.join(","), names.join(","), JSON.stringify(names) === JSON.stringify(TOOLS));
  const hdr = seen.find((s) => s.method === "tools/list");
  add("P3", "client sends MCP-Protocol-Version after init", `"${TARGET}"`, JSON.stringify(hdr?.reqProto), hdr?.reqProto === TARGET);
  const uiLinks = toolList.map((t) => `${t.name}->${(t._meta as any)?.ui?.resourceUri}`);
  add("P4", "tools link their card; prepare_checkout has none (the checkout screen is Alexa+'s)", "ui://proofpay/<view>.html per tool, none for prepare_checkout", uiLinks.join(" "),
    toolList.every((t) => (VIEW_OF[t.name] === null ? !(t._meta as any)?.ui : (t._meta as any)?.ui?.resourceUri === `ui://proofpay/${VIEW_OF[t.name]}.html`)));
  const inputs = toolList.flatMap((t) => Object.keys(((t.inputSchema as any)?.properties ?? {}) as object).map((k) => `${t.name}.${k}`));
  const payFields = inputs.filter((k) => PAYMENT_FIELD.test(k.split(".")[1]));
  add("P6", "no tool takes payment data (voice code, PIN, card, instrument)", "0 payment fields in any input schema", `${payFields.length ? payFields.join(",") : "none"} among ${inputs.length} fields`, payFields.length === 0);
  const res = (await cA.listResources()).resources.map((r) => r.uri).sort();
  const reads: string[] = [];
  let readsOk = res.length === 6;
  for (const uri of res) {
    const rr = await cA.readResource({ uri });
    const ct = rr.contents[0] as { mimeType?: string; text?: string };
    const v = uri.match(/ui:\/\/proofpay\/(\w+)\.html/)?.[1];
    const ok = ct?.mimeType === "text/html;profile=mcp-app" && !!ct.text?.startsWith("<!DOCTYPE html>") && !!ct.text?.includes(`data-view="${v}"`);
    readsOk &&= ok;
    reads.push(`${v}:${ok ? "ok" : "BAD"}(${Math.round((ct?.text?.length ?? 0) / 1024)}KB)`);
  }
  add("P5", "all six ui:// resources readable as MCP App HTML", "pros, scope, payment, status, draft, warranty", reads.join(" "), readsOk && res.join(",") === ["draft", "payment", "pros", "scope", "status", "warranty"].map((v) => `ui://proofpay/${v}.html`).join(","));

  // ---------- T: cancel flow first (the sandbox allows one active booking) ----------
  const b1 = await session(mcpUrl, userB);
  await call(b1.c, "find_pros", { trade: "electrician", job_summary: JOB });
  const refused = await call(b1.c, "book_job", { pro_id: "P3", confirm: true });
  add("T0", "book_job refuses the pro whose license is not in the registry", "refused, no booking", short(refused.speech), refused.sc.data?.refused === true && /license/.test(refused.speech));
  await call(b1.c, "book_job", { pro_id: "P2", confirm: false });
  const bConf = await call(b1.c, "book_job", { pro_id: "P2", confirm: true });
  await b1.close();
  const b2 = await session(mcpUrl, userB);
  const cRead = await call(b2.c, "cancel_booking", { confirm: true }); // confirm=true without a read-back -> read-back first
  const cDone = await call(b2.c, "cancel_booking", { confirm: true });
  await b2.close();
  add("T1", "cancel_booking in a LATER session: read-back with policy, then cancel", "read-back (policy) -> CANCELLED",
    `${bConf.sc.data?.status} | ${short(cRead.speech, 90)} | ${cDone.sc.data?.status}`,
    bConf.sc.data?.status === "CONFIRMED" && cRead.sc.data?.readBack === true && /Should I cancel it\?/.test(cRead.speech) && /cancellation policy: Free cancellation up to 48 hours/.test(cRead.speech) && cDone.sc.data?.status === "CANCELLED");

  // ---------- T: the SPEC §1 flow ----------
  const allSteps: string[] = [];
  const track = (name: string, o: Out) => { allSteps.push(`${name}:${o.steps.length}${stepsValid(o.steps) ? "" : "!"}`); return o; };
  const f = track("find_pros", await call(cA, "find_pros", { trade: "electrician", job_summary: JOB }));
  const p3 = f.sc.data?.pros?.find((p: any) => p.proId === "P3");
  add("T2", "find_pros: SPEC voice line", SPEC_LINES.find, f.speech, f.speech === SPEC_LINES.find);
  add("T3", "find_pros: P3 excluded (not found), P1 recommended, license steps", "P3 not_found + 1 marketplace + 3 registry steps",
    `P3=${p3?.license?.verdict}/eligible=${p3?.eligible} rec=${f.sc.data?.recommendedProId} steps=${f.steps.map((s) => `${s.op}[${s.mode}]`).join(", ")}`,
    p3?.license?.verdict === "not_found" && p3?.eligible === false && f.sc.data?.recommendedProId === "P1" && f.steps.filter((s) => /license lookup/.test(s.op)).length === 3);
  const rb = track("book_job", await call(cA, "book_job", { pro_id: "P1", confirm: false }));
  add("T4", "book_job confirm=false: voice read-back (SPEC), not booked yet", SPEC_LINES.readBack, rb.speech, rb.speech === SPEC_LINES.readBack && rb.sc.data?.needsConfirmation === true);
  const est = rb.sc.data?.estimate;
  add("T4b", "estimate returns SPI charges, policies (CANCELLATION), paymentInstruments (CARD)", "6 charges $1,120.00 · CANCELLATION · CARD Visa **** 4242",
    `${est?.charges?.length} charges ${est?.charges?.reduce((a: number, c: any) => a + c.amount, 0)} · ${est?.policies?.map((x: any) => x.policyType).join(",")} · ${est?.paymentInstruments?.map((x: any) => `${x.paymentInstrumentType} ${x.paymentInstrumentId}`).join(",")}`,
    est?.charges?.length === 6 && est.charges.reduce((a: number, c: any) => a + c.amount, 0) === 112000 && est.policies?.[0]?.policyType === "CANCELLATION" && est.paymentInstruments?.[0]?.paymentInstrumentType === "CARD" && est.paymentInstruments[0].paymentInstrumentId === "Visa **** 4242");
  const bk = track("book_job", await call(cA, "book_job", { pro_id: "P1", confirm: true }));
  const consent = bk.sc.data?.consent;
  add("T5", "book_job confirm=true: booked, consent by both sides", `${SPEC_LINES.booked} + CONFIRMED + consent granted`, `${bk.speech} | ${bk.sc.data?.status} | consent pro=${consent?.byPro} home=${consent?.byHomeowner} granted=${consent?.granted}`,
    bk.speech === SPEC_LINES.booked && bk.sc.data?.status === "CONFIRMED" && consent?.granted === true && consent?.byPro === true && consent?.byHomeowner === true);
  const early = track("review_invoice", await call(cA, "review_invoice", {}));
  add("T6", "review_invoice before the visit: no invoice yet, nothing decided", "no invoice", short(early.speech), early.sc.data?.invoice === null);

  // simulated time: the sandbox emits signed camera webhooks to our endpoint
  const before = storedEvents(dataDir);
  const adv = await sim(simBase, "/advance", { to: "demo" });
  const delivered = (adv.emitted ?? []).filter((e: any) => e.delivered).length;
  const after = storedEvents(dataDir);
  add("T7", "simulated time: signed camera webhooks delivered and attached to the consented job", "all delivered (HTTP 200); in-window events stored, out-of-window dropped",
    `emitted=${adv.emitted?.length} delivered=${delivered} stored ${before}->${after} invoiceVisible=${adv.invoiceVisible} photos=${adv.photosVisible}`,
    adv.emitted?.length > 0 && delivered === adv.emitted.length && after - before > 0 && after - before < adv.emitted.length && adv.invoiceVisible === true);

  const rv = track("review_invoice", await call(cA, "review_invoice", {}));
  const plan = rv.sc.data?.plan;
  add("T8", "review_invoice: SPEC voice line", SPEC_LINES.review, rv.speech, rv.speech === SPEC_LINES.review);
  add("T9", "review_invoice: plan numbers (reconcile-v1)", "payNow 105000, waits 37000, blockers [], notConfirmed 2",
    `payNow=${plan?.payNow} waits=${plan?.waits} blockers=${JSON.stringify(plan?.blockers)} notConfirmed=${plan?.notConfirmed?.length} engine=${plan?.engine} steps=${rv.steps.map((s) => s.service).join(" > ")}`,
    plan?.payNow === 105000 && plan?.waits === 37000 && plan?.blockers?.length === 0 && plan?.notConfirmed?.length === 2 && plan?.engine === "reconcile-v1");
  // ---------- K: checkout belongs to Alexa+ (SPEC §7.1). Here the test plays the Alexa+ side. ----------
  const p1 = track("prepare_checkout", await call(cA, "prepare_checkout", {}));
  const d1 = p1.sc.data ?? {};
  const leaked = strings(d1).concat(Object.keys(d1)).filter((x) => /instrument|credential|voice|4242|last_digits|pm_/i.test(x));
  add("K1", "prepare_checkout: proven items only, no payment data in or out", "5 items, total 105000, waits 37000 not included, no card/instrument/code",
    `${d1.checkoutSessionId} · ${d1.lineItems?.length} items · total ${d1.totals?.total} · waits ${d1.waits} · leaked=${leaked.length ? leaked.join(",") : "none"}`,
    !p1.r.isError && d1.lineItems?.length === 5 && d1.totals?.total === 105000 && d1.totals?.fees === 0 && d1.waits === 37000 && leaked.length === 0 && !d1.lineItems.some((l: any) => /S5|inspection/i.test(`${l.itemId} ${l.title}`)));
  const linesA = (d1.lineItems ?? []).map((l: any) => ({ item: { id: l.itemId }, quantity: 1 }));
  const ucpNoAuth = await ucpCall(partner, "", "POST", "/checkout-sessions", { line_items: linesA }, "k-noauth");
  const noKey = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: linesA });
  const profile = (await (await fetch(`${partner}/.well-known/ucp`)).json()) as any;
  add("K2", "checkout endpoints: bearer required, Idempotency-Key required, discovery profile", "401, 400, stored-card handler partner_card_on_file",
    `HTTP ${ucpNoAuth.status}/${noKey.status} · handler ${profile?.ucp?.payment_handlers?.["com.amazon.payments.stored_payment_method"]?.[0]?.id}`,
    ucpNoAuth.status === 401 && noKey.status === 400 && profile?.ucp?.payment_handlers?.["com.amazon.payments.stored_payment_method"]?.[0]?.id === "partner_card_on_file");
  const cA1 = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: linesA }, "k-a1");
  await ucpCall(partner, userA, "PUT", `/checkout-sessions/${cA1.json.id}`, { line_items: linesA, buyer: { first_name: "Sandbox", last_name: "Homeowner" } });
  const tamper = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: [...linesA, { item: { id: linesA[0].item.id.replace(/S\d$/, "S5") }, quantity: 1 }] }, "k-tamper");
  const priced = await ucpCall(partner, userA, "PUT", `/checkout-sessions/${cA1.json.id}`, { line_items: linesA.map((l: any, i: number) => (i ? l : { ...l, item: { ...l.item, price: 999999 } })), buyer: { first_name: "Sandbox" } });
  const wrongPrep = await ucpCall(partner, userA, "POST", "/partner/checkout/prepare", { partnerBookingId: bk.sc.data?.partnerBookingId, scopeItemIds: ["S1", "S2", "S3", "S4", "S6"], amount: 112000, planHash: d1.planHash });
  // The plan changes after the session was created (a different plan hash, all six items): the old session can't be paid.
  const otherHash = "f".repeat(64);
  const swap = await ucpCall(partner, userA, "POST", "/partner/checkout/prepare", { partnerBookingId: bk.sc.data?.partnerBookingId, scopeItemIds: ["S1", "S2", "S3", "S4", "S5", "S6"], amount: 112000, planHash: otherHash });
  const stale = await ucpCall(partner, userA, "POST", `/checkout-sessions/${cA1.json.id}/complete`, payBody("pm_visa_4242"), "k-stale");
  add("K3", "wrong amount rejected: extra item, changed price, amount != proven total, stale plan hash", "409 quote_mismatch x2, 409 amount_mismatch, 409 on the stale session, 0 charges",
    `create+S5 ${tamper.status} ${tamper.json.error?.code} · price ${priced.status} ${priced.json.error?.code} · prepare 112000 ${wrongPrep.status} ${wrongPrep.json.error?.code} · stale complete ${stale.status} ${stale.json.error?.code} · charges ${(await charges(simBase)).length}`,
    tamper.status === 409 && tamper.json.error?.code === "quote_mismatch" && priced.status === 409 && priced.json.error?.code === "quote_mismatch" && wrongPrep.status === 409 && wrongPrep.json.error?.code === "amount_mismatch" && swap.status === 200 && stale.status === 409 && /quote_changed|amount_mismatch/.test(stale.json.error?.code ?? "") && (await charges(simBase)).length === 0);
  // Prepare again from the real plan: a fresh session (the tampered one is canceled).
  const p2 = track("prepare_checkout", await call(cA, "prepare_checkout", {}));
  const d2 = p2.sc.data ?? {};
  const lines = (d2.lineItems ?? []).map((l: any) => ({ item: { id: l.itemId }, quantity: 1 }));
  const created = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: lines }, "k-create");
  const replay = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: lines }, "k-create");
  const conflict = await ucpCall(partner, userA, "POST", "/checkout-sessions", { line_items: lines.slice(1) }, "k-create");
  add("K4", "Create: the session prepare_checkout staged; Idempotency-Key replay and conflict", "201 same id; same key+body -> identical; same key+other body -> 409",
    `${created.status} ${created.json.id}=${d2.checkoutSessionId} · replay ${replay.status} identical=${replay.text === created.text} · conflict ${conflict.status} ${conflict.json.code}`,
    created.status === 201 && created.json.id === d2.checkoutSessionId && created.json.id !== cA1.json.id && replay.status === 201 && replay.text === created.text && conflict.status === 409 && conflict.json.code === "idempotency_conflict");
  const ready = await ucpCall(partner, userA, "PUT", `/checkout-sessions/${created.json.id}`, { line_items: lines, buyer: { first_name: "Sandbox", last_name: "Homeowner" } });
  const shown = ready.json;
  add("K5", "what Alexa+ reads back: seller, 5 items, Subtotal/Fees/Total, Visa ending 4242, refund-policy link title", "ready_for_complete · $1,050.00 · visa 4242 · \"Refund policy · Bright Current Electric\"",
    `${shown.status} · ${shown.metadata?.seller} · ${shown.line_items?.length} items · ${shown.totals?.map((t: any) => `${t.type} ${t.amount}`).join(", ")} · ${shown.payment?.instruments?.[0]?.display?.brand} ${shown.payment?.instruments?.[0]?.display?.last_digits} · "${shown.links?.find((l: any) => l.type === "refund_policy")?.title}"`,
    shown.status === "ready_for_complete" && shown.line_items?.length === 5 && shown.totals?.find((t: any) => t.type === "total")?.amount === 105000 && shown.totals?.find((t: any) => t.type === "fee")?.amount === 0 && shown.payment?.instruments?.[0]?.display?.last_digits === "4242" && shown.links?.find((l: any) => l.type === "refund_policy")?.title === "Refund policy · Bright Current Electric");
  const declined = await ucpCall(partner, userA, "POST", `/checkout-sessions/${created.json.id}/complete`, payBody("pm_visa_0002"), "k-decline");
  const notOffered = await ucpCall(partner, userA, "POST", `/checkout-sessions/${created.json.id}/complete`, payBody("pm_mc_9999"), "k-other");
  add("K6", "decline = HTTP 200 incomplete + payment_failed; a card not returned at Create is refused; nothing charged", "200 incomplete payment_failed x2, 0 charges",
    `${declined.status} ${declined.json.status} ${declined.json.messages?.[0]?.code} · ${notOffered.status} ${notOffered.json.status} ${notOffered.json.messages?.[0]?.code} · charges ${(await charges(simBase)).length}`,
    declined.status === 200 && declined.json.status === "incomplete" && declined.json.messages?.[0]?.code === "payment_failed" && notOffered.status === 200 && notOffered.json.messages?.[0]?.code === "payment_failed" && (await charges(simBase)).length === 0);
  const done = await ucpCall(partner, userA, "POST", `/checkout-sessions/${created.json.id}/complete`, payBody("pm_visa_4242"), "k-pay");
  const again = await ucpCall(partner, userA, "POST", `/checkout-sessions/${created.json.id}/complete`, payBody("pm_visa_4242"), "k-pay");
  const second = await ucpCall(partner, userA, "POST", `/checkout-sessions/${created.json.id}/complete`, payBody("pm_visa_4242"), "k-pay-2");
  const edit = await ucpCall(partner, userA, "PUT", `/checkout-sessions/${created.json.id}`, { line_items: lines, buyer: { first_name: "Sandbox" } });
  const ch = await charges(simBase);
  add("K7", "double Complete does not double charge (same key replays; new key 409; completed is immutable)", "completed once; replay identical; 409; PUT 409; 1 charge of 105000",
    `${done.status} ${done.json.status} · replay identical=${again.text === done.text} · new key ${second.status} · PUT ${edit.status} · charges ${ch.map((c) => c.amount).join(",")}`,
    done.status === 200 && done.json.status === "completed" && again.text === done.text && second.status === 409 && edit.status === 409 && ch.length === 1 && ch[0].amount === 105000);
  const pAfter = track("prepare_checkout", await call(cA, "prepare_checkout", {}));
  add("K8", "prepare_checkout after payment: nothing more to pay", "isError, 'already paid'", short(pAfter.speech, 90), !!pAfter.r.isError && /already paid/.test(pAfter.speech));

  // ---------- S: state survives a new session / a 2026-07-28 client / a restart ----------
  const sid1 = tA.sessionId!;
  await tA.terminateSession();
  await cA.close();
  const gone = await raw(mcpUrl, "POST", listTools(), { "mcp-session-id": sid1, "mcp-protocol-version": TARGET, ...auth(userA) });
  add("S1", "old session id rejected after DELETE (unknown session)", "HTTP 404", `HTTP ${gone.status} ${gone.body?.error?.message ?? ""}`, gone.status === 404);
  const a2 = await session(mcpUrl, userA);
  const st = track("job_status", await call(a2.c, "job_status", {}));
  add("S2", "New session: job_status from saved state (SPEC line)", SPEC_LINES.status, `sid ${sid1.slice(0, 8)}…->${a2.t.sessionId?.slice(0, 8)}… | ${st.speech}`, a2.t.sessionId !== sid1 && st.speech === SPEC_LINES.status);
  const dn = track("draft_note", await call(a2.c, "draft_note", {}));
  add("T14", "draft_note: plain note, never sent", "text mentions the open items, sent=false", short(dn.sc.data?.text?.replace(/\n/g, " ") ?? "", 110),
    dn.sc.data?.sent === false && /hallway smoke detector/i.test(dn.sc.data?.text ?? "") && /Electrical inspection/.test(dn.sc.data?.text ?? "") && /never sends/.test(dn.sc.card?.footer ?? ""));
  add("S2b", "the add-on learns the payment by reading the checkout session (UCP Get), never by taking it", "K8 read the session (completed); job_status paid 105000 from saved state",
    `K8 steps=${pAfter.steps.map((x: any) => `${x.service}: ${x.summary}`).join(" > ")} | job_status paid=${st.sc.data?.paid}`,
    pAfter.steps.some((x: any) => /checkout session/i.test(x.service) && /completed/.test(x.summary)) && st.sc.data?.paid === 105000);
  const other = await call(a2.c, "job_status", {}).catch(() => null);
  await a2.close();
  const fresh = await session(mcpUrl, `verify-fresh-${stamp}`);
  const none = await call(fresh.c, "job_status", {});
  await fresh.close();
  add("S3", "control: a different, fresh account sees no jobs", "isError, 'no jobs'", `${short(none.speech, 60)} isError=${!!none.r.isError} (same account again: ${other?.sc.data?.jobId})`, !!none.r.isError && /don't have any jobs/.test(none.speech) && other?.sc.data?.jobId === "J1");

  const m = await session(mcpUrl, userA, { versionNegotiation: { mode: "auto" } });
  const mv = m.c.getNegotiatedProtocolVersion();
  const mst = await call(m.c, "job_status", {});
  await m.c.close();
  add("S4", "2026-07-28 client on the same endpoint (SDK dual era), same saved state", `"${MODERN}", no session id, same status line`, `${JSON.stringify(mv)} sid=${m.t.sessionId ?? "none"} | ${short(mst.speech, 60)} steps=${mst.steps.length}`,
    mv === MODERN && !m.t.sessionId && mst.speech === SPEC_LINES.status && stepsValid(mst.steps));

  const restartUrl = "http://127.0.0.1:8789/mcp";
  let p = await spawnServer(8789, opts.serverEnv);
  const pid1 = p.pid;
  let restartActual = "", restartPass = false;
  try {
    const r1 = await session(restartUrl, userA);
    const s1 = await call(r1.c, "job_status", {});
    await r1.close();
    await killServer(p);
    p = await spawnServer(8789, opts.serverEnv);
    const r2 = await session(restartUrl, userA);
    const s2 = await call(r2.c, "job_status", {});
    await r2.close();
    restartActual = `pid ${pid1} -> ${p.pid} | paid ${s1.sc.data?.paid} -> ${s2.sc.data?.paid} | open ${s2.sc.data?.open?.length}`;
    restartPass = pid1 !== p.pid && s2.speech === SPEC_LINES.status && s2.sc.data?.paid === 105000;
  } finally {
    await killServer(p);
  }
  add("S5", "state survives a server PROCESS restart (file store, atomic rename)", "new pid, same status, paid 105000", restartActual, restartPass);
  add("T15", "every tool result carries _meta.steps {service, op, mode, ms, summary}", "all valid", allSteps.join(" "), allSteps.every((s) => !s.endsWith("!")));

  // ---------- R: warranty, a month later (SPEC §7.5 beat 6) ----------
  const advW = await sim(simBase, "/advance", { to: "warranty" });
  const wr = await session(mcpUrl, userA);
  const issue = "The master bath fan stopped working again.";
  const offer = track("warranty_callback", await call(wr.c, "warranty_callback", { issue }));
  const od = offer.sc.data ?? {};
  add("R1", "warranty_callback offer: SPEC line; 90-day labor warranty to Jan 13, 2027; $0.00 return visit Mon Nov 16 10-12; evidence scope + 2 photos + visit log", SPEC_LINES.warranty,
    `${offer.speech} | ends ${od.warrantyEnds} · visit ${od.returnVisit?.start}..${od.returnVisit?.end} · $${od.amount} · evidence ${JSON.stringify(od.evidence)} · clock ${advW.nowLocal}`,
    offer.speech === SPEC_LINES.warranty && od.covered === true && od.amount === 0 && od.booked === false && new Date(od.warrantyEnds).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === "1/13/2027" &&
    od.returnVisit?.start === "2026-11-16T15:00:00.000Z" && od.returnVisit?.end === "2026-11-16T17:00:00.000Z" && od.evidence?.scopeItems === 6 && od.evidence?.photos === 2 && od.evidence?.visit?.arrivedAt != null);
  const booked = track("warranty_callback", await call(wr.c, "warranty_callback", { issue, confirm: true }));
  const wrows = (booked.sc.card?.rows ?? []).map((r: any) => r.label);
  await wr.close();
  add("R2", "warranty_callback confirm: $0.00 return visit booked; warranty card", "booked, no charge, 5 rows incl. return visit",
    `${short(booked.speech, 100)} | ${wrows.join(" ; ")}`,
    booked.sc.data?.booked === true && /no charge/.test(booked.speech) && wrows.length === 5 && wrows.some((r: string) => /Return visit Mon, Nov 16, 10:00 AM–12:00 PM/.test(r)) && (await charges(simBase)).length === 1);

  // ---------- U: customer surface (SPEC §7.3, §7.5) ----------
  const leaks = surface.flatMap((x) => [x.speech, ...x.card].filter((t) => TOOL_OR_ID.test(t)).map((t) => `${x.tool}: "${short(t, 60)}" (${t.match(TOOL_OR_ID)?.[0]})`));
  add("U1", "no tool name, API code or internal id in any Alexa line or card text", `0 hits over ${surface.length} results`, leaks.length ? leaks.slice(0, 4).join(" | ") : `0 hits over ${surface.length} results`, leaks.length === 0 && surface.length > 10);
  const homeCard = surface.filter((x) => /home card/i.test(x.speech));
  add("U2", "voice lines work without a screen: 'in your Alexa app', never 'on your home card'", "0", `${homeCard.length} · Alexa app mentions ${surface.filter((x) => /in your Alexa app/.test(x.speech)).length}`, homeCard.length === 0);

  // ---------- W: webhook ----------
  const wb = buttonPressWebhook({ accountId: "ava1.ring.account.SANDBOX01", requestId: `verify-${stamp}`, sentAt: Date.now(), deviceId: "sandbox-front-door-01", timestamp: Date.now() });
  const body = JSON.stringify(wb);
  const n0 = storedEvents(dataDir);
  const w1 = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sign(body, "wrong-key") }, body });
  const w1b = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sign(body, opts.serverEnv.RING_SIGNING_KEY) }, body: body.replace("}", " }") }); // one byte changed
  const w2 = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const n1 = storedEvents(dataDir);
  add("W1", "webhook with a bad signature, a tampered body, or no signature", "401 x3, nothing stored", `HTTP ${w1.status}/${w1b.status}/${w2.status} stored ${n0}->${n1}`, w1.status === 401 && w1b.status === 401 && w2.status === 401 && n1 === n0);
  const w3 = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sign(body, opts.serverEnv.RING_SIGNING_KEY) }, body });
  const w3j = await w3.json().catch(() => ({}));
  const n2 = storedEvents(dataDir);
  add("W2", "control: correctly signed event outside any consented booking window", "HTTP 200, dropped, not stored", `HTTP ${w3.status} ${JSON.stringify(w3j)} stored ${n1}->${n2}`, w3.status === 200 && w3j.dropped === 1 && n2 === n1);

  // ---------- N: negative controls ----------
  const n5 = await raw(mcpUrl, "POST", listTools(5), { "mcp-session-id": "00000000-0000-0000-0000-000000000000", "mcp-protocol-version": TARGET, ...auth(userA) });
  add("N1", "unknown Mcp-Session-Id", "HTTP 404", `HTTP ${n5.status} ${n5.body?.error?.message ?? ""}`, n5.status === 404);
  const evil = await raw(mcpUrl, "POST", init(TARGET), { Origin: "http://evil.example", ...auth(userA) });
  add("N2", "initialize from a foreign Origin (DNS-rebinding guard)", "HTTP 403", `HTTP ${evil.status} ${evil.body?.error?.message ?? ""}`, evil.status === 403);
  const noAuth = await raw(mcpUrl, "POST", init(TARGET));
  add("N3", "initialize without the (simulated) account link", "HTTP 401 + WWW-Authenticate", `HTTP ${noAuth.status} www-authenticate=${noAuth.headers.get("www-authenticate")}`, noAuth.status === 401 && !!noAuth.headers.get("www-authenticate"));
  const pre = await fetch(mcpUrl, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5178", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,mcp-session-id,mcp-protocol-version" } });
  add("N4", "CORS preflight from the host origin", "204, allow-origin, Authorization allowed, Mcp-Session-Id exposed",
    `HTTP ${pre.status} allow-origin=${pre.headers.get("access-control-allow-origin")} expose=${pre.headers.get("access-control-expose-headers")}`,
    pre.status === 204 && pre.headers.get("access-control-allow-origin") === "http://127.0.0.1:5178" && /authorization/i.test(pre.headers.get("access-control-allow-headers") ?? "") && /mcp-session-id/i.test(pre.headers.get("access-control-expose-headers") ?? ""));
  const old = await rawSession(mcpUrl, "2024-11-05", auth(userA));
  add("N5", "strict: initialize asks 2024-11-05", `answers "${TARGET}" (client must disconnect)`, `result.protocolVersion=${JSON.stringify(old.r.body?.result?.protocolVersion)} HTTP ${old.r.status}`, old.r.body?.result?.protocolVersion === TARGET);
  if (old.sid) await raw(mcpUrl, "DELETE", undefined, { "mcp-session-id": old.sid, ...auth(userA) });
  const good = await rawSession(mcpUrl, TARGET, auth(userA));
  const hOld = await raw(mcpUrl, "POST", listTools(6), { "mcp-session-id": good.sid, "mcp-protocol-version": "2024-11-05", ...auth(userA) });
  add("N6", "strict: header MCP-Protocol-Version 2024-11-05 on a 2025-11-25 session", "HTTP 400", `HTTP ${hOld.status} ${short(String(hOld.body?.error?.message ?? ""), 90)}`, hOld.status === 400);
  const hJunk = await raw(mcpUrl, "POST", listTools(7), { "mcp-session-id": good.sid, "mcp-protocol-version": "1999-01-01", ...auth(userA) });
  add("N7", "header MCP-Protocol-Version 1999-01-01 (unknown)", "HTTP 400", `HTTP ${hJunk.status} ${short(String(hJunk.body?.error?.message ?? ""), 90)}`, hJunk.status === 400);
  const steal = await raw(mcpUrl, "POST", listTools(8), { "mcp-session-id": good.sid, "mcp-protocol-version": TARGET, ...auth(`intruder-${stamp}`) });
  add("N8", "another account reusing someone's session id", "HTTP 403", `HTTP ${steal.status} ${steal.body?.error?.message ?? ""}`, steal.status === 403);
  const noSid = await raw(mcpUrl, "POST", listTools(9), { "mcp-protocol-version": TARGET, ...auth(userA) });
  add("N9", "non-initialize request without Mcp-Session-Id", "HTTP 400", `HTTP ${noSid.status} ${short(String(noSid.body?.error?.message ?? ""), 90)}`, noSid.status === 400);
  if (good.sid) await raw(mcpUrl, "DELETE", undefined, { "mcp-session-id": good.sid, ...auth(userA) });
  const v = await session(mcpUrl, userA);
  const longIssue = await call(v.c, "warranty_callback", { issue: "x".repeat(500) });
  const longTxt = await call(v.c, "find_pros", { trade: "electrician", job_summary: "x".repeat(500) });
  const gone2 = await v.c.callTool({ name: "pay_proven", arguments: {} }).then((r: any) => !!r.isError).catch(() => true);
  await v.close();
  add("N10", "input schema rejects unbounded text fields; pay_proven no longer exists", "isError x3", `500-char issue isError=${!!longIssue.r.isError} | 500-char summary isError=${!!longTxt.r.isError} | pay_proven rejected=${gone2}`, !!longIssue.r.isError && !!longTxt.r.isError && gone2);
  return rows;
}
