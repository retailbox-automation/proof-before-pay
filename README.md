# Proof Before Pay

**Hire a licensed pro by voice, and pay only for the work that is proven.** An Alexa+ add-on (MCP server with MCP Apps
cards) for the Amazon "Build, Ship, Shape" hackathon, Alexa+ track.

**Live demo:** https://proofpay.retailbox-automation.com/ — press **Play demo**. Every visitor gets their own simulated
household and their own sandbox, so several people can play it at the same time. The MCP endpoint of the same deployment
is `https://proofpay.retailbox-automation.com/mcp` (see "Try the MCP server directly").

The add-on leaves out pros whose license is not in Florida's license registry, writes the scope item by item with what
proves each item, logs the visit at the front door with both sides' consent, checks the invoice with fixed rules (no
model), and prepares a checkout for the proven part only. Alexa+ takes the payment; the rest waits for the homeowner.

All businesses, people and places in the demo are fictional. **The Alexa+ experience is simulated in our web host**:
Alexa+ MCP add-ons are open to select partners only, so we run the add-on in our own Echo Show 8 simulator (a generic
1280×800 frame, no logos) with the official MCP client and MCP Apps bridge. The host maps utterances to tools with fixed
patterns (no LLM); in the real product Alexa+ supplies the language understanding.

## Run it (2 commands, offline)
```
npm ci
npm run demo        # open http://127.0.0.1:5178/ and press "Play demo"
```
Node 24 or newer (tested on Node 26.10.0). `npm run verify` runs all 75 checks and every beat in headless Chromium
(first time: `npx playwright install chromium`); exit code 1 on any failure. No credentials needed.

## Where the track technology is used
| Technology | Import | Call on the demo path |
|---|---|---|
| MCP TypeScript SDK v2, server (`@modelcontextprotocol/server` 2.0.0) | `server/tools.ts:16` | `new McpServer` `server/tools.ts:161` (2025-11-25 only on the session leg: `supportedProtocolVersions` `server/tools.ts:164`) |
| Streamable HTTP transport, 2025-11-25 sessions with `Mcp-Session-Id` (`@modelcontextprotocol/node`) | `server/server.ts:16` | `new NodeStreamableHTTPServerTransport` `server/server.ts:142` |
| 2026-07-28 on the same endpoint (SDK era routing, no hand-written protocol code) | `server/server.ts:15` | `createMcpHandler(...)` `server/server.ts:90`, `isLegacyRequest` in the request handler |
| MCP Apps, server side (`@modelcontextprotocol/ext-apps` 2.0.0) | `server/tools.ts:17` | `registerAppTool` `server/tools.ts:174`, `registerAppResource` `server/tools.ts:464` |
| MCP client in the Echo Show simulator (`@modelcontextprotocol/client`) | `host/host.ts:13` | `new StreamableHTTPClientTransport` `host/host.ts:201` |
| MCP Apps host bridge (`ext-apps/app-bridge`), cards on a second origin | `host/host.ts:14` | `new AppBridge` `host/host.ts:270`; sandbox proxy `host/sandbox.ts` |
| Alexa Skills Kit (`ask-sdk-core` 2.14.0), the same MCP server from a real device | `skill/src/handler.ts:8` | `SkillBuilders.custom()` `skill/src/handler.ts:276`; MCP `callTool` `skill/src/proofpay.ts:73` |
| Florida license registry (live, with recorded pages) | `src/core/registry/lookup.ts:103` | `src/app/services.ts:253` from `find_pros` / `review_invoice` |
| Front door camera events (Ring Partner API webhook v1.1 format, HMAC over raw bytes) | `src/core/doorbell/hmac.ts:14` | `POST /webhooks/doorbell` `server/webhook.ts:31` |
| Deterministic invoice check (`reconcile-v1`, no model) | `src/core/reconcile.ts:139` | `src/app/services.ts:330` from `review_invoice` |

Independent check with the official MCP Inspector CLI (`@modelcontextprotocol/inspector@2.8.0`, 2026-10-18), both
eras: `tools/list --strict` → 8 tools, 0 schema problems; `--app-info` → 7 of the 8 tools link a `ui://proofpay/*.html`
card (`prepare_checkout` has none on purpose: the checkout screen belongs to Alexa+). Outputs: `docs/inspector-2026-10-18/`.

