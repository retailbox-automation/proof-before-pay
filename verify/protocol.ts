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

export const SPEC_LINES = {
  find: "I found three electricians nearby. Quick Volt's license number isn't in Florida's registry, so I left them out. Bright Current is licensed, 4.8 stars, 1,120 dollars. Want them?",
  readBack: "Bright Current, Thursday 10 to noon, six items for 1,120 dollars. You pay only for items proven by a photo. They agreed your front door camera logs when they arrive and leave. Should I book it?",
  booked: "Booked. The confirmation is on your home card.",
  review: "Five of six items are proven by photos taken during the visit. The hallway smoke detector has no photo yet, and a 300-dollar inspection line wasn't in the scope. I can pay 1,050 now. 370 waits for your OK.",
  payPrompt: "1,050 dollars to Bright Current with your card on file. Refunds follow Bright Current's policy on the card. Say your four-digit voice code.",
  paid: "Paid 1,050 dollars, sandbox. The receipt is on your home card. The other 370 stays unpaid until you say so.",
  status: "Two things: the hallway smoke detector needs a photo, and you haven't decided on the 300-dollar inspection line. Want a draft note to Bright Current?",
};
export const TOOLS = ["book_job", "cancel_booking", "draft_note", "find_pros", "job_status", "pay_proven", "review_invoice"];
export const VIEW_OF: Record<string, string> = { find_pros: "pros", book_job: "scope", cancel_booking: "scope", review_invoice: "payment", pay_proven: "confirm", job_status: "status", draft_note: "draft" };
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
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Out> {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const sc = (r.structuredContent ?? {}) as any;
  return { r, sc, steps: ((r._meta as any)?.steps ?? []) as any[], speech: sc.speech ?? "" };
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
  add("P2", "tools/list has the seven proofpay tools", TOOLS.join(","), names.join(","), JSON.stringify(names) === JSON.stringify(TOOLS));
  const hdr = seen.find((s) => s.method === "tools/list");
  add("P3", "client sends MCP-Protocol-Version after init", `"${TARGET}"`, JSON.stringify(hdr?.reqProto), hdr?.reqProto === TARGET);
  const uiLinks = toolList.map((t) => `${t.name}->${(t._meta as any)?.ui?.resourceUri}`);
  add("P4", "every tool links its card (_meta.ui.resourceUri)", "ui://proofpay/<view>.html per tool", uiLinks.join(" "), toolList.every((t) => (t._meta as any)?.ui?.resourceUri === `ui://proofpay/${VIEW_OF[t.name]}.html`));
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
  add("P5", "all six ui:// resources readable as MCP App HTML", "6 x text/html;profile=mcp-app, <!DOCTYPE html>, data-view", reads.join(" "), readsOk);

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
    bConf.sc.data?.status === "CONFIRMED" && cRead.sc.data?.readBack === true && /Should I cancel it\?/.test(cRead.speech) && /cancel/i.test(cRead.speech) && cDone.sc.data?.status === "CANCELLED");

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
  const pp = track("pay_proven", await call(cA, "pay_proven", {}));
  add("T10", "pay_proven without code: amount, payee, refund policy, asks for the voice code", SPEC_LINES.payPrompt, pp.speech, pp.speech === SPEC_LINES.payPrompt && pp.sc.data?.needsVoiceCode === true && pp.sc.data?.amount === 105000);
  const bad = track("pay_proven", await call(cA, "pay_proven", { voice_code: "0000" }));
  add("T11", "pay_proven with a wrong code: nothing paid", "isError, paid=false, no capture step", `${short(bad.speech, 80)} isError=${!!bad.r.isError} paid=${bad.sc.data?.paid}`,
    !!bad.r.isError && bad.sc.data?.paid === false && !bad.steps.some((s) => /capture/.test(s.op)));
  const ok = track("pay_proven", await call(cA, "pay_proven", { voice_code: "4719" }));
  add("T12", "pay_proven with the voice code: partial capture of the proven part", `${SPEC_LINES.paid} + 105000 captured`, `${ok.speech} | amount=${ok.sc.data?.amount} ${ok.sc.data?.captureId}`,
    ok.speech === SPEC_LINES.paid && ok.sc.data?.paid === true && ok.sc.data?.amount === 105000);
  const again = track("pay_proven", await call(cA, "pay_proven", { voice_code: "4719" }));
  add("T13", "pay_proven again: no second capture", "alreadyPaid, no capture step", `${short(again.speech, 80)} alreadyPaid=${again.sc.data?.alreadyPaid}`, again.sc.data?.alreadyPaid === true && !again.steps.some((s) => /capture/.test(s.op)));

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
  const badCode = await call(v.c, "pay_proven", { voice_code: "12ab" });
  const longTxt = await call(v.c, "find_pros", { trade: "electrician", job_summary: "x".repeat(500) });
  await v.close();
  add("N10", "input schema rejects a malformed voice code and an unbounded text field", "isError x2", `voice_code=12ab isError=${!!badCode.r.isError} | 500-char summary isError=${!!longTxt.r.isError}`, !!badCode.r.isError && !!longTxt.r.isError);
  return rows;
}
