# Proof Before Pay — friction log

What got in the way while building the add-on, with the exact command and what we saw. Severity: high = blocks the
product, medium = cost hours or forced a design change, low = minutes.

Environment for every entry unless noted: macOS, Node v26.10.0, `@modelcontextprotocol/{server,client,node,core}` 2.0.0,
`@modelcontextprotocol/ext-apps` 2.0.0, Playwright 1.63.0 (Chromium headless), esbuild 0.28.2. Entries 1–8 are from the
build (2026-10-10; sizes in entry 3 re-measured 2026-10-18); entries 9–15 are from the first-day spike (2026-09-24).

---

## 1. Serving 2025-11-25 sessions and 2026-07-28 on one endpoint is in the SDK, but only documented in type comments

- **Task:** keep the strict 2025-11-25 stateful endpoint (Mcp-Session-Id, needed by our MCP Apps host) and also answer
  2026-07-28 clients on the same `/mcp` URL.
- **Steps:** read `@modelcontextprotocol/server` README (points to the 2026-07-28 spec, no dual-era example); found
  `createMcpHandler`, `isLegacyRequest` and `toWebRequest` only in `dist/*.d.mts` doc comments; wired
  `isLegacyRequest(probe)` in front of `createMcpHandler(factory, { legacy: "reject" })` and kept the sessionful
  `NodeStreamableHTTPServerTransport` for legacy traffic.
- **Command:** a probe server with that wiring, then three clients (`default`, `versionNegotiation: { mode: "auto" }`,
  `{ pin: "2026-07-28" }`):
  ```
  default negotiated 2025-11-25 sid yes -> era=legacy user=u1
  auto negotiated 2026-07-28 sid no -> era=modern user=u1
  pin negotiated 2026-07-28 sid no -> era=modern user=u1
  ```
  Now part of `npm run verify` (S4: `"2026-07-28" sid=none`, same saved state as the 2025 session).
- **Expected vs actual:** expected a README section; actual: the right pattern exists and needs no hand-written protocol
  code, but it is discoverable only by reading `.d.mts` files. The default `legacy: "stateless"` would have silently
  dropped our sessions (GET/DELETE answered 405).
- **Severity:** medium (about an hour).
- **Workaround:** the composition above (`server/server.ts`).
- **Suggestion:** a "serve both eras from one endpoint while keeping sessions" example in the serving guide.
- **Tool + version:** `@modelcontextprotocol/server` / `@modelcontextprotocol/node` 2.0.0.

## 2. SDK version constants don't mention 2026-07-28

- **Task:** print what the SDK supports in the verify header.
- **Command:** `node -e 'import("@modelcontextprotocol/client").then(c=>console.log(c.LATEST_PROTOCOL_VERSION, JSON.stringify(c.SUPPORTED_PROTOCOL_VERSIONS)))'`
- **Result:** `2025-11-25 ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]` — while the same package
  negotiates `2026-07-28` with `versionNegotiation: { mode: "auto" }` (entry 1).
- **Expected vs actual:** expected the modern revision in a constant; it only appears inside the negotiation code.
- **Severity:** low. **Workaround:** state both eras in our own log line. **Suggestion:** export the modern revisions.
- **Tool + version:** `@modelcontextprotocol/client` 2.0.0.

## 3. Each MCP Apps view is ~612 KB because the `App` class pulls in all of zod