## Beats → MCP tools → cards
| Beat | User says | What runs | What the customer sees |
|---|---|---|---|
| 1 | "Alexa, I need a licensed electrician to replace outlets and smoke detectors in the master bath." | `find_pros` | pros card: the unlicensed pro struck "not found in Florida license registry" |
| 2 | "Book Bright Current." → "Yes." | `book_job` (`confirm=false` reads back, `confirm=true` books) | scope card: 3 items + "+3 more", "to be paid after the work is proven", visit-log consent, simulated door code, cancellation policy |
| — | button "Simulated time → Thu 2:15 PM" | sandbox clock → signed camera webhooks → `POST /webhooks/doorbell` | "simulated time" badge |
| 3 | "He sent the invoice. Pay him." | `review_invoice` | pre-checkout card: "Pay now $1,050.00 · Waits $370.00", evidence rows with sources, button "Pay $1,050.00" |
| 4 | tap "Pay $1,050.00" (MCP Apps `ui/message` "Pay for this order") → "four seven one nine" | `prepare_checkout` (no payment data), then **Alexa+ checkout · simulated** in the host | platform layer over the dimmed card: seller, 5 proven items, totals, "Visa ending 4242" (sandbox), refund policy, voice code shown as ••••, "Order confirmed" |
| 5 | New session → "What's left with the electrician?" → "Yes, draft it." | `job_status`, `draft_note` | status card (paid through Alexa+ checkout, two open items); a draft note the homeowner sends |
| 6 | "Simulated time → Nov 12", New session → "The master bath outlet stopped working again." → "Yes, book it." | `warranty_callback` | warranty card: 90-day labor warranty; $0.00 return visit; scope, 2 photos and the visit log attached |
| any | "Cancel the booking." → "Yes." | `cancel_booking` | booking and cancellation policy read back before cancelling |

Screens of every beat: `docs/screens/beat-1.png` … `beat-6.png`.

## What is live, fixture, sandbox, simulated
The developer view next to the device shows a badge on every step of every tool call.

| Mode | What | Code |
|---|---|---|
| LIVE | Florida license registry (public DBPR search). In the hosted demo, the unlicensed pro's number (`EC99000103`) is looked up live on every search because it is listed in `REGISTRY_LIVE_NUMBERS=EC99000103`; the registry answers "no records", the same verdict as the recorded page. `REGISTRY_MODE=auto` alone would not go live for the demo pros: it uses the recorded page for any number that has one, and all three do. Live answers are cached for 10 minutes. A network error or an unexpected page is never turned into "verified": the lookup returns "unavailable", and the app falls back only to a recorded page it already has, labelled as recorded ("live registry unavailable …; recorded page …"). | `src/core/registry/lookup.ts`, `src/app/services.ts` |
| FIXTURE | Recorded registry pages for the two fictional licensed pros (`EC99000101`, `EC99000102`): a real results page with every name, address and number replaced by fictional values. Their numbers are fictional, so the live registry has no record of them (EVIDENCE E9): their "Verified" always comes from these recorded pages, and with `REGISTRY_MODE=live` they would come back "not found". Everything is fixture in the offline `npm run demo`. | `fixtures/registry/` |
| SANDBOX | Marketplace in Home Services SPI shapes, invoice and photos, checkout sessions, saved card "Visa ending 4242", warranty claims, saved job state. No real money moves. | `src/sandbox/`, `server/` |
| SIMULATED | Alexa+ checkout (the host plays the platform), front door camera events and webhooks (Partner API v1.1 format, HMAC-signed), clock jumps, the door code (the camera API has no lock control). | `host/`, `src/sandbox/` |

## Payment belongs to Alexa+
The add-on never takes a voice code, a card or any payment data. `prepare_checkout` stages a checkout session whose line
items are only the proven items ($1,050.00); the $370 that waits is not in it. The host then plays Alexa+: it calls the
partner's UCP-shaped checkout endpoints, reads back the order, checks the 4-digit voice code (sandbox code `4719`) and
completes the session. The partner side enforces `Idempotency-Key`, returns a decline as `incomplete` +
`payment_failed`, accepts only the proven items at their prepared prices, and refuses a session whose total no longer
matches the plan it was prepared from. The add-on learns that the order was paid by reading the session.

