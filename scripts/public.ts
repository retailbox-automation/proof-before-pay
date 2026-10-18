// npm run public — the whole demo behind ONE public port, for a hosted judge-facing deployment.
// Same servers as `npm run demo` (sandbox, proofpay MCP, host simulator, card proxy) plus the Alexa skill endpoint,
// each on 127.0.0.1, and a small gateway on 0.0.0.0:PORT that routes by path (and by hostname for the card proxy):
//
//   https://<PUBLIC_ORIGIN>/                  host simulator (Echo Show 8 frame, "Play demo")
//   https://<PUBLIC_ORIGIN>/mcp               proofpay MCP endpoint (Streamable HTTP, 2025-11-25 + 2026-07-28)
//   https://<PUBLIC_ORIGIN>/assets/fonts/*    Inter for the cards
//   https://<PUBLIC_ORIGIN>/sandbox/t/<id>/*  the visitor's own sandbox tenant (clock, simulated checkout); echo-* refused
//   (the Echo Show demo account is controlled from inside the container: scripts/sandbox-admin.ts)
//   https://<PUBLIC_ORIGIN>/alexa             Alexa skill endpoint (Amazon request signature + timestamp verified)
//   https://<PUBLIC_ORIGIN>/healthz           health of every part
//   https://<CARDS_ORIGIN>/sandbox.html       card proxy: MUST be a different origin than the host page (MCP Apps)
//
// Every page load gets its own simulated account and its own sandbox tenant, so any number of visitors (and tabs)
// can press "Play demo" at the same time without touching each other's state. No per-IP limits: judges share NATs.
//
// Env: PORT (8080), PUBLIC_ORIGIN (required, https://host), CARDS_ORIGIN (required, another https origin),
//      REGISTRY_MODE (auto), REGISTRY_LIVE_NUMBERS (EC99000103), REGISTRY_TIMEOUT_MS (4000), ALEXA_SKILL_ID (optional).
// Nothing here is a secret: the camera webhook HMAC key is generated at start (sandbox camera -> our webhook, in-process).
import { randomBytes } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const origin = (name: string): URL => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required (e.g. https://demo.example.com)`);
  const u = new URL(v);
  if (u.pathname !== "/" || u.search) throw new Error(`${name} must be an origin, got ${v}`);
  return u;
};
const PUBLIC = origin("PUBLIC_ORIGIN");
const CARDS = origin("CARDS_ORIGIN");
if (PUBLIC.host === CARDS.host) throw new Error("CARDS_ORIGIN must differ from PUBLIC_ORIGIN (cards run cross-origin)");
const pub = PUBLIC.origin;
const port = Number(env.PORT ?? 8080);
const internal = { mcp: 18787, host: 15178, proxy: 15179, sandbox: 18791, skill: 18795 };

if (!existsSync(join(ROOT, "dist", "host.js"))) throw new Error("dist/ missing: run `node build.ts` first");

// Configuration the servers read from env at start.
env.REGISTRY_MODE ??= "auto";
env.REGISTRY_LIVE_NUMBERS ??= "EC99000103"; // the fictional unlicensed pro: the live registry truthfully answers "no records"
env.REGISTRY_TIMEOUT_MS ??= "4000";
env.SANDBOX_PER_USER = "1";
env.SANDBOX_BASE = `http://127.0.0.1:${internal.sandbox}`;
env.PUBLIC_HOSTNAMES = PUBLIC.hostname;
env.PUBLIC_BASE = pub; // cards load Inter from here
env.HOST_PORT = String(internal.host);
const signingKey = randomBytes(24).toString("hex");
env.RING_SIGNING_KEY = signingKey;

const { startSandbox } = await import("../src/sandbox/server.ts");
const { startMcpServer } = await import("../server/server.ts");
const { startHost } = await import("../host/serve.ts");
const { startSkillServer } = await import("../skill/src/server.ts");
const { createProofpay } = await import("../skill/src/proofpay.ts");

