// proofpay MCP server over Streamable HTTP.
//   POST/GET/DELETE /mcp       MCP. 2025-11-25 (strict, stateful Mcp-Session-Id) and 2026-07-28 (per-request)
//                              on the same endpoint; the era is chosen by the SDK's own isLegacyRequest().
//   POST /webhooks/doorbell    front door camera webhooks (HMAC over the raw body)
//   GET  /healthz
// Account linking is simulated: the host sends "Authorization: Bearer pbp-sandbox-<userId>"; the user id
// keys the per-user state file. A real deployment would use Alexa+ account linking (OAuth 2.1 + PKCE).
//
// Run: node server/server.ts [--port 8787]
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, isLegacyRequest, type McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, hostHeaderValidation, originValidation, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { createServices, type Services } from "../src/app/services.ts";
import { buildMcpServer } from "./tools.ts";
import { dataDir } from "./store.ts";
import { handleDoorbellWebhook, type WebhookStats } from "./webhook.ts";

type AuthInfo = { token: string; clientId: string; scopes: string[]; extra: { userId: string } };
// Inter (SIL OFL 1.1, @fontsource/inter, pinned) served to the cards; declared in each card's _meta.ui.csp.
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@fontsource", "inter", "files");
const FONTS = new Set(["inter-latin-400-normal.woff2", "inter-latin-500-normal.woff2", "inter-latin-600-normal.woff2", "inter-latin-700-normal.woff2"]);
const TOKEN = /^pbp-sandbox-([A-Za-z0-9_.-]{1,64})$/;

function hostOrigins(): Set<string> {
  const port = process.env.HOST_PORT ?? "5178";
  const extra = (process.env.HOST_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra]);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function jsonRpcError(res: ServerResponse, status: number, message: string, code = -32000, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function applyCors(req: IncomingMessage, res: ServerResponse, origins: Set<string>): void {
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  }
}

function authOf(req: IncomingMessage): AuthInfo | null {
  const h = req.headers.authorization;
  const m = h?.match(/^Bearer\s+(\S+)$/i);
  const t = m?.[1].match(TOKEN);
  return t ? { token: m![1], clientId: "alexa-plus-host-simulator", scopes: ["proofpay"], extra: { userId: t[1] } } : null;
}

export type RunningServer = { url: string; port: number; close: () => Promise<void>; sessions: () => number; webhooks: WebhookStats };

export async function startMcpServer(opts: { port: number; quiet?: boolean; services?: Services }): Promise<RunningServer> {
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(new Date().toISOString(), ...a); };
  const services = opts.services ?? createServices();
  const origins = hostOrigins();
  const sessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; server: McpServer; userId: string; seen: number }>();
  // Sessions of closed browser tabs are never DELETEd: drop any session idle for SESSION_IDLE_MS (default 2 h).
  const idleMs = Number(process.env.SESSION_IDLE_MS ?? 2 * 60 * 60_000);
  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.seen < cutoff) { sessions.delete(id); s.transport.close().catch(() => {}); }
  }, 10 * 60_000);
  sweep.unref();
  // DNS-rebinding guards: localhost always; a public deployment adds its own hostnames (PUBLIC_HOSTNAMES=a.example,b.example).
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]", ...(process.env.PUBLIC_HOSTNAMES ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)];
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedHosts);
  const webhooks: WebhookStats = { received: 0, rejected: 0, stored: 0, dropped: 0 };
  // 2026-07-28 leg: the SDK's per-request handler, strict (legacy traffic never reaches it).
  let assetBase = process.env.PUBLIC_BASE ?? ""; // set after listen when not given
  const modern = createMcpHandler((ctx) => buildMcpServer({ era: ctx.era, services, assetBase }), { legacy: "reject", onerror: (e) => log("modern leg error:", e.message) });
  const modernNode = toNodeHandler(modern, { onerror: (e) => log("modern adapter error:", e.message) });

  const http: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocols: ["2025-11-25", "2026-07-28"], sessions: sessions.size, registryMode: services.registryMode, webhooks, dataDir: dataDir() }));
        return;
      }
      if (url.pathname === "/webhooks/doorbell") { await handleDoorbellWebhook(req, res, services, webhooks, log); return; }
      if (url.pathname.startsWith("/assets/fonts/")) {
        const name = url.pathname.slice("/assets/fonts/".length);
        if (!FONTS.has(name) || req.method !== "GET") { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" });
        res.end(readFileSync(join(FONT_DIR, name)));
        return;
      }
      if (url.pathname !== "/mcp") { jsonRpcError(res, 404, "Not found"); return; }
      // DNS-rebinding guards (spec: servers MUST validate Origin). They answer 403 themselves.
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      applyCors(req, res, origins);
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const auth = authOf(req);
      if (!auth) {
        jsonRpcError(res, 401, "Account not linked: send Authorization: Bearer pbp-sandbox-<user> (simulated account linking)", -32001, { "WWW-Authenticate": 'Bearer realm="proofpay-sandbox"' });
        return;
      }
      (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const probe = await toWebRequest(req, body);
      if (!(await isLegacyRequest(probe, body))) {
        await modernNode(req, res, body); // 2026-07-28
        return;
      }

      // ---- 2025-11-25 leg: stateful sessions ----
      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (req.method === "POST") {
        if (sessionId) {
          const s = sessions.get(sessionId);
          if (!s) { jsonRpcError(res, 404, "Session not found", -32001); return; }
          if (s.userId !== auth.extra.userId) { jsonRpcError(res, 403, "Session belongs to another account", -32001); return; }
          s.seen = Date.now();
          await s.transport.handleRequest(req, res, body);
          return;
        }
        const server = buildMcpServer({ era: "legacy", services, assetBase });
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, userId: auth.extra.userId, seen: Date.now() });
            log(`session open  ${id} user=${auth.extra.userId} (requested ${(body as { params?: { protocolVersion?: string } })?.params?.protocolVersion})`);
          },
          onsessionclosed: (id) => { sessions.delete(id); log(`session close ${id} (DELETE)`); },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          server.close().catch(() => {});
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        if (!transport.sessionId) { await transport.close().catch(() => {}); } // not an initialize: nothing to keep
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId) { jsonRpcError(res, 400, "Bad Request: Mcp-Session-Id header required"); return; }
        const s = sessions.get(sessionId);
        if (!s) { jsonRpcError(res, 404, "Session not found", -32001); return; }
        if (s.userId !== auth.extra.userId) { jsonRpcError(res, 403, "Session belongs to another account", -32001); return; }
        await s.transport.handleRequest(req, res);
        return;
      }
      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      jsonRpcError(res, 405, "Method not allowed");
    } catch (err) {
      console.error("request error:", err);
      const parse = err instanceof SyntaxError;
      if (!res.headersSent) jsonRpcError(res, parse ? 400 : 500, parse ? "Parse error" : "Internal error", parse ? -32700 : -32603);
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  if (!assetBase) assetBase = `http://127.0.0.1:${port}`;
  log(`proofpay MCP on http://127.0.0.1:${port}/mcp (2025-11-25 strict sessions + 2026-07-28; registry=${services.registryMode}; data=${dataDir()})`);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    webhooks,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      await modern.close().catch(() => {});
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.MCP_PORT ?? 8787);
  const running = await startMcpServer({ port });
  const shutdown = () => { running.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
