// Node-side protocol checks against the running MCP server (A*) + negative controls (N*).
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "../server/server.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Row = { id: string; check: string; expected: string; actual: string; pass: boolean };
const ACCEPT = "application/json, text/event-stream";
const TARGET = "2025-11-25";

type Raw = { status: number; headers: Headers; body: any; text: string };

// Minimal raw JSON-RPC over HTTP (to see status codes and headers the SDK client hides).
async function raw(url: string, method: string, message: unknown, headers: Record<string, string> = {}): Promise<Raw> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: ACCEPT, ...headers },
    body: message === undefined ? undefined : JSON.stringify(message),
  });
  const text = await res.text();
  let body: any;
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  try {
    body = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1].slice(5)) : text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, body, text };
}

const init = (protocolVersion: string, id = 1) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "verify-raw", version: "0" } },
});
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const listTools = (id = 2) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });

async function rawSession(url: string, version: string, extra: Record<string, string> = {}) {
  const r = await raw(url, "POST", init(version), extra);
  const sid = r.headers.get("mcp-session-id") ?? "";
  if (sid) await raw(url, "POST", initialized, { "mcp-session-id": sid, "mcp-protocol-version": r.body?.result?.protocolVersion ?? version, ...extra });
  return { r, sid };
}

// A separate server process (own pid file) so a restart is a real process restart.
async function spawnServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server/server.ts", "--port", String(port)], { cwd: ROOT, stdio: "ignore" });
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

