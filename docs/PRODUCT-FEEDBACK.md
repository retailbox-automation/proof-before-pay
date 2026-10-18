# Proof Before Pay — product feedback

One section per tool we used, from building the add-on (2026-10-10). Concrete evidence for each point is in
FRICTION-LOG.md and in `npm run verify` (logs in `apps/proof-before-pay/logs/verify-latest.txt`).

## MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `client`, `node`) 2.0.0
- **What for:** the `proofpay` MCP server (8 tools, 6 UI resources) over Streamable HTTP; the browser host's MCP client;
  verify's protocol checks.
- **What worked:** strict 2025-11-25 with one option (`supportedProtocolVersions`), header validation done for us
  (verify N5–N7: old/unknown `MCP-Protocol-Version` → 400), Origin/Host guards as one-liners (N2: foreign Origin → 403),
  zod input schemas that reject bad input before our code runs (N10). Serving 2026-07-28 next to the sessionful 2025
  endpoint needed no protocol code of our own (`isLegacyRequest` + `createMcpHandler`), and `ctx.http.authInfo` reached
  the tool handler on both eras.
- **What didn't:** the dual-era pattern is documented only in `.d.mts` comments; version constants don't list
  2026-07-28 (FRICTION-LOG 1, 2).
- **Onboarding:** under an hour from the spike to a dual-era server, most of it reading type declarations.
- **Would build again:** yes.

## MCP Apps (`@modelcontextprotocol/ext-apps`) 2.0.0
- **What for:** six cards (`ui://proofpay/{pros,scope,payment,confirm,status,draft}.html`), rendered by our host
  through `AppBridge` + a sandbox proxy on a second origin.
- **What worked:** `registerAppTool` / `registerAppResource` on the server; on the host, the bridge lifecycle
  (proxy ready → resource ready → initialized → tool input → tool result → teardown) worked first time; `ui/message`
  lets a tap on a card CTA ("Pay $1,050") arrive as the user's next turn (verify B8); the cross-origin sandbox holds
  (B11: host cannot read the card).
- **What didn't:** ~612 KB per view, 442 KB of it zod (FRICTION-LOG 3); no scale signal in `hostContext`, so the view
  fits itself (FRICTION-LOG 4).
- **Onboarding:** quick, thanks to the `basic-host` example in the package.
- **Would build again:** yes; would like a slim `App` build.

## Alexa+ MCP add-on design guide (pages copied 2026-10-03)
- **What for:** card forms (List, Card), one title, 1–2 fields per row, one action per item, ≤ 5 rows, base canvas
  768×480 with a 1.667 root zoom on 1280×800, voice-first replies, booking and purchase policies (§3, §9, §15, §16).
- **What worked:** precise, testable rules; we turned several into verify checks (B6 ≤ 5 rows with a source on every
  evidence row, B12 lines ≤ 20 s, B13 no brand names on cards, B16 cards fit the display).
- **What didn't:** "Alexa scales your payload" and "author at 768×480 with one root zoom" pull in different directions
  when the card is shown next to a conversation; the guide does not say who owns fitting (FRICTION-LOG 4).
- **Would build again:** yes.

## Alexa+ Home Services SPI (shapes, used by our sandbox marketplace)
- **What for:** the marketplace side of the demo: ListProfessionals, CreateBooking ESTIMATE → CONFIRMATION with
  `alexaBookingId`/`partnerBookingId`, CancelBooking, partial capture.
- **What worked:** ESTIMATE → CONFIRMATION maps cleanly onto the voice read-back required by §15 (book_job
  `confirm=false` / `confirm=true`).
- **What didn't (ours):** our sandbox booking does not yet carry the SPI's booking cancellation `policy`; the add-on
  states its own fact instead ("nothing is charged before the work is proven").
- **Would build again:** yes.

## Alexa+ checkout (UCP-shaped partner endpoints; docs snapshot 2026-10-03, re-checked 2026-10-10)
- **What for:** the payment step. The add-on's `prepare_checkout` stages the proven items; our host plays Alexa+ and calls
  `POST /checkout-sessions` → `PUT` → `POST …/complete` on the sandbox partner backend.
- **What worked:** the contract is precise enough to test: `Idempotency-Key` replay and 409 (verify K4, K7), decline as
  HTTP 200 `incomplete` + `payment_failed` (K6), stored-card handler with brand + last_digits (K5), refund-policy link
  title shown before paying (B8). "Payment belongs to Alexa+" made the add-on simpler: no PIN, no card, no payment UI.
- **What didn't:** no partial capture or invoice concept, so "pay the proven part" is modelled as one session with only
  the proven items; whether a second session per booking is allowed for the waiting part is an open question.
- **Would build again:** yes.

## Front door camera Partner API (webhook v1.1 format, simulated)
- **What for:** arrive/leave timestamps for a consented booking window, delivered as signed webhooks; history API as
  a fallback.
- **What worked:** HMAC over the raw body is simple to verify correctly (verify W1: wrong key, one changed byte, no
  header → 401, nothing stored); events outside a consented booking window are dropped, not kept (W2, and the demo's
  8:30 AM mail-carrier motion).
- **What didn't:** no lock control, so the door code is a labelled simulation (FRICTION-LOG 7).
- **Would build again:** yes, with consent per job and timestamps only.

## Playwright 1.63.0
- **What for:** verify plays every beat headless through two nested iframes (host → sandbox proxy → view), asserts
  card numbers inside the inner frame, saves `docs/screens/proof-before-pay/beat-<n>.png`.
- **What worked:** `frameLocator` chains through the cross-origin proxy without special setup.
- **Would build again:** yes.

## esbuild 0.28.2 and Node 26 type stripping
- **What for:** bundling host, proxy and views; running `.ts` directly with `node`.
- **What worked:** zero-config runs; builds in under a second.
- **What didn't:** strip-only TypeScript rejects parameter properties at load time (FRICTION-LOG 5).
- **Would build again:** yes.

Author's history: see BACKTEST.md
