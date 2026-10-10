// MCP client of the proofpay server, used by the Alexa skill handler.
//
// Same wire as the host simulator: Streamable HTTP, protocol 2025-11-25 (stateful Mcp-Session-Id), simulated
// account linking with "Authorization: Bearer pbp-sandbox-<user>". One MCP session per Alexa session (cached
// in memory while the process lives); a dead cached session (server restart -> 404) is dropped and the call is
// retried once on a fresh session if the deadline still allows it.
//
// Alexa waits at most 8 s for a skill response, so every call has a hard client deadline (default 6 s) that
// covers connect + tools/list + tools/call together.
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";

export type ToolOutcome =
  | { kind: "ok"; tool: string; text: string; structured: any; isError: boolean; ms: number }
  | { kind: "missing"; tool: string; available: string[] } // the server does not offer this tool (yet)
  | { kind: "timeout"; tool: string; ms: number }
  | { kind: "error"; tool: string; message: string };

export interface Proofpay {
  call(sessionKey: string, tool: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  endSession(sessionKey: string): Promise<void>;
  close(): Promise<void>;
}

export type ProofpayOptions = {
  url: string; // e.g. http://127.0.0.1:8787/mcp
  token: string; // pbp-sandbox-<user>
  timeoutMs?: number; // whole call budget, default 6000
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  sessionTtlMs?: number; // drop idle cached sessions after this, default 10 min
};

type Entry = { client: Client; transport: StreamableHTTPClientTransport; tools: Set<string>; lastUsed: number };

class DeadlineError extends Error {}

export function createProofpay(opts: ProofpayOptions): Proofpay {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const ttl = opts.sessionTtlMs ?? 10 * 60_000;
  const log = opts.log ?? ((m, x) => console.log(new Date().toISOString(), "[skill]", m, x ? JSON.stringify(x) : ""));
  const cache = new Map<string, Entry>();

  async function drop(key: string): Promise<void> {
    const e = cache.get(key);
    cache.delete(key);
    if (!e) return;
    await e.transport.terminateSession().catch(() => {});
    await e.client.close().catch(() => {});
  }

  function sweep(now: number): void {
    for (const [k, e] of cache) if (now - e.lastUsed > ttl) void drop(k);
  }

  async function open(signal: AbortSignal): Promise<Entry> {
    const client = new Client({ name: "proof-before-pay-alexa-skill", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${opts.token}` }, signal },
    });
    await client.connect(transport, { signal, timeout: timeoutMs });
    const listed = await client.listTools(undefined, { signal, timeout: timeoutMs });
    return { client, transport, tools: new Set(listed.tools.map((t) => t.name)), lastUsed: Date.now() };
  }

  async function attempt(key: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, remaining: () => number): Promise<ToolOutcome> {
    let entry = cache.get(key);
    if (!entry) {
      entry = await open(signal);
      cache.set(key, entry);
    }
    entry.lastUsed = Date.now();
    if (!entry.tools.has(tool)) return { kind: "missing", tool, available: [...entry.tools].sort() };
    const t0 = performance.now();
    const r = (await entry.client.callTool({ name: tool, arguments: args }, { signal, timeout: Math.max(1, remaining()) })) as CallToolResult;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ").trim();
    return { kind: "ok", tool, text, structured: r.structuredContent ?? null, isError: r.isError === true, ms: Math.round(performance.now() - t0) };
  }

  return {
    async call(sessionKey, tool, args) {
      const started = Date.now();
      sweep(started);
      const ac = new AbortController();
      const remaining = () => timeoutMs - (Date.now() - started);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new DeadlineError(`deadline ${timeoutMs} ms`)); }, timeoutMs);
      });
      try {
        try {
          return await Promise.race([attempt(sessionKey, tool, args, ac.signal, remaining), deadline]);
        } catch (e) {
          if (e instanceof DeadlineError || ac.signal.aborted) throw e;
          // A cached session can die (server restart -> 404 "Session not found"). Retry once, fresh.
          if (cache.has(sessionKey) && remaining() > 1000) {
            log("mcp retry on a fresh session", { tool, error: String((e as Error).message ?? e).slice(0, 160) });
            await drop(sessionKey);
            return await Promise.race([attempt(sessionKey, tool, args, ac.signal, remaining), deadline]);
          }
          throw e;
        }
      } catch (e) {
        if (e instanceof DeadlineError || ac.signal.aborted) {
          await drop(sessionKey);
          log("mcp timeout", { tool, ms: Date.now() - started });
          return { kind: "timeout", tool, ms: Date.now() - started };
        }
        await drop(sessionKey);
        const message = String((e as Error).message ?? e);
        log("mcp error", { tool, error: message.slice(0, 300) });
        return { kind: "error", tool, message };
      } finally {
        clearTimeout(timer);
      }
    },
    endSession: (key) => drop(key),
    async close() {
      for (const k of [...cache.keys()]) await drop(k);
    },
  };
}