const sandbox = await startSandbox({ port: internal.sandbox, webhookUrl: `http://127.0.0.1:${internal.mcp}/webhooks/doorbell`, signingKey, corsOrigins: [pub] });
const mcp = await startMcpServer({ port: internal.mcp });
const host = await startHost({
  hostPort: internal.host, proxyPort: internal.proxy,
  mcpUrl: `${pub}/mcp`, simUrl: `${pub}/sandbox/t/default/sim`, checkoutBase: `${pub}/sandbox/t/default`,
  sandboxBase: `${pub}/sandbox`, publicOrigins: [pub], proxyUrl: `${CARDS.origin}/sandbox.html`,
});
const skill = await startSkillServer({
  port: internal.skill,
  proofpay: createProofpay({ url: `http://127.0.0.1:${internal.mcp}/mcp`, token: env.PBP_TOKEN ?? "pbp-sandbox-echo-demo", timeoutMs: Number(env.MCP_TIMEOUT_MS ?? 6000) }),
  skillId: env.ALEXA_SKILL_ID || undefined,
  skipSignatureCheck: false, // never off on a public endpoint
});

function forward(req: IncomingMessage, res: ServerResponse, to: number, path: string): void {
  const up = request({ host: "127.0.0.1", port: to, method: req.method, path, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }); res.end("upstream unavailable"); });
  res.on("close", () => { if (!res.writableFinished) up.destroy(); }); // client went away (e.g. an SSE stream)
  req.pipe(up);
}

function refuse(res: ServerResponse, why: string): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code: "forbidden", message: why } }));
}

async function health(): Promise<Record<string, unknown>> {
  const probe = async (url: string) => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : { ok: false, status: r.status }; } catch (e) { return { ok: false, error: String(e) }; }
  };
  const [m, s, h, k] = await Promise.all([
    probe(`http://127.0.0.1:${internal.mcp}/healthz`), probe(`http://127.0.0.1:${internal.sandbox}/healthz`),
    probe(`http://127.0.0.1:${internal.host}/healthz`), probe(`http://127.0.0.1:${internal.skill}/healthz`),
  ]) as Record<string, unknown>[];
  const ok = [m, s, h, k].every((x) => x.ok === true);
  return { ok, mcp: { ok: m.ok, protocols: m.protocols, sessions: m.sessions, registryMode: m.registryMode }, sandbox: { ok: s.ok, tenants: s.tenants }, host: { ok: h.ok }, alexaSkill: { ok: k.ok, signatureCheck: k.signatureCheck } };
}

const gateway = createServer(async (req, res) => {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (hostname === CARDS.hostname) {
    if (p === "/sandbox.html" || p === "/sandbox.js") return forward(req, res, internal.proxy, req.url ?? "/");
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("card sandbox origin: nothing else is served here"); return;
  }
  if (p === "/healthz") {
    const h = await health();
    res.writeHead(h.ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(h)); return;
  }
  // Accounts named echo-* belong to the real Echo Show (the Alexa skill reaches the MCP server on 127.0.0.1): nobody on
  // the public side may use them, so a visitor cannot move the device demo's clock or state.
  if (p === "/mcp" && /^Bearer\s+pbp-sandbox-echo-/i.test(req.headers.authorization ?? "")) return refuse(res, "the echo-* accounts belong to the Echo Show demo");
  if (p.startsWith("/sandbox/t/echo-")) return refuse(res, "the echo-* sandbox belongs to the Echo Show demo");
  if (p === "/mcp" || p.startsWith("/assets/fonts/")) return forward(req, res, internal.mcp, req.url ?? "/");
  if (p === "/alexa") return forward(req, res, internal.skill, "/alexa");
  if (p.startsWith("/sandbox/t/")) return forward(req, res, internal.sandbox, (req.url ?? "/").slice("/sandbox".length));
  if (p.startsWith("/sandbox") || p.startsWith("/webhooks/")) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
  return forward(req, res, internal.host, req.url ?? "/");
});
gateway.keepAliveTimeout = 65_000;
await new Promise<void>((resolve, reject) => { gateway.once("error", reject); gateway.listen(port, "0.0.0.0", () => resolve()); });
console.log(`Proof Before Pay public gateway on :${port} -> ${pub} (cards ${CARDS.origin}); registry ${env.REGISTRY_MODE} live=${env.REGISTRY_LIVE_NUMBERS}`);

const shutdown = async () => {
  gateway.closeAllConnections();
  await Promise.allSettled([skill.close(), host.close(), mcp.close(), sandbox.close()]);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