- **Task:** ship each card as one self-contained HTML file (design guide: "single HTML file with all dependencies
  inlined"; keep payloads light).
- **Command:** `node build.ts` → `dist/views/{pros,scope,payment,status,draft,warranty}.html (612 KB each)`
  (626,818 bytes for `pros.html`, re-measured 2026-10-18; 591 KB on 2026-10-10 before the warranty card and the
  fitting code); gzip of one view: `gzip -c dist/views/pros.html | wc -c` → `136428`. esbuild metafile of `views/card.ts`:
  ```
  zod 442KB
  @modelcontextprotocol/client 96KB
  @modelcontextprotocol/ext-apps 30KB
  @modelcontextprotocol/core 16KB
  views 9KB
  ```
- **Expected vs actual:** our own view code is 9 KB; about 72% of the payload is schema validation the view never needs.
- **Severity:** medium (payload weight is a review criterion in the Alexa+ design guide).
- **Workaround:** none yet; the host reads the resource once per card. Next step: one shared view resource, or a slim
  build of `App`.
- **Suggestion:** a validation-free `App` entry point (`@modelcontextprotocol/ext-apps/app-lite`).
- **Tool + version:** `@modelcontextprotocol/ext-apps` 2.0.0, zod 4.6.5.

## 4. "Scale to fit" is the host's job in the Alexa+ guide, but MCP Apps gives the view no scale signal

- **Task:** author cards at the 768×480 base canvas and apply one root zoom (1.667 on a 1280×800 smart display), as the
  Layout and Visual Foundations pages say.
- **Steps:** applied `zoom: 1.667` from `hostContext.deviceClass`; the payment card's two "not confirmed" rows and the
  Pay button fell below the display. Probed heights per card:
  ```
  pros    {"zoom":"1","sh":587,"bodySh":575,"rootH":574.98,"vh":587} iframe 587px
  confirm {"zoom":"1.667","sh":669,"bodySh":389,"rootH":649.13,"vh":590} iframe 590px
  ```
  `documentElement.scrollHeight` includes the iframe viewport; `body.scrollHeight` is the unzoomed height; wrapping
  changes with zoom, so one measurement is not enough.
- **Expected vs actual:** the guide says Alexa scales the payload to fit; MCP Apps `hostContext` carries
  `containerDimensions` but no scale, and `deviceClass` is not a typed field (it passes only through the index signature).
- **Severity:** medium (the honest "not confirmed" rows must be on screen, SPEC §5).
- **Workaround:** the view zooms to the device class and reduces the zoom only as far as needed to fit
  `containerDimensions.maxHeight` (iterative, `views/card.ts` `fit()`); verify check B16 fails on any clipped card
  (mutation test: with the cap removed, B16 failed on all 8 cards, overflow 37–415 px).
- **Suggestion:** a `scale` or `deviceClass` field in `McpUiHostContext`, or a documented "host scales the iframe"
  contract.
- **Tool + version:** `@modelcontextprotocol/ext-apps` 2.0.0, Chromium (Playwright 1.63.0).

## 5. Node's built-in TypeScript is strip-only: parameter properties fail at load time

- **Command:** `node smoke1.ts` (importing `src/app/services.ts`)
- **Result:** `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode` on `constructor(readonly status: number, ...)`.
- **Severity:** low. **Workaround:** plain field + assignment. **Suggestion:** none (documented Node behavior); noting it
  because there is no typecheck step in this project, so such errors surface only when the file is first loaded.
- **Tool + version:** Node v26.10.0.

## 6. Alexa+ add-on tools are not open to entrants, so the Alexa+ experience is simulated

- **Task:** run the add-on inside Alexa+.
- **Result:** Alexa+ MCP add-ons are available to select partners only (Devpost confirmation on the hackathon Discord,
  2026-09-15; Amazon, 2026-10-09: submissions are "not evaluated as live production add-ons").
- **Severity:** high for a live demo, accepted by the rules.
- **Workaround:** our own web host (`host/`) with the official MCP client and MCP Apps AppBridge; deterministic
  utterance → tool mapping (no LLM); the README says so plainly.
- **Suggestion:** a public sandbox of the Alexa+ MCP client, or the Local Inspector as a downloadable tool.

## 7. The front door camera Partner API has no lock control

- **Task:** issue a time-boxed door code for the pro.
- **Result:** no lock/unlock operation in the Partner API documentation (checked 2026-10-10 on the api-reference,
  api-documentation, develop, FAQ and release-notes pages; motion and snapshot topics are present).
- **Severity:** low for v1. **Workaround:** the door code is shown and labelled "simulated (no lock API)" on the scope
  card and in the chip. **Suggestion:** a lock capability, or a documented hand-off to lock partners.

## 8. `registerAppTool` fails at request time for a tool without a UI resource

- **Task:** register `prepare_checkout`, a tool that deliberately has no card (the checkout screen belongs to Alexa+).
- **Command:** first `tools/call` after registering it with `registerAppTool(server, "prepare_checkout", { … })` and no
  `_meta.ui`.
- **Result:** `TypeError: Cannot read properties of undefined (reading 'ui')` inside `ext-apps/dist/src/server/index.js`,
  surfaced to the client as `-32603 Internal error` on `initialize` (the server is built per session).
- **Expected vs actual:** expected a plain tool, or an error at registration time; actual: a crash on the first request.
- **Severity:** low. **Workaround:** `server.registerTool` for tools without a card. **Suggestion:** validate at
  registration, or fall back to a plain tool.
- **Tool + version:** `@modelcontextprotocol/ext-apps` 2.0.0.

---

# From the first-day spike (2026-09-24)

## 9. Two current "official" TypeScript SDK lines; MCP Apps only works with the new one (spike FL-01, 2026-09-24)

- **Task:** Pick the official TypeScript SDK for a self-hosted MCP server (Streamable HTTP, spec ≥ 2025-11-25) that also exposes an MCP Apps UI (`ui://`).
- **Steps:** `npm view @modelcontextprotocol/sdk version` → `1.30.1` (dist-tag `latest`, modified 2026-09-23). `npm view @modelcontextprotocol/ext-apps version` → `2.0.0`. `npm view @modelcontextprotocol/ext-apps@2.0.0 peerDependencies` → `@modelcontextprotocol/core|client|server ^2.0.0`, `zod ^4.2.0`.
- **Expected:** One official SDK package that the MCP Apps SDK builds on, most likely the widely documented `@modelcontextprotocol/sdk`.
- **Actual:** Two lines are maintained in parallel: the v1 monolith `@modelcontextprotocol/sdk` 1.30.1 and the v2 split packages `@modelcontextprotocol/server|client|core|node` 2.x. `ext-apps` 2.x declares peers only on the v2 packages. The Node HTTP adapter lives in yet another package (`@modelcontextprotocol/node`), which peer-depends on `hono`.
- **Severity:** low.
- **Workaround:** Build on `@modelcontextprotocol/server@2.0.0` + `client@2.0.0` + `core@2.0.0` + `node@2.0.0` + `ext-apps@2.0.0`.
- **Suggestion:** Point the track's resources page directly at the ext-apps "Getting Started" install lines (they list the v2 packages). Add a banner on the `@modelcontextprotocol/sdk` npm page: "MCP Apps 2.x requires the v2 packages".
- **Tool + version:** `@modelcontextprotocol/sdk` 1.30.1; `@modelcontextprotocol/ext-apps` 2.0.0; `@modelcontextprotocol/server|client|core|node` 2.0.0.

## 10. SDK v2 README says "2026-07-28 spec", but the default negotiation is 2025-11-25, and that is documented only in JSDoc (spike FL-02, 2026-09-24)

- **Task:** Confirm that the server negotiates `protocolVersion` 2025-11-25, which the track rules require as the minimum.
- **Steps:** Read `node_modules/@modelcontextprotocol/server/README.md` ("v2 is the stable release line, implementing the 2026-07-28 MCP spec"). Then grepped the installed dist: `core/dist/auth-*.mjs` → `LATEST_PROTOCOL_VERSION = "2025-11-25"`; `client/dist/index.mjs` → `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`, `DEFAULT_VERSION_NEGOTIATION_MODE = "legacy"`. Confirmed live: `initialize` returns `"protocolVersion":"2025-11-25"`, and a client with `versionNegotiation: { mode: 'auto' }` falls back to 2025-11-25 against a session-based server.
- **Expected:** The README states which protocol version is negotiated by default and how to target 2025-11-25 (sessions) versus 2026-07-28 (stateless).
- **Actual:** The README mentions only 2026-07-28. The two-era model is explained only in the JSDoc of `ClientOptions.versionNegotiation`: legacy is the default, `auto` probes `server/discover` and falls back, and the server serves the modern era only through `createMcpHandler`. A reader could conclude that the SDK speaks only 2026-07-28, or that `Mcp-Session-Id` sessions are gone.
- **Severity:** medium.
- **Workaround:** Read the dist constants and assert the negotiated version in an automated check (two checks in our spike).
- **Suggestion:** Add a short README table: "2025-11-25 era: default, `initialize` + `Mcp-Session-Id` · 2026-07-28 era: opt-in, `server/discover` + per-request `_meta`, stateless". Say explicitly how an `auto` client treats a 2025-era server's answer to the `server/discover` probe: HTTP 401/403 and 5xx abort the connect, while other answers such as a 400 JSON-RPC error fall back to `initialize` (`classifyHttpError` in `client/dist/index.mjs`).
- **Tool + version:** `@modelcontextprotocol/server|client|core` 2.0.0.

## 11. "Minimum 2025-11-25" is not enforced by the default server (spike FL-03, 2026-09-24)

- **Task:** Make sure the server only speaks spec ≥ 2025-11-25, as the Alexa+ track requires.
- **Steps:** Raw HTTP against the default `McpServer` + `NodeStreamableHTTPServerTransport` (negative controls in our spike):
  `initialize` with `protocolVersion: "2024-11-05"` → `result.protocolVersion = "2024-11-05"` (HTTP 200).
  On a session negotiated at 2025-11-25, a request with `MCP-Protocol-Version: 2024-11-05` → HTTP 200 with a result.
  `MCP-Protocol-Version: 1999-01-01` → HTTP 400.
- **Expected:** A documented way to set a minimum protocol version. Ideally, a request whose header disagrees with the version negotiated for that session is rejected (spec: "invalid or unsupported `MCP-Protocol-Version` → MUST respond with `400 Bad Request`").
- **Actual:** The server downgrades silently. The header is validated against the global supported list (`2025-11-25 … 2024-10-07`), not against the session's negotiated version. The fix exists, `supportedProtocolVersions`, but it is documented only in the transport options JSDoc, which says you "typically don't need to set this option".
- **Severity:** medium.
- **Workaround:** `new McpServer(info, { supportedProtocolVersions: [LATEST_PROTOCOL_VERSION] })`. After that, an old `initialize` gets `"2025-11-25"` back, the old header gets HTTP 400, and the official client still connects.
- **Suggestion:** Document a "minimum protocol version" recipe. Consider validating `MCP-Protocol-Version` against the session's negotiated version.
- **Tool + version:** `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/node` 2.0.0.

## 12. A web host has to hand-build the sandbox-proxy origin; the SDK ships only `AppBridge` (spike FL-04, 2026-09-24)

- **Task:** Render an MCP Apps `ui://` resource in our browser-based Alexa+ simulator, spec-compliant.
- **Steps:** Read spec 2026-01-26 §Sandbox proxy ("If the Host is a web page, it MUST wrap the View … through an intermediate Sandbox proxy. The Host and the Sandbox MUST have different origins."). Used `AppBridge` + `PostMessageTransport` from `@modelcontextprotocol/ext-apps/app-bridge`. Ported `examples/basic-host/src/sandbox.ts` and the CSP header logic from `serve.ts` (tag v2.0.0), and served them from a second port with a CSP HTTP header.
- **Expected:** The package provides the sandbox proxy page or a helper, because the spec makes the proxy mandatory for every web host.
- **Actual:** Only example code exists. It hard-codes `http://localhost:8081/sandbox.html` and a localhost referrer regex. Every web host re-implements the relay, the ready/resource-ready handshake, origin checks and the CSP builder.
- **Severity:** low.
- **Workaround:** A ~50-line `sandbox.ts` plus a tiny static server on a second origin. It works: the card renders, the host cannot read the frame, and a CSP mutation blocks the view (checked in the spike).
- **Suggestion:** Export a `createSandboxProxy({ allowedHostOrigins })` helper and ship a prebuilt `sandbox.html` asset in `ext-apps`.
- **Tool + version:** `@modelcontextprotocol/ext-apps` 2.0.0 (examples at git tag v2.0.0).

## 13. A minimal MCP App view built on the official `App` class is about 600 KB (spike FL-05, 2026-09-24)

- **Task:** Ship a tiny notes card as a single-file `ui://` HTML resource.
- **Steps:** ~40 lines of view code importing `App` from `@modelcontextprotocol/ext-apps`, bundled and minified with esbuild 0.28.2 into one inline-script HTML.
- **Expected:** A small resource (tens of KB) that is cheap to `resources/read` on every render.
- **Actual:** `dist/card.html` = 600,094 bytes. `zod` and the protocol schemas come along with `App`. The published `app-with-deps.js` alone is 418,465 bytes.
- **Severity:** low.
- **Workaround:** Accepted for the spike; the build keeps one resource per card (entry 3). Options: cache the resource by URI on the host, or declare `ui.csp.resourceDomains` and load a shared script.
- **Suggestion:** Publish a slim `App` build that does not bundle full schema validation, or a documented CDN-hosted `App` script with the matching `ui.csp` recipe.
- **Tool + version:** `@modelcontextprotocol/ext-apps` 2.0.0, esbuild 0.28.2.

## 14. The Alexa+ setup page routes `@alexa-ai` packages to a private CodeArtifact registry without saying access is partner-only (spike FL-06, 2026-09-24)

- **Task:** Follow the public Alexa+ add-on setup page to get the `@alexa-ai` CLI.
- **Steps:** Read `developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html` (HTTP 200). Ran `npm view @alexa-ai/cli version` and `curl https://registry.npmjs.org/@alexa-ai%2fcli` on 2026-09-24 14:30Z.
- **Expected vs actual:** The page configures `.npmrc` for the `@alexa-ai` namespace through AWS CodeArtifact (`--domain-owner 372468808636 --region us-west-2 --namespace @alexa-ai`), so a reader expects the install to work after that step. On the public registry the package returns npm `E404` / HTTP 404. Access to the CodeArtifact domain needs an account enabled by Amazon (the forum shows a participant getting `AssumeRole AccessDenied` on the related role). The setup page itself doesn't say the tools are "select partners only"; that is stated on the add-ons home page and in the hackathon FAQ.
- **Severity:** Medium. A hackathon entrant loses time before learning the path is closed.
- **Workaround:** Our own web host simulator calls our self-hosted MCP server (the path the FAQ recommends).
- **Suggestion:** Put a "preview: select partners only" banner at the top of the setup page, next to the CodeArtifact step, with a link to the self-hosted MCP path.
- **Tool + version:** `@alexa-ai` packages (private CodeArtifact), npm 12.0.2.

## 15. Three different MCP protocol versions across the rules, the Alexa+ docs, and the MCP spec site (spike FL-07, 2026-09-24)

- **Task:** Decide which MCP protocol version our server must negotiate so it qualifies for the Alexa+ track.
- **Steps:** Read the Official Rules, the Alexa+ MCP Toolkit overview and client-lifecycle pages, and the MCP versioning page, on 2026-09-24.
- **Expected vs actual:** Expected one version. Actual: the rules say "2025-11-25 (or a later version, once confirmed)". `mcp-toolkit-overview.html` says "Alexa+ for Builders supports the 2025-11-25 version of the MCP specification". `mcp-toolkit-client-lifecycle.html` shows an `initialize` request and response with `"protocolVersion": "2025-03-26"`. modelcontextprotocol.io/specification/versioning says "The current protocol version is 2026-07-28".
- **Severity:** Medium. A builder can reasonably ship 2025-03-26 (copied from the lifecycle example) or 2026-07-28 (the current spec) and not know whether it counts.
- **Workaround:** The server supports 2025-11-25 and we show that negotiation in the demo. With the TypeScript SDK v2 we restrict `supportedProtocolVersions` so older clients can't downgrade it (see FL-03).
- **Suggestion:** Update the lifecycle example to 2025-11-25, and state in the rules whether 2026-07-28 is accepted.
- **Tool + version:** Alexa+ add-on docs (public pages, 2026-09-24), MCP spec 2025-11-25 and 2026-07-28.
- **Re-checked 2026-10-03:** still open, and worse than "three numbers". 2026-07-28 is a new protocol era: it removes the `initialize` handshake and sessions, and its own compatibility matrix says a legacy client against a 2026-07-28-only server "Fails. Legacy clients have no fall-forward mechanism". The rules link `modelcontextprotocol.io/docs/latest/...` now redirects to 2026-07-28, while the Alexa+ docs (66 add-on pages) never mention 2026-07-28 and show `initialize` examples with 2025-03-26 (client lifecycle) and 2025-06-18 (local inspector). A builder who follows the rules link can build a server the Alexa+ client cannot talk to. Workaround: serve 2025-11-25 as the baseline and 2026-07-28 on the same endpoint (dual-era). Suggestion: say in the rules that the server must answer `initialize` with 2025-11-25, and that dual-era servers qualify.

---
