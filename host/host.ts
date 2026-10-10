// Smart display host simulator (browser): the Alexa+ experience simulated in our web host.
// - Official MCP client over Streamable HTTP (protocol 2025-11-25, Mcp-Session-Id), simulated account
//   linking via "Authorization: Bearer pbp-sandbox-<user>".
// - Deterministic utterance -> tool mapping (no LLM). In the real product Alexa+ supplies language understanding.
// - MCP Apps cards rendered through AppBridge + a sandbox proxy on a second origin.
// - One chip per tools/call, one sub-chip per _meta.steps entry with a LIVE/FIXTURE/SANDBOX/SIMULATED badge.
// - Subtitles show Alexa's line and its length in seconds (2.5 words/s).
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport, getToolUiResourceUri, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";

type Cfg = { mcpUrl: string; sandboxProxyUrl: string; simUrl: string };
type Mode = "live" | "fixture" | "sandbox" | "simulated";
type Step = { service: string; op: string; mode: Mode; ms: number; summary: string };
type Turn = {
  n: number; source: "typed" | "voice" | "tap" | "demo"; utterance: string; tool: string | null; args: Record<string, unknown> | null;
  speech: string; seconds: number; steps: Step[]; isError: boolean; view: string | null; ms: number;
};
type Pending = { kind: "pickPro"; proId: string } | { kind: "book"; proId: string } | { kind: "cancel" } | { kind: "voiceCode" } | { kind: "draft" } | null;

const CFG = (window as unknown as { __PBP: Cfg }).__PBP;
const HOST_INFO = { name: "alexa-plus-host-simulator", version: "0.1.0" };
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
  demo: { running: false, beat: 0, done: false },
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
const mask = (s: string) => s.replace(/./g, "•").slice(0, 4).padEnd(4, "•");

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
  transcript("assistant", `(new MCP session ${state.sessionId.slice(0, 8)}…; your jobs are saved on your account)`);
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
  iframe.src = CFG.sandboxProxyUrl;
  $("card").append(iframe);
  await proxyReady;

  const caps = c.getServerCapabilities();
  const b = new AppBridge(c, HOST_INFO, { serverTools: caps?.tools, serverResources: caps?.resources, message: { text: {} } }, {
    hostContext: {
      theme: "dark", platform: "web", displayMode: "inline", availableDisplayModes: ["inline"],
      deviceClass: "echo-show-8", locale: "en-US", timeZone: "America/New_York",
      containerDimensions: { maxWidth: 860, maxHeight: 600 }, deviceCapabilities: { touch: true, hover: false },
    },
  });
  bridge = b;
  b.onsizechange = ({ height }) => { if (height) iframe.style.height = `${Math.min(height, 600)}px`; };
  b.onloggingmessage = (p) => console.log("[view log]", p);
  b.onmessage = async ({ content: blocks }) => {
    // A tap on a card CTA arrives as ui/message: treat it as the user's next turn.
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
  if (tool === "pay_proven" && (data.needsVoiceCode || (data.paid === false && Number(data.attemptsLeft) > 0))) return { kind: "voiceCode" };
  if (tool === "job_status" && Array.isArray(data.open) && data.open.length) return { kind: "draft" };
  return null;
}

async function runTool(tool: string, args: Record<string, unknown>, utterance: string, source: Turn["source"], masked: boolean): Promise<void> {
  if (!client) throw new Error("not connected");
  const shownArgs = masked ? { ...args, voice_code: "••••" } : args;
  const c = chip(`tools/call proofpay.${tool}`, JSON.stringify(shownArgs));
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
  const sc = (result.structuredContent ?? {}) as { speech?: string; seconds?: number; view?: string; data?: Record<string, unknown> };
  const steps = ((result._meta as { steps?: Step[] } | undefined)?.steps ?? []) as Step[];
  const ms = Math.round(performance.now() - t0);
  c.done(steps, ms);
  const speech = sc.speech ?? result.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join(" ");
  subtitles(null, speech);
  transcript(result.isError ? "error" : "assistant", speech);
  state.pending = nextPending(tool, sc.data ?? {}, args);
  state.turns.push({ n: state.turns.length + 1, source, utterance: masked ? "••••" : utterance, tool, args: shownArgs, speech, seconds: seconds(speech), steps, isError: !!result.isError, view: sc.view ?? null, ms });
  document.body.dataset.turns = String(state.turns.length);
}

function localReply(text: string, utterance: string, source: Turn["source"]): void {
  subtitles(null, text);
  transcript("assistant", text);
  state.turns.push({ n: state.turns.length + 1, source, utterance, tool: null, args: null, speech: text, seconds: seconds(text), steps: [], isError: false, view: null, ms: 0 });
  document.body.dataset.turns = String(state.turns.length);
}

