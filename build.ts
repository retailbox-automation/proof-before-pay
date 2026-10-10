// Bundles the browser code with esbuild:
//   dist/host.js            host simulator (MCP client + AppBridge)
//   dist/host.css           host styling (copied)
//   dist/sandbox.js         sandbox proxy
//   dist/views/<view>.html  MCP App views: single self-contained HTML each (script + shared CSS inlined),
//                           served as ui://proofpay/<view>.html
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const VIEWS = ["pros", "scope", "payment", "status", "draft", "warranty"] as const;
mkdirSync(join(DIST, "views"), { recursive: true });

const common = { bundle: true, platform: "browser" as const, target: "es2022", minify: true, legalComments: "none" as const, logLevel: "warning" as const };

await build({ ...common, entryPoints: [join(ROOT, "host", "host.ts")], outfile: join(DIST, "host.js"), format: "esm" });
await build({ ...common, entryPoints: [join(ROOT, "host", "sandbox.ts")], outfile: join(DIST, "sandbox.js"), format: "iife" });
copyFileSync(join(ROOT, "host", "host.css"), join(DIST, "host.css"));

const view = await build({ ...common, entryPoints: [join(ROOT, "views", "card.ts")], format: "iife", write: false });
const js = view.outputFiles[0].text.replaceAll("</script", "<\\/script");
const css = readFileSync(join(ROOT, "views", "card.css"), "utf8").replaceAll("</style", "<\\/style");
let bytes = 0;
for (const v of VIEWS) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof Before Pay · ${v}</title>
<style>${css}</style>
</head>
<body data-view="${v}">
<main id="root"><p class="subtitle" id="loading">Loading…</p></main>
<script>${js}</script>
</body>
</html>
`;
  writeFileSync(join(DIST, "views", `${v}.html`), html);
  bytes = html.length;
}
console.log(`built dist/host.js, dist/sandbox.js, dist/views/{${VIEWS.join(",")}}.html (${(bytes / 1024).toFixed(0)} KB each)`);