## Try the MCP server directly
```
curl -s -X POST https://proofpay.retailbox-automation.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer pbp-sandbox-your-name' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
Account linking is simulated: any `Bearer pbp-sandbox-<name>` is an account with its own state and its own sandbox.
The Alexa skill endpoint of the deployment is `https://proofpay.retailbox-automation.com/alexa`; it verifies Amazon's
request signature and timestamp and refuses anything else.

## Hosted deployment
`npm run public` (`scripts/public.ts`) runs the same servers behind one port: `/` simulator, `/mcp` MCP server,
`/sandbox/t/<account>/…` that account's sandbox tenant, `/alexa` skill endpoint, `/healthz`. The cards are served from a
second origin (`CARDS_ORIGIN`), as MCP Apps requires for web hosts. `Dockerfile` builds it. There are no secrets in the
deployment; the camera webhook signing key is generated at start. The `echo-*` accounts belong to the real Echo Show
(the skill reaches the MCP server inside the container), so the public side refuses them; the operator resets or moves
that demo's clock from inside the container with `node scripts/sandbox-admin.ts reset|demo|warranty`.

## How AI was used
- **In the product:** no model anywhere in the demo path. The invoice check is fixed rules (`reconcile-v1`), the
  license check reads the state registry, and the simulator maps utterances to tools with fixed patterns. In the real
  product, Alexa+ supplies the language understanding.
- **In the build:** the code, tests and documents were written with an AI coding assistant, directed and reviewed by
  the author; every claim in the docs is checked by a command (`npm run verify`, `docs/EVIDENCE.md`). The card and
  simulator designs were first drawn as reference images with an image model, then built in HTML and compared with
  the references.

## Why it matters
- Author's history: "Since we closed on our house in July, I've been in touch with 118 contractors and home-service
  companies and booked 13 jobs. Five went wrong." — [docs/BACKTEST.md](docs/BACKTEST.md) (anonymized ledger, 141 engagements; all 5
  caught by at least one gate).
- "Florida received 4,847 unlicensed-activity complaints in one year." — Florida DBPR, ULA Report FY 2024-25, p.13.
- "Florida paid $4.35 million in 2025 to homeowners harmed by licensed contractors." — Florida DBPR, 2025
  Accomplishments (posted 2026-01-07).
- "Americans filed 81,925 home-repair reports with the FTC in 2024." — FTC Consumer Sentinel Network Data Book 2024.

## More
- Build spec: `docs/SPEC.md` (§7 supersedes §1/§4/§5 where they conflict) · evidence for every claim: `docs/EVIDENCE.md`
- Friction log (15 entries): `docs/FRICTION-LOG.md` · product feedback: `docs/PRODUCT-FEEDBACK.md` · feature
  requests: `docs/FEATURE-REQUESTS.md`
- Alexa skill on a real Echo Show: `skill/README.md`
- The license check as a standalone open-source package: [fl-license-check](https://github.com/retailbox-automation/fl-license-check)
- Font: Inter from `@fontsource/inter` 5.2.8, SIL Open Font License 1.1, served locally (no Google Fonts request).

| Port / env | Default | What |
|---|---|---|
| `MCP_PORT` | 8787 | proofpay MCP server (`/mcp`, `/webhooks/doorbell`, `/healthz`) |
| `HOST_PORT` | 5178 | Echo Show 8 simulator |
| `SANDBOX_PROXY_PORT` | 5179 | card sandbox proxy (second origin) |
| `SANDBOX_PORT` | 8791 | sandbox services (`/spi`, `/checkout-sessions`, `/partner`, `/ring`, `/sim`) |
| `REGISTRY_MODE` | `fixture` | `fixture` \| `live` \| `auto` (`auto`: recorded page when there is one, live otherwise) |
| `REGISTRY_LIVE_NUMBERS` | — | numbers that always go to the live registry, with fallback to their recorded page |

## License
MIT — see [LICENSE](LICENSE).
