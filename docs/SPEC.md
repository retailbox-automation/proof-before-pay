# Proof Before Pay — build spec (v1, 2026-10-10)

Alexa+ track, Amazon "Build, Ship, Shape". Alexa+ experience simulated in our web host (no real Alexa+ integration exists for entrants). MCP 2025-11-25 over Streamable HTTP.

**One line:** a homeowner hires a pro through Alexa; the add-on drops pros whose license is not in the state registry, writes the scope item by item with what proves each item, logs the visit at the front door with the pro's consent, checks the invoice against the scope with deterministic rules, and offers to pay only what is proven. The rest waits for the homeowner.

All businesses, people and places in the demo are fictional. Real-world data appears only in two places: the live Florida license registry (any license number a user types) and the anonymized backtest of the author's own contractor history (`data/backtest/`).

## 1. Demo (first 60 s, max 5 beats, one time jump)

Video opens with the end state of beat 3 (payment card), then plays the beats in order. Voice lines are Alexa's words, shown as subtitles with their length in seconds (2.5 words/s).

| # | User says | Tools (chips) | Alexa says (≤ 20 s) | Card |
|---|---|---|---|---|
| 1 | "Alexa, I need a licensed electrician to replace outlets and smoke detectors in the master bath." | `proofpay.find_pros` → steps: marketplace ListProfessionals (sandbox) · license lookup ×3 (fixture for P1/P2, live or fixture for P3) | "I found three electricians nearby. Quick Volt's license number isn't in Florida's registry, so I left them out. Bright Current is licensed, 4.8 stars, 1,120 dollars. Want them?" | **List**: P1, P2 (rating, estimate, "License EC99000101 · active to 08/31/2028 · Florida DBPR"), P3 struck: "License EC99000103 not found in Florida DBPR (checked <time>)" |
| 2 | "Book Bright Current." → (confirm) "Yes." | `proofpay.book_job` (confirm=false, then true) → marketplace CreateBooking ESTIMATE → CONFIRMATION (sandbox) | (before) "Bright Current, Thursday 10 to noon, six items for 1,120 dollars. You pay only for items proven by a photo. They agreed your front door camera logs when they arrive and leave. Should I book it?" (after) "Booked. The confirmation is on your home card." | **Card** (scope): title "Master bath electrical · Thu 10–12"; 3 item rows + "+3 more"; "Proof: photo per item"; "Visit log: pro agreed ✓ — arrive/leave only, no video kept"; "Door code: Thu 9:30–1:00 · simulated (no lock API)"; action "Cancel booking" |
| — | (button) simulated time → Thu 2:15 PM | sandbox clock advance: camera webhooks (Ring Partner API v1.1 format, HMAC verified), invoice + photos posted | — | time badge "simulated time" |
| 3 | "He sent the invoice. Pay him." | `proofpay.review_invoice` → steps: marketplace invoice (sandbox) · camera events (fixture, signature ✓) · photos (sandbox) · license re-check · `reconcile-v1` (deterministic rules, no model) | "Five of six items are proven by photos taken during the visit. The hallway smoke detector has no photo yet, and a 300-dollar inspection line wasn't in the scope. I can pay 1,050 now. 370 waits for your OK." | **Card** (payment): "Pay now $1,050.00 · Waits $370.00"; evidence rows with source: ✓ license (Florida DBPR) · ✓ visit 10:02–11:40 (front door camera) · ✓ 5 photos match items · ✗ not confirmed: hallway smoke detector, no photo · ✗ not in scope: "Electrical inspection" $300; action "Pay $1,050" |
| 4 | "Pay the proven part." → "four seven one nine" (masked as ••••) | `proofpay.pay_proven` (no code → confirm card; with code → capture) → marketplace partial capture (sandbox) | (before) "1,050 dollars to Bright Current with your card on file. Refunds follow Bright Current's policy on the card. Say your four-digit voice code." (after) "Paid 1,050 dollars, sandbox. The receipt is on your home card. The other 370 stays unpaid until you say so." | **Confirm**: amount, payee, card on file "•• 42 (sandbox)", cancellation/refund policy line, "Voice code required"; then receipt |
| 5 (after 60 s) | New session → "What's left with the electrician?" → "Yes, draft it." | `proofpay.job_status` · `proofpay.draft_note` | "Two things: the hallway smoke detector needs a photo, and you haven't decided on the 300-dollar inspection line. Want a draft note to Bright Current?" | **Card** status from saved state; then draft note card (homeowner sends it; we never send) |

### Demo numbers (cents in code)
Scope (job J1, pro P1, permit not needed, consent granted by pro and homeowner):

