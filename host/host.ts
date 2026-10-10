// Echo Show 8 simulator (browser): the Alexa+ experience simulated in our web host.
// - Official MCP client over Streamable HTTP (protocol 2025-11-25, Mcp-Session-Id), simulated account linking via
//   "Authorization: Bearer pbp-sandbox-<user>".
// - Deterministic utterance -> tool mapping (no LLM). In the real product Alexa+ supplies language understanding.
// - MCP Apps cards rendered through AppBridge + a sandbox proxy on a second origin.
// - Customer surface (inside #device): add-on cards, Alexa's lines as subtitles with seconds, and the platform's
//   checkout layer. Developer view (outside #device, SPEC §7.3): one chip per tools/call, one sub-chip per
//   _meta.steps entry with a LIVE/FIXTURE/SANDBOX/SIMULATED badge, session id, transcript.
// - "Alexa+ checkout · simulated" (SPEC §7.1): when the customer asks to pay (voice, or the card's ui/message
//   "Pay for this order"), this host plays Alexa+: it asks the add-on to prepare the proven items (no payment data),
//   then calls the partner's UCP-shaped checkout endpoints itself, reads back items, totals, card and refund policy,
//   checks the 4-digit voice code locally, and completes the session. The add-on never receives the code or the card.
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport, getToolUiResourceUri, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";

type Cfg = { mcpUrl: string; sandboxProxyUrl: string; simUrl: string; checkoutBase: string; voiceCode: string };
type Mode = "live" | "fixture" | "sandbox" | "simulated";
type Step = { service: string; op: string; mode: Mode; ms: number; summary: string };
type Turn = {
  n: number; source: "typed" | "voice" | "tap" | "demo"; utterance: string; tool: string | null; args: Record<string, unknown> | null;
  speech: string; seconds: number; steps: Step[]; isError: boolean; view: string | null; ms: number; beat: number;
};
type Session = {
  id: string; status: string;
  line_items: { item: { id: string; title: string; price: number } }[];
  totals: { type: string; amount: number }[];
  payment?: { instruments: { id: string; handler_id: string; display: { brand: string; last_digits: string } }[] };
  links: { type: string; title: string; url: string }[];
  messages?: { code: string; content: string }[];
  metadata?: { seller: string };
};
type Checkout = { session: Session; seller: string; waits: number; attempts: number; instrument: { id: string; brand: string; last4: string } };
type Pending =
  | { kind: "pickPro"; proId: string } | { kind: "book"; proId: string } | { kind: "cancel" } | { kind: "draft" }
  | { kind: "warranty"; issue: string } | { kind: "checkoutCode"; checkout: Checkout } | null;

const CFG = (window as unknown as { __PBP: Cfg }).__PBP;
const HOST_INFO = { name: "alexa-plus-host-simulator", version: "0.2.0" };
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const WORDS_PER_SECOND = 2.5;
const params = new URLSearchParams(location.search);
const FAST = params.get("pace") === "fast";
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const state = {
  userId: params.get("user") ?? `demo-${Date.now().toString(36)}`,
  protocolVersion: "",
  sessionId: "",
  tools: [] as string[],
  sessionsOpened: 0,
  turns: [] as Turn[],
  pending: null as Pending,
  card: { renders: 0, initialized: 0, view: "" },
  sim: { advanced: false, nowLocal: "" },
  checkout: { opened: 0, confirmed: 0, sessionId: "", ucpCalls: [] as { method: string; path: string; status: number; idempotencyKey: string | null }[] },
  demo: { running: false, beat: 0, done: false },
  beat: 0,
  errors: [] as string[],
};
(window as unknown as { __host: typeof state }).__host = state;

let client: Client | undefined;
let transport: StreamableHTTPClientTransport | undefined;
let tools = new Map<string, Tool>();
let bridge: AppBridge | undefined;
let lastPros: { proId: string; businessName: string }[] = [];
let queue: Promise<unknown> = Promise.resolve();

