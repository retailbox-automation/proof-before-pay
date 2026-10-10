// Static servers for the host simulator.
//   http://127.0.0.1:5178  host page (index.html, host.js, host.css, config.js)
//   http://127.0.0.1:5179  sandbox proxy (sandbox.html + sandbox.js) - a separate origin, CSP via HTTP header
// Run: node host/serve.ts   (after `npm run build`). Ports/URLs: HOST_PORT, SANDBOX_PROXY_PORT, MCP_PORT, SANDBOX_PORT.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The card resources declare no ui.csp, so the spec's restrictive default applies to the View
// (inner iframe inherits this document's policy via document.write), plus frame/object/base rules.
const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>sandbox proxy</title>
<style>html,body{margin:0;height:100%;background:transparent}</style></head>
<body><script src="/sandbox.js"></script></body></html>`;

function file(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`${path} missing - run "npm run build" first`);
  return readFileSync(path);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

export type HostOptions = { hostPort?: number; proxyPort?: number; mcpUrl?: string; simUrl?: string; quiet?: boolean };
export type RunningHost = { hostUrl: string; proxyUrl: string; close: () => Promise<void> };

export async function startHost(opts: HostOptions = {}): Promise<RunningHost> {
  const env = process.env;
  const hostPort = opts.hostPort ?? Number(env.HOST_PORT ?? 5178);
  const proxyPort = opts.proxyPort ?? Number(env.SANDBOX_PROXY_PORT ?? 5179);
  const mcpUrl = opts.mcpUrl ?? `http://127.0.0.1:${env.MCP_PORT ?? 8787}/mcp`;
  const simUrl = opts.simUrl ?? `http://127.0.0.1:${env.SANDBOX_PORT ?? 8791}/sim`;
  const hostOrigins = [`http://127.0.0.1:${hostPort}`, `http://localhost:${hostPort}`];
  const proxyUrl = `http://127.0.0.1:${proxyPort}/sandbox.html`;
  const config = `window.__PBP = ${JSON.stringify({ mcpUrl, sandboxProxyUrl: proxyUrl, simUrl })};\n`;

  const host = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      const send = (type: string, body: Buffer | string) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
      if (path === "/" || path === "/index.html") send("text/html; charset=utf-8", file(join(ROOT, "host", "index.html")));
      else if (path === "/host.js") send("text/javascript; charset=utf-8", file(join(ROOT, "dist", "host.js")));
      else if (path === "/host.css") send("text/css; charset=utf-8", file(join(ROOT, "dist", "host.css")));
      else if (path === "/config.js") send("text/javascript; charset=utf-8", config);
      else if (path === "/healthz") send("application/json", '{"ok":true}');
      else { res.writeHead(404); res.end("not found"); }
    } catch (err) {
      res.writeHead(500); res.end(String(err));
    }
  });

  const sandbox = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (path === "/sandbox.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SANDBOX_CSP, "Cache-Control": "no-store" });
        res.end(SANDBOX_HTML);
      } else if (path === "/sandbox.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`self.__PBP_HOST_ORIGINS=${JSON.stringify(hostOrigins)};\n${file(join(ROOT, "dist", "sandbox.js")).toString("utf8")}`);
      } else {
        res.writeHead(404); res.end("only the sandbox proxy is served on this origin");
      }
    } catch (err) {
      res.writeHead(500); res.end(String(err));
    }
  });

  const hp = await listen(host, hostPort);
  const pp = await listen(sandbox, proxyPort);
  if (!opts.quiet) {
    console.log(`host    http://127.0.0.1:${hp}/  (MCP ${mcpUrl}, sandbox clock ${simUrl})`);
    console.log(`sandbox proxy http://127.0.0.1:${pp}/sandbox.html`);
  }
  return {
    hostUrl: `http://127.0.0.1:${hp}/`,
    proxyUrl,
    close: async () => {
      host.closeAllConnections(); sandbox.closeAllConnections();
      await Promise.all([new Promise((r) => host.close(r)), new Promise((r) => sandbox.close(r))]);
    },
  };
}

if (import.meta.main) {
  const h = await startHost();
  const shutdown = () => { h.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
