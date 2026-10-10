// Sandbox proxy (outer iframe, served from a different origin than the host).
// Per MCP Apps spec 2026-01-26 "Sandbox proxy": announce readiness, load the View HTML into an
// inner iframe on receipt of ui/notifications/sandbox-resource-ready, relay everything else.
// Modeled on ext-apps v2.0.0 examples/basic-host/src/sandbox.ts, trimmed to what the spike needs.

const ALLOWED_HOST_ORIGINS = ["http://127.0.0.1:5178", "http://localhost:5178"];
const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

if (window.self === window.top) throw new Error("sandbox.html must be embedded by the host");
const hostOrigin = document.referrer ? new URL(document.referrer).origin : "";
if (!ALLOWED_HOST_ORIGINS.includes(hostOrigin)) throw new Error(`embedding origin not allowed: ${hostOrigin || "(no referrer)"}`);
const ownOrigin = location.origin;

// Self-test: the host must not be reachable from here (proves cross-origin isolation).
try {
  void (window.top as Window).document.title;
  throw new Error("SANDBOX BROKEN: host document is reachable");
} catch (e) {
  if (e instanceof Error && e.message.startsWith("SANDBOX BROKEN")) throw e;
}

const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-same-origin");
inner.style.cssText = "width:100%;height:100%;border:0;display:block";
document.body.append(inner);

window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    if (event.origin !== hostOrigin) return; // only our embedding host may drive us
    if (event.data?.method === RESOURCE_READY) {
      const html = event.data.params?.html;
      if (typeof html !== "string") return;
      const doc = inner.contentDocument;
      if (doc) { doc.open(); doc.write(html); doc.close(); } // inherits this document's CSP
      else inner.srcdoc = html;
      return;
    }
    inner.contentWindow?.postMessage(event.data, ownOrigin);
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== ownOrigin) return;
    window.parent.postMessage(event.data, hostOrigin);
  }
});

window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, hostOrigin);
