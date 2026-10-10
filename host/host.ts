// Alexa+-like web host simulator (browser). Official MCP client over Streamable HTTP,
// deterministic intent matching (no LLM), MCP Apps rendering through AppBridge + sandbox proxy.
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport, getToolUiResourceUri, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";

const MCP_URL = new URL("http://127.0.0.1:8787/mcp");
const SANDBOX_URL = "http://127.0.0.1:5179/sandbox.html"; // different origin from the host, per MCP Apps spec
const HOST_INFO = { name: "alexa-plus-host-simulator", version: "0.0.1" };
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const params = new URLSearchParams(location.search);
const userId = params.get("user") ?? "demo-user";

// Exposed for the automated browser check.
const state = {
  userId,
  protocolVersion: "" as string,
  sessionId: "" as string,
  tools: [] as string[],
  sessionsOpened: 0,
  card: { renders: 0, initialized: 0, resultsSent: 0 },
  errors: [] as string[],
};
(window as unknown as { __spike: typeof state }).__spike = state;

let client: Client | undefined;
let transport: StreamableHTTPClientTransport | undefined;
let tools = new Map<string, Tool>();
let bridge: AppBridge | undefined;

function say(role: "user" | "assistant" | "error", text: string): void {
  const p = document.createElement("p");
  p.className = role;
  p.dataset.role = role;
  p.textContent = `${role === "user" ? "You" : role === "assistant" ? "Assistant" : "Error"}: ${text}`;
  $("transcript").append(p);
  if (role === "error") state.errors.push(text);
}

function textOf(result: CallToolResult): string {
  return result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}

async function connect(): Promise<void> {
  client = new Client(HOST_INFO, {
    // Advertise MCP Apps support (SEP-1724 extensions capability).
    capabilities: { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } },
  });
  transport = new StreamableHTTPClientTransport(MCP_URL);
  await client.connect(transport);
  state.protocolVersion = client.getNegotiatedProtocolVersion() ?? "(unknown)";
  state.sessionId = transport.sessionId ?? "(none)";
  state.sessionsOpened += 1;
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  state.tools = [...tools.keys()];
  $("protocol").textContent = state.protocolVersion;
  $("session").textContent = state.sessionId;
  $("tools").textContent = state.tools.join(", ");
  document.body.dataset.connected = String(state.sessionsOpened);
}

async function newSession(): Promise<void> {
  await teardownCard();
  if (transport) await transport.terminateSession(); // HTTP DELETE, server drops the session
  if (client) await client.close();
  $("session").textContent = "-";
  await connect();
  say("assistant", `New MCP session ${state.sessionId}. Memory lives on the server, keyed by user.`);
}

async function teardownCard(): Promise<void> {
  if (bridge) {
    // Spec: host MUST send ui/resource-teardown before removing the view.
    await Promise.race([bridge.teardownResource({}), new Promise((r) => setTimeout(r, 1000))]).catch(() => {});
    await bridge.close().catch(() => {});
    bridge = undefined;
  }
  $("card").replaceChildren();
}

async function renderCard(toolName: string, args: Record<string, unknown>): Promise<void> {
  if (!client) throw new Error("not connected");
  const tool = tools.get(toolName);
  const uri = tool ? getToolUiResourceUri(tool) : undefined;
  if (!uri) throw new Error(`${toolName} declares no UI resource`);

  const resultPromise = client.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>;
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (!content || content.mimeType !== RESOURCE_MIME_TYPE || !("text" in content)) {
    throw new Error(`unexpected UI resource: ${content?.mimeType}`);
  }

  await teardownCard();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin"); // required by spec for the proxy
  iframe.title = "MCP App card";
  const proxyReady = new Promise<void>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.data?.method === "ui/notifications/sandbox-proxy-ready") {
        window.removeEventListener("message", onMsg);
        resolve();
      }
    };
    window.addEventListener("message", onMsg);
  });
  iframe.src = SANDBOX_URL;
  $("card").append(iframe);
  await proxyReady;

  const caps = client.getServerCapabilities();
  const b = new AppBridge(client, HOST_INFO, { serverTools: caps?.tools, serverResources: caps?.resources }, {
    hostContext: { theme: "light", platform: "web", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { maxHeight: 600 } },
  });
  bridge = b;
  b.onsizechange = ({ height }) => { if (height) iframe.style.height = `${Math.min(height, 600)}px`; };
  b.onloggingmessage = (p) => console.log("[view log]", p);
  const initialized = new Promise<void>((resolve) => { b.oninitialized = () => { state.card.initialized += 1; resolve(); }; });

  await b.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await b.sendSandboxResourceReady({ html: content.text });
  await initialized; // spec: nothing may be sent to the view before it is initialized
  await b.sendToolInput({ arguments: args });
  const result = await resultPromise;
  await b.sendToolResult(result);
  state.card.resultsSent += 1;
  state.card.renders += 1;
  iframe.dataset.rendered = String(state.card.renders);
  say("assistant", textOf(result));
}

// Deterministic "intent" matching. The real product would have an LLM (Alexa+) here.
async function handle(utterance: string): Promise<void> {
  if (!client) throw new Error("not connected");
  const u = utterance.trim();
  let m: RegExpMatchArray | null;
  if ((m = u.match(/^(?:remember|note|save)\s+(?:that\s+)?(.+)$/i))) {
    const r = (await client.callTool({ name: "remember", arguments: { user_id: userId, text: m[1] } })) as CallToolResult;
    say(r.isError ? "error" : "assistant", textOf(r));
  } else if (/\b(show|open)\b.*\bcard\b/i.test(u)) {
    await renderCard("show_card", { user_id: userId });
  } else if (/\b(recall|what do i have|my notes|what did i)\b/i.test(u)) {
    const r = (await client.callTool({ name: "recall", arguments: { user_id: userId } })) as CallToolResult;
    say(r.isError ? "error" : "assistant", textOf(r));
  } else {
    say("assistant", 'I can "remember <something>", "recall", or "show my card".');
  }
}

$("user").textContent = userId;
$("say").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("utterance") as HTMLInputElement;
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  say("user", text);
  handle(text).catch((err) => say("error", String(err)));
});
$("new-session").addEventListener("click", () => { newSession().catch((err) => say("error", String(err))); });
connect().catch((err) => { $("protocol").textContent = "FAILED"; say("error", `connect failed: ${String(err)}`); });
