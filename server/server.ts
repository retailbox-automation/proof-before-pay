// Spike MCP server: Streamable HTTP, stateful sessions (Mcp-Session-Id), protocol 2025-11-25.
// Tools: remember / recall (JSON file store, keyed by user_id so state outlives any MCP session)
// and show_card (linked to an MCP Apps UI resource ui://notes/card.html).
//
// Run: node server/server.ts [--port 8787] [--strict]
//   --strict  only accept protocol 2025-11-25 (SDK default also accepts older revisions)

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = process.env.SPIKE_DATA_FILE ?? join(ROOT, "data", "notes.json");
const CARD_HTML = join(ROOT, "dist", "card.html");
export const CARD_URI = "ui://notes/card.html";
// Browser origins allowed to call us cross-origin (the Alexa+-like web host).
const CORS_ORIGINS = new Set(["http://127.0.0.1:5178", "http://localhost:5178"]);

// ---------- tiny JSON store (sync, single process, atomic rename) ----------
type Note = { text: string; at: string };
type Db = { users: Record<string, Note[]> };

function loadDb(): Db {
  if (!existsSync(DATA_FILE)) return { users: {} };
  const parsed = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Db;
  if (!parsed || typeof parsed !== "object" || typeof parsed.users !== "object") {
    throw new Error(`Corrupt store at ${DATA_FILE}`);
  }
  return parsed;
}

function saveDb(db: Db): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DATA_FILE);
}

const userId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . - only");

// ---------- MCP server (one instance per session) ----------
function buildMcpServer(strict: boolean): McpServer {
  const server = new McpServer(
    { name: "alexa-plus-notes-spike", version: "0.0.1" },
    strict ? { supportedProtocolVersions: [LATEST_PROTOCOL_VERSION] } : undefined,
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a note",
      description: "Save a short note for a user. Notes persist across sessions.",
      inputSchema: z.object({ user_id: userId, text: z.string().trim().min(1).max(500) }),
    },
    async ({ user_id, text }) => {
      const db = loadDb();
      const notes = (db.users[user_id] ??= []);
      notes.push({ text, at: new Date().toISOString() });
      saveDb(db);
      return {
        content: [{ type: "text", text: `Saved. ${user_id} now has ${notes.length} note(s).` }],
        structuredContent: { user_id, count: notes.length },
      };
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall notes",
      description: "Return every note saved for a user, oldest first.",
      inputSchema: z.object({ user_id: userId }),
    },
    async ({ user_id }) => {
      const notes = (loadDb().users[user_id] ?? []).map((n) => n.text);
      return {
        content: [{ type: "text", text: notes.length ? notes.map((t, i) => `${i + 1}. ${t}`).join("\n") : "No notes yet." }],
        structuredContent: { user_id, notes },
      };
    },
  );

  registerAppTool(
    server,
    "show_card",
    {
      title: "Show notes card",
      description: "Show the user's notes as a visual card.",
      inputSchema: z.object({ user_id: userId }),
      _meta: { ui: { resourceUri: CARD_URI } },
    },
    async ({ user_id }) => {
      const notes = (loadDb().users[user_id] ?? []).map((n) => n.text);
      return {
        // Text content is mandatory even when a UI exists (MCP Apps spec).
        content: [{ type: "text", text: `Showing ${notes.length} note(s) for ${user_id}.` }],
        structuredContent: { user_id, notes },
      };
    },
  );

  registerAppResource(
    server,
    "notes-card",
    CARD_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Notes card (MCP App view)" },
    async () => {
      if (!existsSync(CARD_HTML)) throw new Error(`${CARD_HTML} missing - run "npm run build" first`);
      return { contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(CARD_HTML, "utf8") }] };
    },
  );

  return server;
}

// ---------- HTTP layer ----------
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

function jsonRpcError(res: ServerResponse, status: number, message: string, code = -32000): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  }
}

export type RunningServer = { url: string; port: number; close: () => Promise<void>; sessions: () => number };

export async function startMcpServer(opts: { port: number; strict?: boolean; quiet?: boolean }): Promise<RunningServer> {
  const strict = !!opts.strict;
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(new Date().toISOString(), ...a); };
  const sessions = new Map<string, { transport: NodeStreamableHTTPServerTransport; server: McpServer }>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const http: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, strict, sessions: sessions.size }));
        return;
      }
      if (url.pathname !== "/mcp") { jsonRpcError(res, 404, "Not found"); return; }
      // DNS-rebinding guards (spec: servers MUST validate Origin). They answer 403 themselves.
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      applyCors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (sessionId) {
          const s = sessions.get(sessionId);
          if (!s) { jsonRpcError(res, 404, "Session not found", -32001); return; }
          await s.transport.handleRequest(req, res, body);
          return;
        }
        if (!isInitializeRequest(body)) {
          jsonRpcError(res, 400, "Bad Request: no Mcp-Session-Id and not an initialize request");
          return;
        }
        const server = buildMcpServer(strict);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
            log(`session open  ${id} (requested protocolVersion=${(body as { params: { protocolVersion: string } }).params.protocolVersion})`);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            log(`session close ${id} (DELETE)`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          server.close().catch(() => {});
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const s = sessionId ? sessions.get(sessionId) : undefined;
        if (!sessionId) { jsonRpcError(res, 400, "Bad Request: Mcp-Session-Id header required"); return; }
        if (!s) { jsonRpcError(res, 404, "Session not found", -32001); return; }
        await s.transport.handleRequest(req, res);
        return;
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      jsonRpcError(res, 405, "Method not allowed");
    } catch (err) {
      console.error("request error:", err);
      if (!res.headersSent) jsonRpcError(res, err instanceof SyntaxError ? 400 : 500, err instanceof SyntaxError ? "Parse error" : "Internal error", err instanceof SyntaxError ? -32700 : -32603);
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`MCP server on http://127.0.0.1:${port}/mcp (strict=${strict}, store=${DATA_FILE})`);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    sessions: () => sessions.size,
    close: async () => {
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
  const running = await startMcpServer({ port, strict: args.includes("--strict") });
  const shutdown = () => { running.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
