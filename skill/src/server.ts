// Own HTTPS endpoint for the Alexa skill (no Lambda, no AWS account, no Express).
//   POST /alexa     Alexa request envelope -> skill response (signature + timestamp verified first)
//   GET  /healthz
//
// TLS: set SKILL_TLS_KEY and SKILL_TLS_CERT (PEM paths) to serve HTTPS directly; otherwise it serves plain
// HTTP on 127.0.0.1 for a tunnel that terminates TLS (cloudflared / ngrok give a public https URL with a
// trusted certificate, which is what the Alexa console asks for).
//
// SKIP_SIGNATURE_CHECK=1 turns verification off for local tests only. Never set it while a tunnel is up.
//
// Env: SKILL_PORT (8795), SKILL_HOST (127.0.0.1), MCP_URL (http://127.0.0.1:8787/mcp), PBP_TOKEN
// (pbp-sandbox-<user>), ALEXA_SKILL_ID (amzn1.ask.skill...; requests for other skills are rejected),
// MCP_TIMEOUT_MS (6000).
import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import type { RequestEnvelope } from "ask-sdk-model";
import { buildSkill } from "./handler.ts";
import { createProofpay, type Proofpay } from "./proofpay.ts";
import { createAlexaVerifier, type AlexaVerifier } from "./verify.ts";

const MAX_BODY = 256 * 1024;

export type SkillServerOptions = {
  port: number;
  host?: string;
  proofpay: Proofpay;
  skillId?: string;
  verifier?: AlexaVerifier; // default: Amazon's documented algorithm (createAlexaVerifier())
  skipSignatureCheck?: boolean;
  tls?: { key: string; cert: string };
  quiet?: boolean;
};

export type RunningSkillServer = { url: string; port: number; close: () => Promise<void> };

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json;charset=UTF-8" });
  res.end(JSON.stringify(body));
}

export async function startSkillServer(opts: SkillServerOptions): Promise<RunningSkillServer> {
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(new Date().toISOString(), "[skill-endpoint]", ...a); };
  const skill = buildSkill({ proofpay: opts.proofpay, skillId: opts.skillId, log: opts.quiet ? () => {} : undefined });
  const verify = opts.verifier ?? createAlexaVerifier();
  if (opts.skipSignatureCheck) log("WARNING: SKIP_SIGNATURE_CHECK=1 - Alexa signatures are NOT verified (local tests only)");

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") { send(res, 200, { ok: true, signatureCheck: !opts.skipSignatureCheck }); return; }
      if (url.pathname !== "/alexa" && url.pathname !== "/") { send(res, 404, { error: "not found" }); return; }
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); send(res, 405, { error: "method not allowed" }); return; }
      const raw = await readRaw(req);
      if (!opts.skipSignatureCheck) {
        try {
          await verify(raw, req.headers);
        } catch (e) {
          log("rejected request:", String((e as Error).message ?? e));
          send(res, 400, { error: "request verification failed" });
          return;
        }
      }
      let envelope: RequestEnvelope;
      try { envelope = JSON.parse(raw.toString("utf8")); } catch { send(res, 400, { error: "bad json" }); return; }
      const out = await skill.invoke(envelope);
      send(res, 200, out);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      log("error:", String((e as Error).message ?? e));
      // Unknown skill id ends up here too (ask-sdk throws); answer without detail.
      if (!res.headersSent) send(res, status === 413 ? 413 : 400, { error: status === 413 ? "too large" : "bad request" });
    }
  };

  const server: Server = opts.tls ? createHttps({ key: opts.tls.key, cert: opts.tls.cert }, handler) : createHttp(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `${opts.tls ? "https" : "http"}://${opts.host ?? "127.0.0.1"}:${port}/alexa`;
  log(`skill endpoint on ${url} (signature check ${opts.skipSignatureCheck ? "OFF" : "on"})`);
  return {
    url,
    port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await opts.proofpay.close();
    },
  };
}

if (import.meta.main) {
  const e = process.env;
  const token = e.PBP_TOKEN ?? "pbp-sandbox-echo-demo";
  if (!/^pbp-sandbox-[A-Za-z0-9_.-]{1,64}$/.test(token)) throw new Error("PBP_TOKEN must look like pbp-sandbox-<user>");
  const proofpay = createProofpay({ url: e.MCP_URL ?? "http://127.0.0.1:8787/mcp", token, timeoutMs: Number(e.MCP_TIMEOUT_MS ?? 6000) });
  const tls = e.SKILL_TLS_KEY && e.SKILL_TLS_CERT ? { key: readFileSync(e.SKILL_TLS_KEY, "utf8"), cert: readFileSync(e.SKILL_TLS_CERT, "utf8") } : undefined;
  const running = await startSkillServer({
    port: Number(e.SKILL_PORT ?? 8795),
    host: e.SKILL_HOST ?? "127.0.0.1",
    proofpay,
    skillId: e.ALEXA_SKILL_ID || undefined,
    skipSignatureCheck: e.SKIP_SIGNATURE_CHECK === "1",
    tls,
  });
  const shutdown = () => { running.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
