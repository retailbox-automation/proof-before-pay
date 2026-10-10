// Static servers for the host simulator.
//   http://127.0.0.1:5178  host page (index.html + host.js)
//   http://127.0.0.1:5179  sandbox proxy (sandbox.html + sandbox.js) - separate origin, CSP via HTTP header
// Run: node host/serve.ts   (after `npm run build`)
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_PORT = 5178;
const SANDBOX_PORT = 5179;

// The card resource declares no ui.csp, so the spec's restrictive default applies to the View
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

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

const host = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(file(join(ROOT, "host", "index.html")));
    } else if (path === "/host.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(file(join(ROOT, "dist", "host.js")));
    } else if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404); res.end("not found");
    }
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
      res.end(file(join(ROOT, "dist", "sandbox.js")));
    } else {
      res.writeHead(404); res.end("only the sandbox proxy is served on this origin");
    }
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});

await listen(host, HOST_PORT);
await listen(sandbox, SANDBOX_PORT);
console.log(`host    http://127.0.0.1:${HOST_PORT}/  (MCP server expected at http://127.0.0.1:8787/mcp)`);
console.log(`sandbox http://127.0.0.1:${SANDBOX_PORT}/sandbox.html`);
const shutdown = () => { host.close(); sandbox.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