const seconds = (text: string) => Math.round((text.trim().split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND) * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const spoken = (c: number) => (c % 100 === 0 ? (c / 100).toLocaleString("en-US") : (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function shortName(business: string): string {
  const generic = /^(electric|electrical|electricians?|pros?|services?|llc|inc|co|company|group|contracting|contractors?)$/i;
  const w = business.split(/\s+/);
  while (w.length > 1 && generic.test(w[w.length - 1])) w.pop();
  return w.join(" ");
}

// ---------- UI helpers ----------
function transcript(role: "user" | "assistant" | "error", text: string): void {
  const li = document.createElement("li");
  li.className = role;
  li.textContent = `${role === "user" ? "You" : role === "assistant" ? "Alexa" : "Error"}: ${text}`;
  $("transcript").append(li);
  if (role === "error") state.errors.push(text);
}

function subtitles(user: string | null, alexa: string): void {
  if (user !== null) $("sub-user").textContent = user ? `You: ${user}` : "";
  $("sub-alexa").textContent = alexa;
  $("sub-seconds").textContent = alexa ? `${seconds(alexa)} s` : "";
  $("sub-alexa").dataset.seconds = String(seconds(alexa));
}

/** Developer view only: never inside the device frame. */
function chip(label: string, args: string | null): { el: HTMLElement; done: (steps: Step[], ms: number, error?: string) => void } {
  const el = document.createElement("div");
  el.className = "chip";
  el.dataset.state = "pending";
  el.dataset.tool = label;
  const head = document.createElement("div");
  head.className = "chip-head";
  const code = document.createElement("code");
  code.textContent = label;
  const ms = document.createElement("span");
  ms.className = "ms";
  ms.textContent = "…";
  head.append(code, ms);
  el.append(head);
  if (args) {
    const a = document.createElement("div");
    a.className = "chip-args";
    a.textContent = args;
    el.append(a);
  }
  const ul = document.createElement("ul");
  ul.className = "steps";
  el.append(ul);
  $("chips").prepend(el);
  return {
    el,
    done(steps, total, error) {
      el.dataset.state = error ? "error" : "done";
      ms.textContent = `${total} ms`;
      for (const s of steps) {
        const li = document.createElement("li");
        li.className = "step";
        li.dataset.mode = s.mode;
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = s.mode.toUpperCase();
        li.append(b, document.createTextNode(`${s.service} · ${s.op} — ${s.summary}`));
        ul.append(li);
      }
      if (error) {
        const li = document.createElement("li");
        li.className = "step";
        li.textContent = `error: ${error}`;
        ul.append(li);
      }
    },
  };
}

function record(tool: string | null, args: Record<string, unknown> | null, speech: string, utterance: string, source: Turn["source"], steps: Step[] = [], isError = false, view: string | null = null, ms = 0): void {
  state.turns.push({ n: state.turns.length + 1, source, utterance, tool, args, speech, seconds: seconds(speech), steps, isError, view, ms, beat: state.beat });
  document.body.dataset.turns = String(state.turns.length);
}

// ---------- MCP connection ----------
async function connect(): Promise<void> {
  client = new Client(HOST_INFO, {
    capabilities: { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } }, // MCP Apps support
  });
  transport = new StreamableHTTPClientTransport(new URL(CFG.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer pbp-sandbox-${state.userId}` } }, // simulated account linking
  });
  await client.connect(transport);
  state.protocolVersion = client.getNegotiatedProtocolVersion() ?? "(unknown)";
  state.sessionId = transport.sessionId ?? "(none)";
  state.sessionsOpened += 1;
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  state.tools = [...tools.keys()];
  $("user").textContent = state.userId;
  $("protocol").textContent = state.protocolVersion;
  $("session").textContent = state.sessionId;
  $("tools").textContent = state.tools.join(", ");
  document.body.dataset.connected = String(state.sessionsOpened);
}

async function teardownCard(): Promise<void> {
  if (bridge) {
    // MCP Apps: the host MUST send ui/resource-teardown before removing the view.
    await Promise.race([bridge.teardownResource({}), sleep(1000)]).catch(() => {});
    await bridge.close().catch(() => {});
    bridge = undefined;
  }
  $("card").replaceChildren();
}

async function newSession(): Promise<void> {
  hideCheckout();
  await teardownCard();
  const before = state.sessionId;
  const c = chip("New MCP session", null);
  const t0 = performance.now();
  if (transport) await transport.terminateSession().catch(() => {}); // HTTP DELETE: the server drops the session
  if (client) await client.close().catch(() => {});
  await connect();
  c.done([{ service: "MCP", op: "DELETE + initialize", mode: "sandbox", ms: 0, summary: `${before.slice(0, 8)}… → ${state.sessionId.slice(0, 8)}… · saved state stays on the server` }], Math.round(performance.now() - t0));
  state.pending = null;
  subtitles("", "");
  transcript("assistant", "(new conversation; your jobs are saved on your account)");
}

async function renderCard(toolName: string, args: Record<string, unknown>, uri: string): Promise<CallToolResult> {
  const c = client!;
  const resultPromise = c.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>;
  const resource = await c.readResource({ uri });
  const content = resource.contents[0];
  if (!content || content.mimeType !== RESOURCE_MIME_TYPE || !("text" in content)) throw new Error(`unexpected UI resource: ${content?.mimeType}`);

  await teardownCard();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin"); // required for the proxy (it sits on another origin)
  iframe.title = "Proof Before Pay card";
  const proxyReady = new Promise<void>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.data?.method === "ui/notifications/sandbox-proxy-ready") {
        window.removeEventListener("message", onMsg);
        resolve();
      }
    };
    window.addEventListener("message", onMsg);
  });
  // Honour the card's declared CSP (MCP Apps _meta.ui.csp): the proxy serves the matching CSP header.
  const csp = ((content as { _meta?: { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } } })._meta?.ui?.csp) ?? {};
  iframe.src = `${CFG.sandboxProxyUrl}?csp=${encodeURIComponent(JSON.stringify({ resourceDomains: csp.resourceDomains ?? [], connectDomains: csp.connectDomains ?? [] }))}`;
  $("card").append(iframe);
  await proxyReady;

  const caps = c.getServerCapabilities();
  const b = new AppBridge(c, HOST_INFO, { serverTools: caps?.tools, serverResources: caps?.resources, message: { text: {} } }, {
    hostContext: {
      theme: "dark", platform: "web", displayMode: "inline", availableDisplayModes: ["inline"],
      deviceClass: "echo-show-8", locale: "en-US", timeZone: "America/New_York",
      containerDimensions: { maxWidth: 1220, maxHeight: 590 }, deviceCapabilities: { touch: true, hover: false },
    },
  });
  bridge = b;
  b.onsizechange = ({ height }) => { if (height) iframe.style.height = `${Math.min(height, 590)}px`; };
  b.onloggingmessage = (p) => console.log("[view log]", p);
  b.onmessage = async ({ content: blocks }) => {
    // A tap on a card CTA arrives as ui/message: the user's next turn. "Pay for this order" starts Alexa+ checkout.
    const text = blocks.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ").trim();
    if (text) void enqueue(text, "tap");
    return {};
  };
  const initialized = new Promise<void>((resolve) => { b.oninitialized = () => { state.card.initialized += 1; resolve(); }; });
  await b.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await b.sendSandboxResourceReady({ html: content.text });
  await initialized; // nothing may be sent to the view before it is initialized
  await b.sendToolInput({ arguments: args });
  const result = await resultPromise;
  await b.sendToolResult(result);
  state.card.renders += 1;
  state.card.view = (result.structuredContent as { view?: string } | undefined)?.view ?? "";
  iframe.dataset.rendered = String(state.card.renders);
  iframe.dataset.view = state.card.view;
  return result;
}

// ---------- turns ----------
function nextPending(tool: string, data: Record<string, unknown>, args: Record<string, unknown>): Pending {
  if (tool === "find_pros") {
    lastPros = ((data.pros as { proId: string; businessName: string; eligible: boolean }[]) ?? []).filter((p) => p.eligible);
    return data.recommendedProId ? { kind: "pickPro", proId: String(data.recommendedProId) } : null;
  }
  if (tool === "book_job" && data.needsConfirmation) return { kind: "book", proId: String(args.pro_id) };
  if (tool === "cancel_booking" && data.needsConfirmation) return { kind: "cancel" };
  if (tool === "job_status" && Array.isArray(data.open) && data.open.length) return { kind: "draft" };
  if (tool === "warranty_callback" && data.needsConfirmation) return { kind: "warranty", issue: String(data.issue ?? args.issue) };
  return null;
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; steps: Step[]; ms: number }> {
  if (!client) throw new Error("not connected");
  const c = chip(`tools/call proofpay.${tool}`, JSON.stringify(args));
  const t0 = performance.now();
  const def = tools.get(tool);
  const uri = def ? getToolUiResourceUri(def) : undefined;
  let result: CallToolResult;
  try {
    result = uri ? await renderCard(tool, args, uri) : ((await client.callTool({ name: tool, arguments: args })) as CallToolResult);
  } catch (err) {
    c.done([], Math.round(performance.now() - t0), String(err));
    throw err;
  }
  const steps = ((result._meta as { steps?: Step[] } | undefined)?.steps ?? []) as Step[];
  const ms = Math.round(performance.now() - t0);
  c.done(steps, ms);
  return { result, steps, ms };
}

async function runTool(tool: string, args: Record<string, unknown>, utterance: string, source: Turn["source"]): Promise<void> {
  const { result, steps, ms } = await callTool(tool, args);
  const sc = (result.structuredContent ?? {}) as { speech?: string; view?: string; data?: Record<string, unknown> };
  const speech = sc.speech ?? result.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");
  subtitles(null, speech);
  transcript(result.isError ? "error" : "assistant", speech);
  state.pending = nextPending(tool, sc.data ?? {}, args);
  record(tool, args, speech, utterance, source, steps, !!result.isError, sc.view ?? null, ms);
}

function localReply(text: string, utterance: string, source: Turn["source"]): void {
  subtitles(null, text);
  transcript("assistant", text);
  record(null, null, text, utterance, source);
}

// ---------- Alexa+ checkout (simulated platform layer) ----------
async function ucp(method: "POST" | "PUT" | "GET", path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; json: Session & { code?: string; error?: { code: string; message: string } } }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer pbp-sandbox-${state.userId}`, "UCP-Agent": 'profile="simulated-alexa-plus"', "Request-Id": `req-${crypto.randomUUID()}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${CFG.checkoutBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  state.checkout.ucpCalls.push({ method, path, status: res.status, idempotencyKey: idempotencyKey ?? null });
  return { status: res.status, json };
}

function hideCheckout(): void {
  $("checkout-layer").hidden = true;
  $("checkout-layer").dataset.state = "";
  $("card").classList.remove("dimmed");
}

function showCheckout(co: Checkout): void {
  const s = co.session;
  const layer = $("checkout-layer");
  $("checkout-seller").textContent = `${co.seller} · via the marketplace`;
  const ul = $("checkout-items");
  ul.replaceChildren();
  for (const l of s.line_items) {
    const li = document.createElement("li");
    li.dataset.kind = "item";
    const a = document.createElement("span"); a.textContent = l.item.title;
    const b = document.createElement("span"); b.textContent = usd(l.item.price);
    li.append(a, b);
    ul.append(li);
  }
  const dl = $("checkout-totals");
  dl.replaceChildren();
  const label: Record<string, string> = { subtotal: "Subtotal", fee: "Fees", total: "Total" };
  for (const t of s.totals) {
    const d = document.createElement("div");
    d.dataset.kind = t.type;
    const dt = document.createElement("dt"); dt.textContent = label[t.type] ?? cap(t.type);
    const dd = document.createElement("dd"); dd.textContent = usd(t.amount);
    d.append(dt, dd);
    dl.append(d);
  }
  $("checkout-card").textContent = `${cap(co.instrument.brand)} ending ${co.instrument.last4} · sandbox`;
  const refund = s.links.find((x) => x.type === "refund_policy");
  ($("checkout-refund") as HTMLAnchorElement).textContent = refund?.title ?? "Refund policy";
  ($("checkout-refund") as HTMLAnchorElement).href = refund?.url ?? "#";
  $("checkout-code-dots").textContent = "· · · ·";
  $("checkout-code").hidden = false;
  $("checkout-status").textContent = "";
  layer.dataset.state = "awaiting-code";
  layer.hidden = false;
  $("card").classList.add("dimmed");
}

async function startCheckout(utterance: string, source: Turn["source"]): Promise<void> {
  // 1. The add-on prepares the proven items (no payment data in or out).
  const { result, steps, ms } = await callTool("prepare_checkout", {});
  const sc = (result.structuredContent ?? {}) as { speech?: string; data?: { checkoutSessionId?: string; seller?: string; waits?: number; lineItems?: { itemId: string }[] } };
  if (result.isError || !sc.data?.checkoutSessionId) {
    const speech = sc.speech ?? "I can't start a payment right now.";
    subtitles(null, speech);
    transcript("error", speech);
    record("prepare_checkout", {}, speech, utterance, source, steps, true, null, ms);
    return;
  }
  // 2. Alexa+ creates and updates the checkout session at the partner (UCP-shaped endpoints).
  const c = chip("Alexa+ checkout (simulated) · partner UCP endpoints", null);
  const t0 = performance.now();
  const lines = (sc.data.lineItems ?? []).map((l) => ({ item: { id: l.itemId }, quantity: 1 }));
  const created = await ucp("POST", "/checkout-sessions", { line_items: lines, context: { language: "en-US", address_country: "US" } }, crypto.randomUUID());
  const ucpSteps: Step[] = [{ service: "Partner checkout", op: "POST /checkout-sessions (Idempotency-Key)", mode: "sandbox", ms: 0, summary: `HTTP ${created.status} · ${created.json.status ?? created.json.error?.code}` }];
  if (created.status !== 201) {
    c.done(ucpSteps, Math.round(performance.now() - t0), created.json.error?.message ?? "create failed");
    localReply("I couldn't start the checkout. Nothing was charged.", utterance, source);
    return;
  }
  const updated = await ucp("PUT", `/checkout-sessions/${created.json.id}`, { line_items: lines, buyer: { first_name: "Sandbox", last_name: "Homeowner" } });
  ucpSteps.push({ service: "Partner checkout", op: "PUT /checkout-sessions/{id}", mode: "sandbox", ms: 0, summary: `HTTP ${updated.status} · ${updated.json.status}` });
  c.done(ucpSteps, Math.round(performance.now() - t0));
  const session = updated.json;
  const inst = session.payment?.instruments?.[0];
  if (updated.status !== 200 || session.status !== "ready_for_complete" || !inst) {
    localReply("I couldn't start the checkout. Nothing was charged.", utterance, source);
    return;
  }
  const co: Checkout = { session, seller: sc.data.seller ?? session.metadata?.seller ?? "the pro", waits: sc.data.waits ?? 0, attempts: 0, instrument: { id: inst.id, brand: inst.display.brand, last4: inst.display.last_digits } };
  state.checkout.opened += 1;
  state.checkout.sessionId = session.id;
  showCheckout(co);
  // 3. Alexa+ reads back payee, amount and card, then asks for the voice code.
  const total = session.totals.find((t) => t.type === "total")?.amount ?? 0;
  const speech = `Paying ${spoken(total)} dollars to ${shortName(co.seller)} with ${cap(co.instrument.brand)} ending ${co.instrument.last4}. Say your voice code.`;
  subtitles(null, speech);
  transcript("assistant", speech);
  state.pending = { kind: "checkoutCode", checkout: co };
  record("alexa-plus-checkout", null, speech, utterance, source, [...steps, ...ucpSteps], false, null, ms);
}

async function finishCheckout(code: string, source: Turn["source"]): Promise<void> {
  const p = state.pending;
  if (p?.kind !== "checkoutCode") return;
  const co = p.checkout;
  $("checkout-code-dots").textContent = "• • • •";
  if (code !== CFG.voiceCode) { // checked by the platform (here: the host); never sent to the add-on
    co.attempts += 1;
    if (co.attempts >= 3) {
      await ucp("POST", `/checkout-sessions/${co.session.id}/cancel`, {});
      $("checkout-layer").dataset.state = "failed";
      $("checkout-status").textContent = "Payment stopped";
      state.pending = null;
      return localReply("That code didn't match three times, so I stopped the payment. Nothing was charged.", "••••", source);
    }
    $("checkout-status").textContent = "Code didn't match";
    return localReply("That code didn't match. Say your voice code again.", "••••", source);
  }
  const c = chip("Alexa+ checkout (simulated) · complete", null);
  const t0 = performance.now();
  const instrument = { id: `instr_${crypto.randomUUID().slice(0, 8)}`, handler_id: "partner_card_on_file", type: "card", credential: { type: "payment_method_reference", payment_method_id: co.instrument.id } };
  const done = await ucp("POST", `/checkout-sessions/${co.session.id}/complete`, { payment: { instruments: [instrument] } }, crypto.randomUUID());
  const steps: Step[] = [{ service: "Partner checkout", op: "POST /checkout-sessions/{id}/complete (Idempotency-Key)", mode: "sandbox", ms: 0, summary: `HTTP ${done.status} · ${done.json.status ?? done.json.error?.code}${done.json.messages?.[0] ? ` · ${done.json.messages[0].code}` : ""}` }];
  c.done(steps, Math.round(performance.now() - t0));
  state.pending = null;
  if (done.status === 200 && done.json.status === "completed") {
    state.checkout.confirmed += 1;
    $("checkout-layer").dataset.state = "confirmed";
    $("checkout-code").hidden = true;
    $("checkout-status").textContent = "Order confirmed";
    const speech = co.waits > 0 ? `Order confirmed. The other ${spoken(co.waits)} stays unpaid until you say so.` : "Order confirmed.";
    subtitles(null, speech);
    transcript("assistant", speech);
    record("alexa-plus-checkout", null, speech, "••••", source, steps);
    return;
  }
  $("checkout-layer").dataset.state = "failed";
  $("checkout-status").textContent = "Payment didn't go through";
  localReply(`The payment didn't go through. ${done.json.messages?.[0]?.content ?? ""} Nothing was charged.`.replace(/\s+/g, " ").trim(), "••••", source);
}

const DIGIT: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function voiceCodeOf(u: string): string | null {
  const words = u.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const digits = words.map((w) => (/^\d+$/.test(w) ? w : DIGIT[w] ?? "")).join("");
  return /^\d{4}$/.test(digits) && words.every((w) => /^\d+$/.test(w) || w in DIGIT) ? digits : null;
}
const YES = /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|confirm|please do|book it)\b/i;
const NO = /^(no|nope|don't|do not|never mind|stop)\b/i;
const PAY_INTENT = /^pay for this order\b|\bpay\b.*\bproven\b|\bpay (?:the )?\$?\d/i;
const WARRANTY_INTENT = /\b(stopped working|not working|isn't working|doesn't work|broke|broken|covered|warranty|failed again)\b/i;

/** Deterministic intent matching. The real product has Alexa+ language understanding here. */
async function handle(raw: string, source: Turn["source"]): Promise<void> {
  const u = raw.trim().replace(/^alexa[,!.]?\s*/i, "");
  const p = state.pending;
  const code = p?.kind === "checkoutCode" ? voiceCodeOf(u) : null;
  subtitles(code ? "••••" : raw.trim(), "");
  transcript("user", code ? "••••" : raw.trim());
  if (code) return finishCheckout(code, source);
  if (p?.kind !== "checkoutCode") hideCheckout();
  if (p && YES.test(u)) {
    if (p.kind === "pickPro") return runTool("book_job", { pro_id: p.proId, confirm: false }, raw, source);
    if (p.kind === "book") return runTool("book_job", { pro_id: p.proId, confirm: true }, raw, source);
    if (p.kind === "cancel") return runTool("cancel_booking", { confirm: true }, raw, source);
    if (p.kind === "draft") return runTool("draft_note", {}, raw, source);
    if (p.kind === "warranty") return runTool("warranty_callback", { issue: p.issue, confirm: true }, raw, source);
  }
  if (p && NO.test(u)) {
    if (p.kind === "checkoutCode") { await ucp("POST", `/checkout-sessions/${p.checkout.session.id}/cancel`, {}); hideCheckout(); }
    state.pending = null;
    return localReply("OK, I won't.", raw, source);
  }
  if (/\bdraft\b/i.test(u)) return runTool("draft_note", {}, raw, source);
  if (PAY_INTENT.test(u)) return startCheckout(raw, source);
  if (/\binvoice\b|\bpay (?:him|her|them)\b/i.test(u)) return runTool("review_invoice", {}, raw, source);
  if (/\bcancel\b/i.test(u) && /\b(booking|appointment|job|electrician|visit)\b/i.test(u)) return runTool("cancel_booking", { confirm: false }, raw, source);
  if (WARRANTY_INTENT.test(u)) return runTool("warranty_callback", { issue: u.replace(/[.!?]+$/, "").slice(0, 200) }, raw, source);
  if (/what'?s left|what is left|\bstatus\b|what'?s open|anything left|where are we/i.test(u)) return runTool("job_status", {}, raw, source);
  const m = u.match(/^book\s+(.+?)[.!?]*$/i);
  if (m) {
    const want = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const pro = lastPros.find((x) => x.businessName.toLowerCase().includes(want) || want.includes(x.businessName.toLowerCase().split(" ").slice(0, 2).join(" ")));
    if (pro) return runTool("book_job", { pro_id: pro.proId, confirm: false }, raw, source);
    return localReply("I don't have a licensed pro by that name in the last search. Ask me to find one first.", raw, source);
  }
  if (/\belectrician\b|\b(outlets?|smoke detectors?|wiring|breaker|light switch(es)?)\b/i.test(u)) {
    return runTool("find_pros", { trade: "electrician", job_summary: u.replace(/[.!?]+$/, "").slice(0, 200) }, raw, source);
  }
  return localReply('Try: "I need a licensed electrician to replace outlets", "Book Bright Current", "He sent the invoice", "Pay the proven part", or "What\'s left with the electrician?"', raw, source);
}

function enqueue(text: string, source: Turn["source"]): Promise<void> {
  const run = queue.then(async () => {
    document.body.dataset.busy = "1";
    try { await handle(text, source); }
    catch (err) { subtitles(null, "Sorry, that didn't work."); transcript("error", String(err)); }
    finally { document.body.dataset.busy = "0"; await refreshClock(); }
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------- simulated clock ----------
async function refreshClock(): Promise<void> {
  try {
    const c = await (await fetch(`${CFG.simUrl}/clock`)).json() as { now: number; timeZone: string };
    const label = new Intl.DateTimeFormat("en-US", { timeZone: c.timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(c.now));
    state.sim.nowLocal = label;
    $("clock").textContent = label;
  } catch {
    $("clock").textContent = "sandbox clock offline";
  }
}

async function simulatedTime(to: "demo" | "warranty"): Promise<void> {
  const c = chip(`sandbox clock → ${to === "demo" ? "Thu Oct 15, 2:15 PM" : "Thu Nov 12, 9:00 AM"}`, null);
  const t0 = performance.now();
  hideCheckout();
  try {
    const res = await fetch(`${CFG.simUrl}/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }) });
    const r = await res.json() as { emitted?: { type: string; subType: string | null; status: number | null; delivered: boolean }[]; invoiceVisible?: boolean; photosVisible?: number; error?: { message: string } };
    if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`);
    const steps: Step[] = (r.emitted ?? []).map((e) => ({ service: "Front door camera webhook", op: `${e.type}${e.subType ? `/${e.subType}` : ""} (HMAC signed)`, mode: "simulated", ms: 0, summary: e.delivered ? `delivered · HTTP ${e.status}` : `not delivered · ${e.status ?? "no answer"}` }));
    if (to === "demo") steps.push({ service: "Marketplace", op: "pro posts invoice + photos (partner-side extension, not an Alexa SPI)", mode: "sandbox", ms: 0, summary: `invoice ${r.invoiceVisible ? "posted" : "not yet"} · ${r.photosVisible ?? 0} photos` });
    else steps.push({ service: "Sandbox clock", op: "four weeks later", mode: "simulated", ms: 0, summary: "Thu Nov 12" });
    c.done(steps, Math.round(performance.now() - t0));
    state.sim.advanced = true;
    $("sim-badge").dataset.advanced = "1";
    await refreshClock();
  } catch (err) {
    c.done([], Math.round(performance.now() - t0), String(err));
    transcript("error", `simulated time failed: ${String(err)}`);
  }
}

async function resetDemo(): Promise<void> {
  await fetch(`${CFG.simUrl}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: "demo" }) }).catch(() => {});
  state.userId = `demo-${Date.now().toString(36)}`; // fresh household: the server keeps state per user
  state.pending = null;
  state.sim.advanced = false;
  $("sim-badge").dataset.advanced = "0";
  hideCheckout();
  $("checkout-code").hidden = false;
  await teardownCard();
  $("chips").replaceChildren();
  $("transcript").replaceChildren();
  subtitles("", "");
  if (transport) await transport.terminateSession().catch(() => {});
  if (client) await client.close().catch(() => {});
  await connect();
  await refreshClock();
}

// ---------- Play demo (SPEC §1 + §7.5 beats 1-6, fixed pacing for screen recording) ----------
const BEATS: { beat: number; say?: string; action?: "simTime" | "simWarranty" | "newSession" }[] = [
  { beat: 1, say: "Alexa, I need a licensed electrician to replace outlets and smoke detectors in the master bath." },
  { beat: 2, say: "Book Bright Current." },
  { beat: 2, say: "Yes." },
  { beat: 3, action: "simTime" },
  { beat: 3, say: "He sent the invoice. Pay him." },
  { beat: 4, say: "Pay the proven part." },
  { beat: 4, say: "four seven one nine" },
  { beat: 5, action: "newSession" },
  { beat: 5, say: "What's left with the electrician?" },
  { beat: 5, say: "Yes, draft it." },
  { beat: 6, action: "simWarranty" },
  { beat: 6, action: "newSession" },
  { beat: 6, say: "The master bath outlet stopped working again." },
  { beat: 6, say: "Yes, book it." },
];

async function typeInto(text: string, masked: boolean): Promise<void> {
  const input = $("utterance") as HTMLInputElement;
  input.value = "";
  for (const ch of text) {
    input.value += masked ? "•" : ch;
    if (!FAST) await sleep(28);
  }
  if (!FAST) await sleep(300);
}

async function playDemo(): Promise<void> {
  if (state.demo.running) return;
  state.demo = { running: true, beat: 0, done: false };
  document.body.dataset.demo = "running";
  $("play-demo").setAttribute("disabled", "");
  try {
    await resetDemo();
    if (!FAST) await sleep(800);
    for (const b of BEATS) {
      state.demo.beat = b.beat;
      state.beat = b.beat;
      document.body.dataset.beat = String(b.beat);
      if (b.action === "simTime") { await simulatedTime("demo"); await sleep(FAST ? 50 : 2000); continue; }
      if (b.action === "simWarranty") { await simulatedTime("warranty"); await sleep(FAST ? 50 : 2000); continue; }
      if (b.action === "newSession") { await newSession(); await sleep(FAST ? 50 : 1200); continue; }
      const masked = state.pending?.kind === "checkoutCode" && voiceCodeOf(b.say!) !== null;
      await typeInto(b.say!, masked);
      ($("utterance") as HTMLInputElement).value = "";
      await enqueue(b.say!, "demo");
      const last = state.turns[state.turns.length - 1];
      await sleep(FAST ? 50 : Math.round((last?.seconds ?? 2) * 1000) + 600);
    }
    state.demo.done = true;
    document.body.dataset.demo = "done";
  } catch (err) {
    document.body.dataset.demo = "failed";
    transcript("error", `demo failed: ${String(err)}`);
  } finally {
    state.demo.running = false;
    $("play-demo").removeAttribute("disabled");
  }
}

// ---------- wiring ----------
$("say").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("utterance") as HTMLInputElement;
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  input.type = "text";
  void enqueue(text, "typed");
});
$("utterance").addEventListener("focus", () => {
  // Mask what is typed while the platform expects a voice code.
  ($("utterance") as HTMLInputElement).type = state.pending?.kind === "checkoutCode" ? "password" : "text";
});
$("new-session").addEventListener("click", () => { void (queue = queue.then(() => newSession()).catch((err) => transcript("error", String(err)))); });
$("sim-time").addEventListener("click", () => { void (queue = queue.then(() => simulatedTime("demo"))); });
$("sim-warranty").addEventListener("click", () => { void (queue = queue.then(() => simulatedTime("warranty"))); });
$("reset-demo").addEventListener("click", () => { void (queue = queue.then(() => resetDemo()).catch((err) => transcript("error", String(err)))); });
$("play-demo").addEventListener("click", () => { void playDemo(); });

const SR = (window as unknown as { webkitSpeechRecognition?: new () => { lang: string; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; start: () => void } }).webkitSpeechRecognition;
if (SR) {
  $("mic").removeAttribute("disabled");
  $("mic").addEventListener("click", () => {
    const r = new SR();
    r.lang = "en-US";
    r.onresult = (e) => { const t = e.results[0][0].transcript; if (t) void enqueue(t, "voice"); };
    r.start();
  });
}

connect()
  .then(refreshClock)
  .catch((err) => { $("protocol").textContent = "FAILED"; transcript("error", `connect failed: ${String(err)}`); });
