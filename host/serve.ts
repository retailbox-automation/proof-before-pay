// Static servers for the host simulator.
//   http://127.0.0.1:5178  host page (index.html, host.js, host.css, config.js)
//   http://127.0.0.1:5179  sandbox proxy (sandbox.html + sandbox.js) - a separate origin, CSP via HTTP header
// Run: node host/serve.ts   (after `npm run build`). Ports/URLs: HOST_PORT, SANDBOX_PROXY_PORT, MCP_PORT, SANDBOX_PORT.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// CSP for the View (the inner iframe inherits this document's policy via document.write). Restrictive default,
// widened only by the origins the card declares in _meta.ui.csp (passed by the host as ?csp=...), validated here.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
function sandboxCsp(query: string | null): string {
  let res: string[] = [], con: string[] = [];
  try {
    const j = query ? JSON.parse(query) as { resourceDomains?: unknown; connectDomains?: unknown } : {};
    res = (Array.isArray(j.resourceDomains) ? j.resourceDomains : []).filter((d): d is string => typeof d === "string" && ORIGIN.test(d)).slice(0, 8);
    con = (Array.isArray(j.connectDomains) ? j.connectDomains : []).filter((d): d is string => typeof d === "string" && ORIGIN.test(d)).slice(0, 8);
  } catch { /* malformed -> default policy */ }
  const r = res.join(" ");
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    `style-src 'self' 'unsafe-inline' ${r}`.trim(),
    `img-src 'self' data: ${r}`.trim(),
    `media-src 'self' data: ${r}`.trim(),
    `font-src 'self' ${r}`.trim(),
    con.length ? `connect-src ${con.join(" ")}` : "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
const FONT_DIR = join(ROOT, "node_modules", "@fontsource", "inter", "files");
const HOST_FONTS = new Set(["inter-latin-400-normal.woff2", "inter-latin-500-normal.woff2", "inter-latin-600-normal.woff2", "inter-latin-700-normal.woff2"]);

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

export type HostOptions = { hostPort?: number; proxyPort?: number; mcpUrl?: string; simUrl?: string; checkoutBase?: string; quiet?: boolean };
export type RunningHost = { hostUrl: string; proxyUrl: string; close: () => Promise<void> };

export async function startHost(opts: HostOptions = {}): Promise<RunningHost> {
  const env = process.env;
  const hostPort = opts.hostPort ?? Number(env.HOST_PORT ?? 5178);
  const proxyPort = opts.proxyPort ?? Number(env.SANDBOX_PROXY_PORT ?? 5179);
  const mcpUrl = opts.mcpUrl ?? `http://127.0.0.1:${env.MCP_PORT ?? 8787}/mcp`;
  const simUrl = opts.simUrl ?? `http://127.0.0.1:${env.SANDBOX_PORT ?? 8791}/sim`;
  // The simulated Alexa+ checkout calls the partner's UCP-shaped endpoints directly (as Alexa+ would).
  const checkoutBase = opts.checkoutBase ?? simUrl.replace(/\/sim$/, "");
  // Sandbox voice purchasing code of the simulated Alexa+ account. Checked by the platform layer only.
  const voiceCode = env.SANDBOX_VOICE_CODE ?? "4719";
  const hostOrigins = [`http://127.0.0.1:${hostPort}`, `http://localhost:${hostPort}`];
  const proxyUrl = `http://127.0.0.1:${proxyPort}/sandbox.html`;
  const config = `window.__PBP = ${JSON.stringify({ mcpUrl, sandboxProxyUrl: proxyUrl, simUrl, checkoutBase, voiceCode })};\n`;

  const host = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      const send = (type: string, body: Buffer | string) => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
      if (path === "/" || path === "/index.html") send("text/html; charset=utf-8", file(join(ROOT, "host", "index.html")));
      else if (path === "/host.js") send("text/javascript; charset=utf-8", file(join(ROOT, "dist", "host.js")));
      else if (path === "/host.css") send("text/css; charset=utf-8", file(join(ROOT, "dist", "host.css")));
      else if (path === "/config.js") send("text/javascript; charset=utf-8", config);
      else if (path.startsWith("/fonts/") && HOST_FONTS.has(path.slice(7))) send("font/woff2", file(join(FONT_DIR, path.slice(7))));
      else if (path === "/healthz") send("application/json", '{"ok":true}');
      else { res.writeHead(404); res.end("not found"); }
    } catch (err) {
      res.writeHead(500); res.end(String(err));
    }
  });

  const sandbox = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname;
    try {
      if (path === "/sandbox.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": sandboxCsp(u.searchParams.get("csp")), "Cache-Control": "no-store" });
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