async function oneCall(url: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const c = new Client({ name: "verify-restart", version: "0.0.1" });
  const t = new StreamableHTTPClientTransport(new URL(url));
  await c.connect(t);
  try {
    return (await c.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await t.terminateSession().catch(() => {});
    await c.close();
  }
}

function textOf(r: CallToolResult): string {
  return r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(" | ");
}

export async function runProtocolChecks(mcpUrl: string, log: (s: string) => void): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (id: string, check: string, expected: string, actual: string, pass: boolean) => {
    rows.push({ id, check, expected, actual, pass });
    log(`${pass ? "PASS" : "FAIL"} ${id} ${check} :: ${actual}`);
  };
  const user = `verify-${Date.now()}`;

  // Record every header the official client sends/receives.
  const seen: { method: string; reqProto: string | null; resProto: string | null; sid: string | null; status: number }[] = [];
  const recordingFetch: typeof fetch = async (input, initArg) => {
    const res = await fetch(input, initArg);
    const h = new Headers(initArg?.headers);
    let method = "?";
    try { method = JSON.parse(String(initArg?.body ?? "{}")).method ?? initArg?.method ?? "?"; } catch { method = initArg?.method ?? "?"; }
    seen.push({ method: `${initArg?.method ?? "GET"} ${method}`, reqProto: h.get("mcp-protocol-version"), resProto: res.headers.get("mcp-protocol-version"), sid: res.headers.get("mcp-session-id"), status: res.status });
    return res;
  };

  // ---- A1: initialize via the official client ----
  const c1 = new Client({ name: "verify-node", version: "0.0.1" });
  const t1 = new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: recordingFetch });
  await c1.connect(t1);
  const negotiated = c1.getNegotiatedProtocolVersion();
  add("A1", "initialize negotiates protocolVersion (official client)", `"${TARGET}"`, JSON.stringify(negotiated), negotiated === TARGET);

  const rawInit = await raw(mcpUrl, "POST", init(TARGET));
  add("A1b", "raw initialize result.protocolVersion + Mcp-Session-Id header", `"${TARGET}" + session id`,
    `${JSON.stringify(rawInit.body?.result?.protocolVersion)} sid=${rawInit.headers.get("mcp-session-id") ? "present" : "MISSING"} content-type=${rawInit.headers.get("content-type")}`,
    rawInit.body?.result?.protocolVersion === TARGET && !!rawInit.headers.get("mcp-session-id"));
  if (rawInit.headers.get("mcp-session-id")) await raw(mcpUrl, "DELETE", undefined, { "mcp-session-id": rawInit.headers.get("mcp-session-id")! });

  // ---- A2: tools/list ----
  const toolList = (await c1.listTools()).tools;
  const names = toolList.map((t) => t.name).sort();
  const card = toolList.find((t) => t.name === "show_card");
  const meta = (card?._meta ?? {}) as Record<string, any>;
  add("A2", "tools/list has remember, recall, show_card", "all three", names.join(","), ["recall", "remember", "show_card"].every((n) => names.includes(n)));
  add("A2b", "show_card _meta links ui:// resource", `_meta.ui.resourceUri = ui://notes/card.html`,
    `_meta=${JSON.stringify(meta)}`, meta.ui?.resourceUri === "ui://notes/card.html");

  const hdr = seen.find((s) => s.method.includes("tools/list"));
  add("A1c", "client sends MCP-Protocol-Version header after init", `request header "${TARGET}"`,
    `request=${JSON.stringify(hdr?.reqProto)} response-header=${JSON.stringify(hdr?.resProto)}`, hdr?.reqProto === TARGET);

  // ---- A3: remember in session 1 ----
  const rem = (await c1.callTool({ name: "remember", arguments: { user_id: user, text: "buy milk" } })) as CallToolResult;
  add("A3", "remember(user,'buy milk') in session 1", "not isError", `${textOf(rem)} isError=${!!rem.isError}`, !rem.isError);

  // ---- A4: close session 1 (HTTP DELETE) and prove it is gone ----
  const sid1 = t1.sessionId!;
  await t1.terminateSession();
  await c1.close();
  const after = await raw(mcpUrl, "POST", listTools(), { "mcp-session-id": sid1, "mcp-protocol-version": TARGET });
  add("A4", "old session id rejected after DELETE", "HTTP 404", `HTTP ${after.status} ${after.body?.error?.message ?? ""}`, after.status === 404);

  // ---- A5: NEW session, state survives ----
  const c2 = new Client({ name: "verify-node", version: "0.0.1" });
  const t2 = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await c2.connect(t2);
  const sid2 = t2.sessionId!;
  const rec = (await c2.callTool({ name: "recall", arguments: { user_id: user } })) as CallToolResult;
  const notes = ((rec.structuredContent ?? {}) as { notes?: string[] }).notes ?? [];
  add("A5", "new session (new Mcp-Session-Id) recalls the note", `sid2 != sid1 and notes include "buy milk"`,
    `sid1=${sid1.slice(0, 8)}... sid2=${sid2.slice(0, 8)}... notes=${JSON.stringify(notes)}`, sid2 !== sid1 && notes.includes("buy milk"));
  // Must-differ control: a user who never saved anything gets nothing (state is per user, not global).
  const other = (await c2.callTool({ name: "recall", arguments: { user_id: `${user}-other` } })) as CallToolResult;
  const otherNotes = ((other.structuredContent ?? {}) as { notes?: string[] }).notes ?? [];
  add("A5b", "control: recall for a different, fresh user", "notes = []", JSON.stringify(otherNotes), otherNotes.length === 0);

  // ---- A6: resources/read of the ui:// resource ----
  const rr = await c2.readResource({ uri: "ui://notes/card.html" });
  const content = rr.contents[0] as { mimeType?: string; text?: string };
  add("A6", "resources/read ui://notes/card.html returns HTML", `mimeType text/html;profile=mcp-app, <!DOCTYPE html>`,
    `mimeType=${content?.mimeType} bytes=${content?.text?.length ?? 0} startsWith=${JSON.stringify(content?.text?.slice(0, 15))}`,
    content?.mimeType === "text/html;profile=mcp-app" && !!content.text?.startsWith("<!DOCTYPE html>"));

  // ---- A7: input validation (edge) ----
  const bad = (await c2.callTool({ name: "remember", arguments: { user_id: "../etc/passwd", text: "x" } })) as CallToolResult;
  add("A7", "invalid user_id rejected by input schema", "isError=true", `isError=${!!bad.isError} ${textOf(bad).slice(0, 90)}`, !!bad.isError);
  await t2.terminateSession();
  await c2.close();

  // ---- A8: a 2026-07-28-era client ('auto' negotiation) against this 2025-era server ----
  const c3 = new Client({ name: "verify-auto", version: "0.0.1" }, { versionNegotiation: { mode: "auto" } } as any);
  const t3 = new StreamableHTTPClientTransport(new URL(mcpUrl));
  let autoResult = "";
  try {
    await c3.connect(t3);
    autoResult = String(c3.getNegotiatedProtocolVersion());
    await t3.terminateSession().catch(() => {});
    await c3.close();
  } catch (e) {
    autoResult = `connect error: ${String(e)}`;
  }
  add("A8", "client versionNegotiation 'auto' (probes server/discover) falls back", `"${TARGET}"`, autoResult, autoResult === TARGET);

  // ---- A9: state survives a server PROCESS restart (not just a new MCP session) ----
  const restartUser = `${user}-restart`;
  const restartUrl = "http://127.0.0.1:8789/mcp";
  let p = await spawnServer(8789);
  const pid1 = p.pid;
  let restartActual = "";
  let restartPass = false;
  try {
    await oneCall(restartUrl, "remember", { user_id: restartUser, text: "call the dentist" });
    await killServer(p);
    p = await spawnServer(8789);
    const r = await oneCall(restartUrl, "recall", { user_id: restartUser });
    const n = ((r.structuredContent ?? {}) as { notes?: string[] }).notes ?? [];
    restartActual = `pid ${pid1} -> ${p.pid}, notes=${JSON.stringify(n)}`;
    restartPass = pid1 !== p.pid && n.includes("call the dentist");
  } finally {
    await killServer(p);
  }
  add("A9", "state survives server process restart (file store)", `new pid, recall includes "call the dentist"`, restartActual, restartPass);

  // ---- Negative controls: default (lenient) server ----
  const n1 = await rawSession(mcpUrl, "2024-11-05");
  add("N1", "initialize asks OLD protocolVersion 2024-11-05", "SDK default: downgrade (echoes 2024-11-05)",
    `result.protocolVersion=${JSON.stringify(n1.r.body?.result?.protocolVersion)} HTTP ${n1.r.status}`, n1.r.body?.result?.protocolVersion === "2024-11-05");
  if (n1.sid) await raw(mcpUrl, "DELETE", undefined, { "mcp-session-id": n1.sid });

  const good = await rawSession(mcpUrl, TARGET);
  const n2 = await raw(mcpUrl, "POST", listTools(), { "mcp-session-id": good.sid, "mcp-protocol-version": "2024-11-05" });
  add("N2", "session negotiated 2025-11-25, request header says 2024-11-05", "SDK default: accepted (header only checked against supported list)",
    `HTTP ${n2.status} ${n2.body?.error?.message ?? (n2.body?.result ? "result returned" : "")}`, n2.status === 200 && !!n2.body?.result);
  const n3 = await raw(mcpUrl, "POST", listTools(3), { "mcp-session-id": good.sid, "mcp-protocol-version": "1999-01-01" });
  add("N3", "request header MCP-Protocol-Version: 1999-01-01 (unknown)", "HTTP 400",
    `HTTP ${n3.status} ${String(n3.body?.error?.message ?? "").slice(0, 110)}`, n3.status === 400);
  const n5a = await raw(mcpUrl, "POST", listTools(4), { "mcp-protocol-version": TARGET });
  add("N5a", "non-initialize request without Mcp-Session-Id", "HTTP 400", `HTTP ${n5a.status} ${n5a.body?.error?.message ?? ""}`, n5a.status === 400);
  const n5b = await raw(mcpUrl, "POST", listTools(5), { "mcp-session-id": "00000000-0000-0000-0000-000000000000", "mcp-protocol-version": TARGET });
  add("N5b", "unknown Mcp-Session-Id", "HTTP 404", `HTTP ${n5b.status} ${n5b.body?.error?.message ?? ""}`, n5b.status === 404);
  if (good.sid) await raw(mcpUrl, "DELETE", undefined, { "mcp-session-id": good.sid });

  const pre = await fetch(mcpUrl, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5178", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,mcp-session-id,mcp-protocol-version" } });
  add("N6a", "CORS preflight from host origin", "204 + allow-origin + expose Mcp-Session-Id",
    `HTTP ${pre.status} allow-origin=${pre.headers.get("access-control-allow-origin")} expose=${pre.headers.get("access-control-expose-headers")}`,
    pre.status === 204 && pre.headers.get("access-control-allow-origin") === "http://127.0.0.1:5178" && /mcp-session-id/i.test(pre.headers.get("access-control-expose-headers") ?? ""));
  const evil = await raw(mcpUrl, "POST", init(TARGET), { Origin: "http://evil.example" });
  add("N6b", "initialize from foreign Origin (DNS-rebinding guard)", "HTTP 403", `HTTP ${evil.status} ${evil.body?.error?.message ?? ""}`, evil.status === 403);

  // ---- Negative controls: strict server (supportedProtocolVersions = ["2025-11-25"]) ----
  const strict = await startMcpServer({ port: 0, strict: true, quiet: true });
  try {
    const s1 = await rawSession(strict.url, "2024-11-05");
    add("N4a", "STRICT server: initialize asks 2024-11-05", `answers "${TARGET}" (client must disconnect)`,
      `result.protocolVersion=${JSON.stringify(s1.r.body?.result?.protocolVersion)} HTTP ${s1.r.status}`, s1.r.body?.result?.protocolVersion === TARGET);
    if (s1.sid) await raw(strict.url, "DELETE", undefined, { "mcp-session-id": s1.sid });
    const s2 = await rawSession(strict.url, TARGET);
    const s2r = await raw(strict.url, "POST", listTools(), { "mcp-session-id": s2.sid, "mcp-protocol-version": "2024-11-05" });
    add("N4b", "STRICT server: request header 2024-11-05 on a 2025-11-25 session", "HTTP 400",
      `HTTP ${s2r.status} ${String(s2r.body?.error?.message ?? "").slice(0, 110)}`, s2r.status === 400);
    if (s2.sid) await raw(strict.url, "DELETE", undefined, { "mcp-session-id": s2.sid });
    const c4 = new Client({ name: "verify-strict", version: "0.0.1" });
    const t4 = new StreamableHTTPClientTransport(new URL(strict.url));
    await c4.connect(t4);
    const v4 = c4.getNegotiatedProtocolVersion();
    await t4.terminateSession().catch(() => {});
    await c4.close();
    add("N4c", "STRICT server: official client still connects", `"${TARGET}"`, JSON.stringify(v4), v4 === TARGET);
  } finally {
    await strict.close();
  }

  return rows;
}
