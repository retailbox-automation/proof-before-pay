# Proof Before Pay — friction log

What got in the way while building the add-on, with the exact command and what we saw. Severity: high = blocks the
product, medium = cost hours or forced a design change, low = minutes.

Environment for every entry unless noted: macOS, Node v26.10.0, `@modelcontextprotocol/{server,client,node,core}` 2.0.0,
`@modelcontextprotocol/ext-apps` 2.0.0, Playwright 1.63.0 (Chromium headless), esbuild 0.28.2. Dates are 2026-10-10.

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

## 3. Each MCP Apps view is ~591 KB because the `App` class pulls in all of zod

- **Task:** ship each card as one self-contained HTML file (design guide: "single HTML file with all dependencies
  inlined"; keep payloads light).
- **Command:** `node build.ts` → `dist/views/{pros,scope,payment,confirm,status,draft}.html (591 KB each)`;
  gzip of one view: `gzip -c dist/views/pros.html | wc -c` → `131565`. esbuild metafile of `views/card.ts`:
  ```
  zod 442KB
  @modelcontextprotocol/client 96KB
  @modelcontextprotocol/ext-apps 30KB
  @modelcontextprotocol/core 16KB
  views 4KB
  ```
- **Expected vs actual:** our own view code is 4 KB; 75% of the payload is schema validation the view never needs.
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
