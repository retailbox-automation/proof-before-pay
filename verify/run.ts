// One-command verification: build -> start MCP server (8787) + host (5178/5179) -> protocol checks ->
// headless browser checks -> PASS/FAIL table -> stop everything (pid files in .pids/).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/client";
import { runProtocolChecks, type Row } from "./protocol.ts";
import { runBrowserChecks } from "./browser.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIDS = join(ROOT, ".pids");
const LOGS = join(ROOT, "logs");
const MCP_URL = "http://127.0.0.1:8787/mcp";
const HOST_URL = "http://127.0.0.1:5178/";
const SCREENSHOT = join(ROOT, "..", "docs", "spike-2026-09-24", "host-card.png");
mkdirSync(PIDS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const out: string[] = [];
const log = (s: string) => { console.log(s); out.push(s); };
const version = (pkg: string) => JSON.parse(readFileSync(join(ROOT, "node_modules", ...pkg.split("/"), "package.json"), "utf8")).version;

async function isUp(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
}

async function waitUp(url: string, child: ChildProcess, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early (code ${child.exitCode}); see logs/${name}.log`);
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${name} not up at ${url} within 10s; see logs/${name}.log`);
}

function start(name: string, script: string): ChildProcess {
  const fd = openSync(join(LOGS, `${name}.log`), "w");
  const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ["ignore", fd, fd] });
  writeFileSync(join(PIDS, `${name}.pid`), String(child.pid));
  return child;
}

async function stop(name: string, child: ChildProcess | undefined): Promise<void> {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(join(PIDS, `${name}.pid`), { force: true });
}

log(`# verify run ${new Date().toISOString()}`);
log(`node ${process.version} | @modelcontextprotocol/client ${version("@modelcontextprotocol/client")} | server ${version("@modelcontextprotocol/server")} | node-adapter ${version("@modelcontextprotocol/node")} | core ${version("@modelcontextprotocol/core")} | ext-apps ${version("@modelcontextprotocol/ext-apps")} | playwright ${version("playwright")} | esbuild ${version("esbuild")}`);
log(`SDK LATEST_PROTOCOL_VERSION=${LATEST_PROTOCOL_VERSION} SUPPORTED_PROTOCOL_VERSIONS=${JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS)}`);

const b = spawnSync(process.execPath, ["build.ts"], { cwd: ROOT, encoding: "utf8" });
log(`build: exit ${b.status} ${(b.stdout + b.stderr).trim()}`);
if (b.status !== 0) process.exit(1);

for (const url of [`${MCP_URL.replace("/mcp", "/healthz")}`, `${HOST_URL}healthz`]) {
  if (await isUp(url)) { log(`ABORT: something already answers ${url} (stale server? check spike/.pids)`); process.exit(1); }
}

let server: ChildProcess | undefined;
let host: ChildProcess | undefined;
const rows: Row[] = [];
try {
  server = start("server", "server/server.ts");
  host = start("host", "host/serve.ts");
  await waitUp(MCP_URL.replace("/mcp", "/healthz"), server, "server");
  await waitUp(`${HOST_URL}healthz`, host, "host");
  log(`servers up: mcp pid ${server.pid}, host pid ${host.pid}`);
  rows.push(...(await runProtocolChecks(MCP_URL, log)));
  rows.push(...(await runBrowserChecks(HOST_URL, SCREENSHOT, log)));
} catch (err) {
  rows.push({ id: "X", check: "harness", expected: "no exception", actual: String(err), pass: false });
  log(`HARNESS ERROR: ${String(err)}`);
} finally {
  await stop("host", host);
  await stop("server", server);
  log(`servers stopped (mcp alive=${await isUp(MCP_URL.replace("/mcp", "/healthz"))}, host alive=${await isUp(`${HOST_URL}healthz`)})`);
}

const w = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
log("");
log(`| ${w("id", 4)} | ${w("result", 6)} | ${w("check", 62)} | actual`);
log(`|${"-".repeat(6)}|${"-".repeat(8)}|${"-".repeat(64)}|-------`);
for (const r of rows) log(`| ${w(r.id, 4)} | ${w(r.pass ? "PASS" : "FAIL", 6)} | ${w(r.check, 62)} | ${r.actual}`);
const failed = rows.filter((r) => !r.pass).length;
log("");
log(`TOTAL ${rows.length} checks: ${rows.length - failed} PASS, ${failed} FAIL`);
writeFileSync(join(LOGS, "verify-latest.txt"), out.join("\n") + "\n");
writeFileSync(join(LOGS, "verify-latest.json"), JSON.stringify(rows, null, 2));
process.exit(failed ? 1 : 0);