| id | item | price | proof |
|---|---|---|---|
| S1 | Replace 12 standard outlets | $360.00 | photo |
| S2 | Install 2 GFCI outlets in master bath | $190.00 | photo |
| S3 | Replace 6 light switches | $150.00 | photo |
| S4 | Replace 3 bedroom smoke detectors | $210.00 | photo |
| S5 | Replace hallway smoke detector | $70.00 | photo |
| S6 | Restore master bath fan circuit | $140.00 | photo |

Scope total $1,120.00. Invoice = the six scope lines (each with `scopeItemId`) + "Electrical inspection" $300.00 (SERVICE, no `scopeItemId`) = $1,420.00. Photos: S1, S2, S3, S4, S6 tagged and taken between 10:05 and 11:35; S5 none. Camera: `button_press` 10:02, `motion_detected` sub_type human 10:02 … 11:40. Expected plan: payNow 105000, waits 37000 (S5 7000 unproven + 30000 not in scope), blockers [], notConfirmed has exactly 2 entries.

Pros: P1 "Bright Current Electric" EC99000101 (fixture: found, active, name match), $1,120, 4.8 (212). P2 "Harbor Line Electrical" EC99000102 (fixture: found, active), $1,260, 4.6 (98). P3 "Quick Volt Pros" EC99000103 → not found (live: verified 2026-10-10 that EC99000101/102/103 return 0 records). Fixture HTML for "found" is a real DBPR results page with every name, address, number and id replaced by fictional values (`fixtures/registry/dbpr-found.sample.html`); "not found" is a real empty results page.

## 2. Architecture

```
host simulator (5178) ──MCP 2025-11-25 Streamable HTTP──▶ proofpay MCP server (8787 /mcp)
   │  cards in sandboxed iframe (5179, second origin)            │ HTTP
   │                                                             ├─▶ Florida DBPR (live) | registry fixtures
   └─ "simulated time" ──▶ sandbox services (8791)  ◀────────────┤
                            /spi/*   marketplace, Home Services SPI shapes (sandbox)
                            /ring/*  Ring Partner API simulator: history API + webhook emitter (HMAC)
                            /sim/*   clock, reset
                            ──webhook POST, X-Signature: sha256=…──▶ proofpay /webhooks/doorbell
```
- Base URLs from env (`SPI_BASE`, `RING_API_BASE`, `RING_SIGNING_KEY`, `REGISTRY_MODE=fixture|live|auto`), so the Ring simulator can be swapped for `https://api.amazonvision.com` and a Playground token without code changes.
- `npm run demo` is fully offline (`REGISTRY_MODE=fixture`). `REGISTRY_MODE=auto` = fixture for numbers present in fixtures, live for any other number. No LLM anywhere; the host maps utterances to tools with deterministic patterns (Alexa+ supplies language understanding in the real product).
- Every tool result carries `_meta.steps: Array<{ service, op, mode: SourceMode, ms, summary }>`; the host renders one chip per tool call plus one sub-chip per step with a mode badge (LIVE / FIXTURE / SANDBOX / SIMULATED).

## 3. Core modules (pure logic first, I/O at the edges) — owner: core build

Types: `src/core/types.ts` (shared contract; change only by agreement).

### 3.1 `src/core/reconcile.ts` — `reconcile(scope, invoice: Charge[], evidence, opts?: { photoSlackMs?: number }): PaymentPlan`
Deterministic. Same input → byte-identical output. Rules, in order:
1. Job-level blockers (any → payNow 0 for every line, all waits): license verdict ≠ "verified"; consent not granted when any item needs "visit"; no visit evidence (arrivedAt null) when any photo rule depends on the visit window.
2. Line → scope item: by `scopeItemId`; else deterministic description match (normalize: lowercase, strip punctuation and stop words; token Jaccard ≥ 0.6, best unique match); else `not_in_scope`.
3. Second line for an already matched item → `over_scope` (amount waits).
4. Amount above scope price → `over_scope`: proven part pays up to the scope price, the excess waits.
5. Proof "photo": ≥ 1 photo tagged with the item id, taken within [arrivedAt − slack, leftAt + slack] (slack default 15 min) when a visit window exists; photo outside the window → `unproven` with reason. Proof "visit": arrivedAt and leftAt present.
6. `notConfirmed`: one plain sentence per unproven / not_in_scope / over_scope line and per blocker. Never empty when waits > 0.
Tests: the demo case (exact numbers above); no license → all waits; consent missing; photo outside window; duplicate line; over-price line; description-only matching; empty invoice; determinism (run twice, deep-equal).

