// npm run demo — build, then start the sandbox services, the proofpay MCP server and the host simulator
// in one process, fully offline (REGISTRY_MODE=fixture unless set). Prints the URLs. Ctrl+C stops all.
//   ports (env-overridable): MCP_PORT 8787, HOST_PORT 5178, SANDBOX_PROXY_PORT 5179, SANDBOX_PORT 8791
//   --open   also open the host page in the default browser
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.REGISTRY_MODE ??= "fixture";
const ports = {
  mcp: Number(process.env.MCP_PORT ?? 8787),
  host: Number(process.env.HOST_PORT ?? 5178),
  proxy: Number(process.env.SANDBOX_PROXY_PORT ?? 5179),
  sandbox: Number(process.env.SANDBOX_PORT ?? 8791),
};

function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

for (const [name, port] of Object.entries(ports)) {
  if (!(await free(port))) {
    console.error(`port ${port} (${name}) is in use; stop that process or set ${name === "mcp" ? "MCP_PORT" : name === "host" ? "HOST_PORT" : name === "proxy" ? "SANDBOX_PROXY_PORT" : "SANDBOX_PORT"}`);
    process.exit(1);
  }
}

const b = spawnSync(process.execPath, ["build.ts"], { cwd: ROOT, stdio: "inherit" });
if (b.status !== 0) process.exit(b.status ?? 1);

const { startSandbox } = await import("../src/sandbox/server.ts");
const { startMcpServer } = await import("../server/server.ts");
const { startHost } = await import("../host/serve.ts");

const hostOrigins = [`http://127.0.0.1:${ports.host}`, `http://localhost:${ports.host}`];
const sandbox = await startSandbox({ port: ports.sandbox, webhookUrl: `http://127.0.0.1:${ports.mcp}/webhooks/doorbell`, signingKey: process.env.RING_SIGNING_KEY || "sandbox-signing-key", corsOrigins: hostOrigins });
process.env.SANDBOX_BASE = sandbox.url;
const mcp = await startMcpServer({ port: ports.mcp });
const host = await startHost({ hostPort: ports.host, proxyPort: ports.proxy, mcpUrl: mcp.url, simUrl: `${sandbox.url}/sim` });

console.log("");
console.log(`Proof Before Pay demo is running (registry mode: ${process.env.REGISTRY_MODE}, offline: ${process.env.REGISTRY_MODE === "fixture"})`);
console.log(`  host simulator   ${host.hostUrl}   <- open this; press "Play demo"`);
console.log(`  MCP endpoint     ${mcp.url}   (2025-11-25 sessions + 2026-07-28)`);
console.log(`  sandbox services ${sandbox.url}   (/spi marketplace, /ring camera simulator, /sim clock)`);
console.log(`  card sandbox     ${host.proxyUrl}`);
console.log("Ctrl+C stops everything.");
if (process.argv.includes("--open")) spawnSync("open", [host.hostUrl]);

const shutdown = async () => {
  await host.close().catch(() => {});
  await mcp.close().catch(() => {});
  await sandbox.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