const DIGIT: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function voiceCodeOf(u: string): string | null {
  const words = u.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const digits = words.map((w) => (/^\d+$/.test(w) ? w : DIGIT[w] ?? "")).join("");
  return /^\d{4}$/.test(digits) && words.every((w) => /^\d+$/.test(w) || w in DIGIT) ? digits : null;
}
const YES = /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|confirm|please do)\b/i;
const NO = /^(no|nope|don't|do not|never mind|stop)\b/i;

/** Deterministic intent matching. The real product has Alexa+ language understanding here. */
async function handle(raw: string, source: Turn["source"]): Promise<void> {
  const u = raw.trim().replace(/^alexa[,!.]?\s*/i, "");
  const p = state.pending;
  const isCode = p?.kind === "voiceCode" && voiceCodeOf(u) !== null;
  subtitles(isCode ? "••••" : raw.trim(), "");
  transcript("user", isCode ? "••••" : raw.trim());
  if (isCode) return runTool("pay_proven", { voice_code: voiceCodeOf(u)! }, raw, source, true);
  if (p && YES.test(u)) {
    if (p.kind === "pickPro") return runTool("book_job", { pro_id: p.proId, confirm: false }, raw, source, false);
    if (p.kind === "book") return runTool("book_job", { pro_id: p.proId, confirm: true }, raw, source, false);
    if (p.kind === "cancel") return runTool("cancel_booking", { confirm: true }, raw, source, false);
    if (p.kind === "draft") return runTool("draft_note", {}, raw, source, false);
  }
  if (p && NO.test(u)) { state.pending = null; return localReply("OK, I won't.", raw, source); }
  if (/\bdraft\b/i.test(u)) return runTool("draft_note", {}, raw, source, false);
  if (/\bpay\b.*\bproven\b|\bpay (?:the )?\$?\d/i.test(u)) return runTool("pay_proven", {}, raw, source, false);
  if (/\binvoice\b|\bpay (?:him|her|them)\b/i.test(u)) return runTool("review_invoice", {}, raw, source, false);
  if (/\bcancel\b/i.test(u) && /\b(booking|appointment|job|electrician|visit)\b/i.test(u)) return runTool("cancel_booking", { confirm: false }, raw, source, false);
  if (/what'?s left|what is left|\bstatus\b|what'?s open|anything left|where are we/i.test(u)) return runTool("job_status", {}, raw, source, false);
  const m = u.match(/^book\s+(.+?)[.!?]*$/i);
  if (m) {
    const want = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const pro = lastPros.find((x) => x.businessName.toLowerCase().includes(want) || want.includes(x.businessName.toLowerCase().split(" ").slice(0, 2).join(" ")));
    if (pro) return runTool("book_job", { pro_id: pro.proId, confirm: false }, raw, source, false);
    return localReply("I don't have a licensed pro by that name in the last search. Ask me to find one first.", raw, source);
  }
  if (/\belectrician\b|\b(outlets?|smoke detectors?|wiring|breaker|light switch(es)?)\b/i.test(u)) {
    return runTool("find_pros", { trade: "electrician", job_summary: u.replace(/[.!?]+$/, "").slice(0, 200) }, raw, source, false);
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
    const label = new Intl.DateTimeFormat("en-US", { timeZone: c.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(c.now));
    state.sim.nowLocal = label;
    $("clock").textContent = label;
  } catch {
    $("clock").textContent = "sandbox clock offline";
  }
}

async function simulatedTime(): Promise<void> {
  const c = chip("sandbox clock → Thu 2:15 PM", null);
  const t0 = performance.now();
  try {
    const res = await fetch(`${CFG.simUrl}/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "demo" }) });
    const r = await res.json() as { emitted?: { type: string; subType: string | null; status: number | null; delivered: boolean }[]; invoiceVisible?: boolean; photosVisible?: number; error?: { message: string } };
    if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`);
    const steps: Step[] = (r.emitted ?? []).map((e) => ({ service: "Front door camera webhook", op: `${e.type}${e.subType ? `/${e.subType}` : ""} (HMAC signed)`, mode: "simulated", ms: 0, summary: e.delivered ? `delivered · HTTP ${e.status}` : `not delivered · ${e.status ?? "no answer"}` }));
    steps.push({ service: "Marketplace", op: "pro posts invoice + photos", mode: "sandbox", ms: 0, summary: `invoice ${r.invoiceVisible ? "posted" : "not yet"} · ${r.photosVisible ?? 0} photos` });
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
  await teardownCard();
  $("chips").replaceChildren();
  $("transcript").replaceChildren();
  subtitles("", "");
  if (transport) await transport.terminateSession().catch(() => {});
  if (client) await client.close().catch(() => {});
  await connect();
  await refreshClock();
}

// ---------- Play demo (SPEC §1 beats 1-5, fixed pacing for screen recording) ----------
const BEATS: { beat: number; say?: string; action?: "simTime" | "newSession" }[] = [
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
];

async function typeInto(text: string, masked: boolean): Promise<void> {
  const input = $("utterance") as HTMLInputElement;
  input.value = "";
  for (const ch of text) {
    input.value += masked ? "•" : ch;
    if (!FAST) await sleep(32);
  }
  if (!FAST) await sleep(350);
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
      document.body.dataset.beat = String(b.beat);
      if (b.action === "simTime") { await simulatedTime(); await sleep(FAST ? 50 : 2500); continue; }
      if (b.action === "newSession") { await newSession(); await sleep(FAST ? 50 : 1500); continue; }
      const masked = state.pending?.kind === "voiceCode" && voiceCodeOf(b.say!) !== null;
      await typeInto(b.say!, masked);
      ($("utterance") as HTMLInputElement).value = "";
      await enqueue(b.say!, "demo");
      const last = state.turns[state.turns.length - 1];
      await sleep(FAST ? 50 : Math.round((last?.seconds ?? 2) * 1000) + 1200);
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
  // Mask what is typed while a voice code is expected.
  ($("utterance") as HTMLInputElement).type = state.pending?.kind === "voiceCode" ? "password" : "text";
});
$("new-session").addEventListener("click", () => { void (queue = queue.then(() => newSession()).catch((err) => transcript("error", String(err)))); });
$("sim-time").addEventListener("click", () => { void (queue = queue.then(() => simulatedTime())); });
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