### 3.2 `src/core/registry/` — Florida DBPR license lookup
- `parseDbprResults(html): { asOf: string | null; records: LicenseRecord[] }` — rows of the results table ("Search Results - N Records"; columns License Type, Name, Name Type, License Number/Rank, Status/Expires; "Data Contained In Search Results Is Current As Of …" when present). Test on both fixture files.
- `nameMatch(claimed, names[])`: uppercase, strip punctuation, `&`→AND, drop LLC/INC/CORP/CO/COMPANY/SERVICES/SERVICE/GROUP; equal → match; token Jaccard ≥ 0.5 → partial; else mismatch.
- `lookupLicense(number, claimedName, { mode, fetchImpl?, now?, fixtures })`: live flow = GET `https://www.myfloridalicense.com/wl11.asp?mode=0&SID=` → POST `wl11.asp?mode=1&SID=&brd=&typ=` body `hSearchType=&SearchType=LicNbr&SelectSearchType=Search` → POST `wl11.asp?mode=2&search=LicNbr&SID=&brd=&typ=` body `hSearchType=LicNbr&hDivision=ALL&LicNbr=<n>&Board=&LicenseType=&SpecQual=&RecsPerPage=10&Search1=Search`; keep cookies between calls; browser User-Agent; 8 s timeout per call; one lookup at a time. Network error or unexpected page → verdict "unavailable" (never "verified"). Source = `{ service: "Florida DBPR license search", mode, ref: <url>, asOf }`.
- Unit tests must not hit the network (inject `fetchImpl`). One opt-in live test behind `LIVE=1`.

### 3.3 `src/core/doorbell/` — front door camera events (Ring Partner API format)
- Builders for webhook payloads exactly as documented (v1.1): `motion_detected` (`data.id = <device>_motion_<ts>`, attributes source, source_type "devices", timestamp, timestamp_readable, sub_type) and `button_press`; `meta { version: "1.1", time, request_id, account_id }`.
- `sign(rawBody, key) → "sha256=<hex>"`, `verify(rawBody, header, key)` with constant-time compare over the raw bytes (never re-serialized JSON).
- History API shape: `{ data: [{ type: "history-events", id, attributes: { event_type: "motion"|"ding"|"on_demand", start, end }, relationships.source.data { type: "devices", id } }], links.next }`.
- `visitWindow(events, booking: { start, end }, consentGranted): VisitWindow` — arrival = first `button_press`/`ding` or human motion from 60 min before start to 120 min after end; departure = last human motion after arrival in that span. Consent not granted → nulls, reason in source. Only timestamps are used: no video, no faces, no recognition.

### 3.4 `src/sandbox/server.ts` — sandbox services (port 8791)
Marketplace (`/spi/ListProfessionals`, `/spi/CreateBooking` with `stage` ESTIMATE|CONFIRMATION and `alexaBookingId`/`partnerBookingId`, `/spi/GetBooking`, `/spi/CancelBooking`, `/spi/invoice/:partnerBookingId`, `/spi/photos/:partnerBookingId`, `/spi/capture` partial capture), Ring simulator (`/ring/v1/history/devices/:id/events` with `Authorization: Bearer sandbox`), clock (`GET /sim/clock`, `POST /sim/advance { to }` emits due webhooks to `ADDON_WEBHOOK_URL` signed with `RING_SIGNING_KEY`, makes invoice/photos visible after the visit; `POST /sim/reset { scenario }`). Scenario data: `fixtures/demo/scenario.json`. Deterministic ids.

