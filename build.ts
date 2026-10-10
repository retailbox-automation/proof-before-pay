// Bundles the browser code with esbuild:
//   dist/host.js     host simulator (MCP client + AppBridge)
//   dist/sandbox.js  sandbox proxy
//   dist/card.html   MCP App view: single self-contained HTML (script inlined), served as ui://notes/card.html
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
mkdirSync(DIST, { recursive: true });

const common = { bundle: true, platform: "browser" as const, target: "es2022", minify: true, legalComments: "none" as const, logLevel: "warning" as const };

await build({ ...common, entryPoints: [join(ROOT, "host", "host.ts")], outfile: join(DIST, "host.js"), format: "esm" });
await build({ ...common, entryPoints: [join(ROOT, "host", "sandbox.ts")], outfile: join(DIST, "sandbox.js"), format: "iife" });

const view = await build({ ...common, entryPoints: [join(ROOT, "server", "view.ts")], format: "iife", write: false });
const js = view.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes card</title>
<style>
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: transparent; }
  .card { margin: 8px; padding: 12px 14px; border-radius: 12px; background: #232f3e; color: #fff; }
  h2 { margin: 0 0 6px; font-size: 16px; color: #ffb84d; }
  ul { margin: 0; padding-left: 18px; }
  #status { margin-top: 8px; font-size: 12px; opacity: .8; }
</style>
</head>
<body>
<div class="card">
  <h2 id="title">Notes</h2>
  <ul id="notes"><li>Loading...</li></ul>
  <div id="status">Starting...</div>
</div>
<script>${js}</script>
</body>
</html>
`;
writeFileSync(join(DIST, "card.html"), html);
console.log(`built dist/host.js, dist/sandbox.js, dist/card.html (${(html.length / 1024).toFixed(0)} KB)`);
