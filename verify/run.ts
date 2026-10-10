// npm run verify — build -> start sandbox services (8791), proofpay MCP server (8787) and host (5178/5179)
// as child processes (pid files in .pids/) -> protocol + tool checks -> core unit tests -> backtest (when
// present) -> headless browser run of every beat with screenshots -> PASS/FAIL table -> stop everything.
// Exit code 1 on any FAIL. Ports are env-overridable: MCP_PORT, HOST_PORT, SANDBOX_PROXY_PORT, SANDBOX_PORT.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { runProtocolChecks, type Row } from "./protocol.ts";
import { runBrowserChecks } from "./browser.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIDS = join(ROOT, ".pids");
const LOGS = join(ROOT, "logs");
const SCREENS = join(ROOT, "..", "..", "docs", "screens", "proof-before-pay");
const ports = {
  mcp: Number(process.env.MCP_PORT ?? 8787),
  host: Number(process.env.HOST_PORT ?? 5178),
  proxy: Number(process.env.SANDBOX_PROXY_PORT ?? 5179),
  sandbox: Number(process.env.SANDBOX_PORT ?? 8791),
};
const MCP_URL = `http://127.0.0.1:${ports.mcp}/mcp`;
const HOST_URL = `http://127.0.0.1:${ports.host}/`;
const SANDBOX_URL = `http://127.0.0.1:${ports.sandbox}`;
const DATA_DIR = join(ROOT, "data", "verify");
const SIGNING_KEY = `verify-signing-key-${Date.now().toString(36)}`; // sandbox literal; proves the key is plumbed through env
mkdirSync(PIDS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
rmSync(DATA_DIR, { recursive: true, force: true });

const out: string[] = [];
const log = (s: string) => { console.log(s); out.push(s); };
const version = (pkg: string) => JSON.parse(readFileSync(join(ROOT, "node_modules", ...pkg.split("/"), "package.json"), "utf8")).version;

async function isUp(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
}
async function waitUp(url: string, child: ChildProcess, name: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early (code ${child.exitCode}); see logs/${name}.log`);
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${name} not up at ${url} within 15s; see logs/${name}.log`);
}
function start(name: string, script: string, env: Record<string, string>): ChildProcess {
  const fd = openSync(join(LOGS, `${name}.log`), "w");
  const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
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
log(`node ${process.version} | @modelcontextprotocol/client ${version("@modelcontextprotocol/client")} | server ${version("@modelcontextprotocol/server")} | node-adapter ${version("@modelcontextprotocol/node")} | ext-apps ${version("@modelcontextprotocol/ext-apps")} | playwright ${version("playwright")} | esbuild ${version("esbuild")}`);
log(`SDK client LATEST_PROTOCOL_VERSION=${LATEST_PROTOCOL_VERSION}; server: 2025-11-25 strict sessions + 2026-07-28 via isLegacyRequest/createMcpHandler`);

const b = spawnSync(process.execPath, ["build.ts"], { cwd: ROOT, encoding: "utf8" });
log(`build: exit ${b.status} ${(b.stdout + b.stderr).trim()}`);
if (b.status !== 0) process.exit(1);

for (const url of [`${SANDBOX_URL}/healthz`, MCP_URL.replace("/mcp", "/healthz"), `${HOST_URL}healthz`, "http://127.0.0.1:8789/healthz"]) {
  if (await isUp(url)) { log(`ABORT: something already answers ${url} (stale server? check .pids/ and lsof)`); process.exit(1); }
}

const serverEnv = { PROOFPAY_DATA_DIR: DATA_DIR, SANDBOX_BASE: SANDBOX_URL, RING_SIGNING_KEY: SIGNING_KEY, REGISTRY_MODE: "fixture", HOST_PORT: String(ports.host) };
let sandbox: ChildProcess | undefined, server: ChildProcess | undefined, host: ChildProcess | undefined;
const rows: Row[] = [];
try {
  sandbox = start("sandbox", "src/sandbox/server.ts", { SANDBOX_PORT: String(ports.sandbox), ADDON_WEBHOOK_URL: MCP_URL.replace("/mcp", "/webhooks/doorbell"), RING_SIGNING_KEY: SIGNING_KEY });
  server = start("server", "server/server.ts", { ...serverEnv, MCP_PORT: String(ports.mcp) });
  host = start("host", "host/serve.ts", { HOST_PORT: String(ports.host), SANDBOX_PROXY_PORT: String(ports.proxy), MCP_PORT: String(ports.mcp), SANDBOX_PORT: String(ports.sandbox) });
  await waitUp(`${SANDBOX_URL}/healthz`, sandbox, "sandbox");
  await waitUp(MCP_URL.replace("/mcp", "/healthz"), server, "server");
  await waitUp(`${HOST_URL}healthz`, host, "host");
  log(`servers up: sandbox pid ${sandbox.pid}, mcp pid ${server.pid}, host pid ${host.pid}; data ${DATA_DIR}`);

  rows.push(...(await runProtocolChecks({ mcpUrl: MCP_URL, simBase: `${SANDBOX_URL}/sim`, dataDir: DATA_DIR, serverEnv }, log)));

  const t = spawnSync(process.execPath, ["--test", "src/**/*.test.ts", "scripts/**/*.test.ts"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, LIVE: "" } });
  const txt = t.stdout + t.stderr;
  writeFileSync(join(LOGS, "core-tests.log"), txt);
  const num = (k: string) => Number(txt.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? NaN);
  const r = { id: "C1", check: "core unit tests (npm test: reconcile, registry, doorbell, sandbox)", expected: "exit 0, fail 0", actual: `exit ${t.status} · tests ${num("tests")} · pass ${num("pass")} · fail ${num("fail")} · skipped ${num("skipped")}`, pass: t.status === 0 && num("fail") === 0 && num("pass") > 0 };
  rows.push(r);
  log(`${r.pass ? "PASS" : "FAIL"} C1 ${r.check} :: ${r.actual}`);

  // Backtest (lane CORE): exit 0 = published numbers reproduce, 1 = they differ, 2 = ledger not supplied.
  const published = existsSync(join(ROOT, "..", "..", "docs", "proof-before-pay", "BACKTEST.md"));
  if (existsSync(join(ROOT, "scripts", "backtest.ts"))) {
    const bt = spawnSync(process.execPath, ["scripts/backtest.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(join(LOGS, "backtest.log"), bt.stdout + bt.stderr);
    const last = (bt.stdout + bt.stderr).trim().split("\n").at(-1)?.slice(0, 140) ?? "";
    if (bt.status === 2 && !published) {
      log(`NOTE C2 backtest pending: anonymized ledger not supplied and no BACKTEST.md published yet (exit 2) - not counted`);
    } else {
      const row = { id: "C2", check: "backtest re-run reproduces docs/proof-before-pay/BACKTEST.md", expected: "exit 0", actual: `exit ${bt.status} ${last}`, pass: bt.status === 0 };
      rows.push(row);
      log(`${row.pass ? "PASS" : "FAIL"} C2 ${row.check} :: ${row.actual}`);
    }
  } else {
    log("NOTE C2 backtest: scripts/backtest.ts is not in this tree yet (lane CORE); not run");
  }

  await fetch(`${SANDBOX_URL}/sim/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scenario":"demo"}' });
  rows.push(...(await runBrowserChecks({ hostUrl: HOST_URL, simBase: `${SANDBOX_URL}/sim`, screensDir: SCREENS }, log)));
} catch (err) {
  rows.push({ id: "X", check: "harness", expected: "no exception", actual: String((err as Error).stack ?? err).slice(0, 400), pass: false });
  log(`HARNESS ERROR: ${String((err as Error).stack ?? err)}`);
} finally {
  await stop("host", host);
  await stop("server", server);
  await stop("sandbox", sandbox);
  log(`servers stopped (sandbox alive=${await isUp(`${SANDBOX_URL}/healthz`)}, mcp alive=${await isUp(MCP_URL.replace("/mcp", "/healthz"))}, host alive=${await isUp(`${HOST_URL}healthz`)})`);
}

const w = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
log("");
log(`| ${w("id", 4)} | ${w("result", 6)} | ${w("check", 70)} | actual`);
log(`|${"-".repeat(6)}|${"-".repeat(8)}|${"-".repeat(72)}|-------`);
for (const r of rows) log(`| ${w(r.id, 4)} | ${w(r.pass ? "PASS" : "FAIL", 6)} | ${w(r.check, 70)} | ${r.actual}`);
const failed = rows.filter((r) => !r.pass).length;
log("");
log(`TOTAL ${rows.length} checks: ${rows.length - failed} PASS, ${failed} FAIL`);
writeFileSync(join(LOGS, "verify-latest.txt"), out.join("\n") + "\n");
writeFileSync(join(LOGS, "verify-latest.json"), JSON.stringify(rows, null, 2));
process.exit(failed ? 1 : 0);