### 3.5 Backtest — `scripts/backtest.ts`
Reads `data/backtest/engagements.anon.json` (anonymized ledger of the author's real contractor history, supplied separately — no names, phones, addresses, license numbers), applies gate rules (license gate, scope gate, visit gate, proof-before-payment gate) and prints/writes `docs/BACKTEST.md`: per gate how many real failures it would have caught, which it would not, and why. `npm run verify` re-runs it and fails if the published numbers differ.

## 4. App — owner: app build
- `server/server.ts` → MCP server `proofpay` (SDK v2, `@modelcontextprotocol/server` 2.0.0, strict 2025-11-25; serve 2026-07-28 from the same endpoint only if the SDK does it without hand-written protocol code, else FRICTION-LOG entry). Tools: `find_pros`, `book_job`, `cancel_booking`, `review_invoice`, `pay_proven`, `job_status`, `draft_note`. Plus `POST /webhooks/doorbell` (raw-body HMAC verify, store event, attach to the job by booking window + consent).
- State per user (JSON file, atomic rename): jobs, scope, consent, stored camera events, plans, payments. Survives a new MCP session and a server restart.
- MCP Apps views (`ui://proofpay/<view>.html`): pros list, scope, payment, confirm/receipt, status, draft note. Design guide forms: List / Card; one title, 1–2 fields, one action per item; max 5 rows ("+N more" beyond 3 on the scope card). Every evidence row shows its source and mode.
- Host = Echo Show simulator: 1280×800 frame; text input (optional Web Speech); subtitles with seconds; chip per tool call + sub-chips per step with mode badges; card in sandboxed iframe from the second origin; "New session" (drops MCP session, keeps user state); "simulated time" button (calls sandbox `/sim/advance`); voice-code utterances masked as ••••; "Play demo" button that runs beats 1–5 with fixed pacing for recording.
- `npm run demo` (build, start sandbox + server + host, open the host) and `npm run verify`: protocol checks (initialize → 2025-11-25, tools/list, every tool, ui:// readable, state survives New session and restart, unknown session → 404, foreign Origin → 403, webhook with bad signature → 401 and not stored), core unit tests, backtest numbers, headless browser run of every beat with a screenshot per beat in `docs/screens/` and assertions on card numbers. PASS/FAIL table, non-zero exit on failure.

## 5. Policy and honesty (must hold in code, cards and video)
- §15 Bookings: read back booking details by voice before booking; written confirmation on the home card; cancel any time, including in a later session (`cancel_booking`).
- §16 Purchases > $100: voice confirmation + 4-digit voice code + written confirmation; refund/cancellation policy shown before paying; pre-configured payment method only (card on file, sandbox).
- §9 Attribution: every fact names its source ("According to Florida's license registry…"); no legal advice; the draft note is plain, the homeowner sends it.
- §3 Data: only arrive/leave timestamps from the camera, retained for the job only; one-time permission prompt text in the README.
- Ring Content Policy §1.2.1: logging is tied to one job, consented by both sides on the booking, shows timestamps only, no person tracking, no face recognition.
- Door code is a simulation (Ring Partner API has no lock control) and is labelled so on the card.
- Payment wording: "Pay proven items now, the rest after you confirm." Never "hold" as an agent action; no escrow claim; sandbox label on every payment card.
- At least one honest "not confirmed" on screen in the demo (S5).

## 6. Cut list (not in v1)
Multiple trades, real marketplace, real lock, permit lookup beyond a flag, disputes through a platform, a pro-side app, LLM extraction of PDF invoices, Ring track submission (decision 2026-09-01 skips hardware tracks; reopening is the owner's call).

---

## 7. v2 — changes after the research pass (2026-10-10, supersede §1/§4/§5 where they conflict)

Source: our research notes (not published; file:line citations into snapshots of the public Alexa+ docs of 2026-10-03, re-checked live 2026-10-10).

### 7.1 Payment belongs to Alexa+ (blocking)
Alexa+ docs: "The checkout flow is owned by Alexa+. Alexa+ handles voice PIN, payment instrument selection, and purchase confirmation — you don't implement payment UX." and "Don't implement payment UI (no card entry, no wallet display, no PIN prompts)", "Don't use tools/call for payment actions" (`implement-checkout-endpoints.txt:213, :236-237`).
- The add-on's payment card (beat 3) is the **pre-checkout** card: two stacks (proven / waits), evidence rows, and a price breakdown for the proven part (Subtotal $1,050.00 · Fees $0.00 · Total $1,050.00). Its button "Pay $1,050.00" sends an MCP Apps `ui/message` with text "Pay for this order" (touch path), never `tools/call`.
- `pay_proven` is removed. New tool `prepare_checkout` (no payment data, no code): creates a checkout session in the sandbox partner backend whose `line_items` are only the proven items (S1, S2, S3, S4, S6 = $1,050.00) and returns the session id + summary. The $370 is not in the session and is never shown as a discount.
- New host layer **"Alexa+ checkout · simulated"** (drawn by the host, outside the add-on iframe, over the dimmed card): reads back seller, the five line items, totals, "Visa ending 4242 · sandbox", link "Refund policy · Bright Current Electric", asks for the 4-digit voice code (masked ••••), then calls the sandbox UCP-shaped endpoints itself: `POST /checkout-sessions` → `PUT` → `POST /checkout-sessions/{id}/complete` with `Idempotency-Key` (24 h replay; different body → 409; decline → 200 `status: incomplete` + `payment_failed`; amount must equal the reconcile plan's proven total, checked by plan hash) and shows "Order confirmed". Stored card handler id `partner_card_on_file` (brand + last_digits). Merchant of record: the pro via the marketplace, not Alexa.
- Voice line (beat 4, platform voice): "Paying 1,050 dollars to Bright Current with Visa ending 4242. Say your voice code." → "Order confirmed. The other 370 stays unpaid until you say so."
- Later, after the homeowner's OK for a waiting item, a second checkout session is created for that item only (design inference; open question to Amazon).

### 7.2 Booking pattern honesty
The Home Services SPI documents `ListProfessionals` for Browse-and-Choose and `CreateBooking` (experimental) for Auto-Match, and says Auto-Match does not use browsing operations (`home-services-spi.txt:125-136, :180, :331`). Keep the story; label it in README, chips and code comments: "Browse-and-Choose discovery + CreateBooking stage (experimental SPI, documented for Auto-Match) — our combination". `/spi/invoice`, `/spi/photos` and checkout sessions are labelled "partner-side extension, not an Alexa SPI".
- Beat 2 estimate returns `charges`, `policies` (CANCELLATION) and `paymentInstruments` (CARD) as the SPI does; the read-back uses "to be paid after the work is proven".
- `cancel_booking`: read back booking details and the cancellation policy, then ask for confirmation (§15).

### 7.3 Customer surface vs developer view
"Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response" (`functional-requirements.txt:133`). Tool-call chips, `_meta.steps`, mode badges and session ids live only in a host panel titled **"Developer view — not shown to customers"**, visibly separate from the device. Alexa's spoken lines and the cards never contain tool names or ids.
- Voice lines must work without a screen: replace "on your home card" with "in your Alexa app".

### 7.4 Brands
No Alexa, Echo, Amazon or Ring logos or look-alike marks anywhere (Amazon refused logo permission, forum 45450; video rule bars third-party marks). Words "Alexa+", "Echo Show" as plain text only. The simulator frame is a generic smart display labelled "Echo Show 8 simulator (1280×800 frame)".

### 7.5 Voice budget (beats 1–4 must fit 60 s with the user's lines; Alexa lines incl. the platform checkout lines ≤ 45 s at 2.5 words/s — 2026-10-10 rev.: 42.8 s)
1. "Three electricians nearby. Quick Volt's license isn't in Florida's registry, so I left them out. Bright Current is licensed, 4.8 stars, 1,120 dollars. Want them?"
2. "Bright Current, Thursday 10 to noon, 1,120 dollars, paid per proven item. They agreed your door camera logs arrival and departure. Book it?" → "Booked. The confirmation is in your Alexa app."
3. "Five of six items are proven. The hallway smoke detector has no photo, and a 300-dollar inspection wasn't in the scope. Pay 1,050 now; 370 waits for you."
4. (Alexa+ checkout, simulated) as in 7.1.
5. (new session) "Two things: the hallway smoke detector needs a photo, and the 300-dollar inspection line is your call. Want a draft note to Bright Current?"
6. (warranty, a month later, new session) "That's covered: Bright Current's 90-day labor warranty runs to January 13. I can book a free return visit with the original scope and photos attached." — tool `warranty_callback` (sandbox booking at $0.00, evidence attached). Added under the owner's "do everything" instruction of 2026-10-10; both independent reviews recommended it (internal review notes, not published). Recurring services stay out of the demo (one README line only).

### 7.6 Numbers allowed in the video and README (exact wording)
- Author's history (backtest, `docs/BACKTEST.md`): "Since we closed on our house in July, I've been in touch with 118 contractors and home-service companies and booked 13 jobs. Five went wrong." Not "36 / 24", not "119" (one company was counted twice under two spellings until 2026-10-19).
- "Florida received 4,847 unlicensed-activity complaints in one year." (DBPR ULA Report FY 2024-25, p.13)
- "Florida paid $4.35 million in 2025 to homeowners harmed by licensed contractors." (DBPR 2025 Accomplishments, posted 2026-01-07)
- "Americans filed 81,925 home-repair reports with the FTC in 2024." (say "reports", never "scams")
Never: "1 in 10 Americans", "80% of complaints valid", "escrow", "hold".

### 7.7 Real device (ASK skill) — time-boxed, after the device test (Echo Show 8 arrives 2026-10-11)
Folder `skill/`: interaction model (FindProsIntent, BookIntent, ReviewInvoiceIntent, StatusIntent, WarrantyIntent + Help/Stop/Fallback), ask-sdk-core handler that acts as an MCP client of the same `proofpay` server (fixture registry mode, 6 s client timeout; Alexa waits ≤ 8 s), APL 2024.3 documents for the pros, payment and status cards, own-HTTPS-endpoint adapter (signature verification on) plus deploy notes. Payment in the skill is never collected (Alexa+ owns checkout); the skill shows the pre-checkout card and says the platform completes it. Human gates: developer account registration and device setup on the same Amazon login (owner), public HTTPS endpoint for the recording session.
