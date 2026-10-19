# Proof Before Pay — demo video script (target 2:40, hard limit < 3:00)

Rules this script follows: judges may stop at 3:00, so the mechanism is inside the first 60 s and the video opens with the result; no third-party logos or music; the Alexa+ experience is labelled "simulated in our web host"; numbers only from SPEC §7.6 (backtest + DBPR + FTC); first-person voice-over is recorded live by the author (no synthetic voice for the author). Alexa's lines are on-screen subtitles in the simulator; if they are voiced, the voice is labelled "simulated Alexa voice".

Recording setup: `npm run demo` → host http://127.0.0.1:5178/ at 1920×1200 → "Play demo" runs beats 1–6 with fixed pacing. Record the screen at 60 fps; record the voice-over separately and lay it over. Keep the "Developer view" panel visible in the "How it works" segment only (crop to the device elsewhere).

| Time | Picture | Voice-over (author, live) | On-screen text |
|---|---|---|---|
| 0:00–0:06 | Beat 3 end state, device only: the payment card, "Pay now $1,050.00 · Waits $370.00", rows with sources | "This is the moment I wanted: the invoice checked line by line. Pay what's proven. The rest waits." | "Alexa+ experience simulated in our web host" (small, bottom) |
| 0:06–0:15 | Black → simple counter animation 118 → 13 → 5 | "Since we closed on our house in July, I've been in touch with 118 contractors and booked 13 jobs. Five went wrong." | "Author's history · anonymized ledger in the repo (BACKTEST.md)" |
| 0:15–0:25 | Beat 1: request → pros list, Quick Volt struck "License EC99000103 not found" | (silence under Alexa's line) | Alexa subtitle: "Three electricians nearby. Quick Volt's license isn't in Florida's registry, so I left them out…" · chip LIVE "Florida license registry" when recorded with `REGISTRY_LIVE_NUMBERS=EC99000103`, as in the hosted demo (`REGISTRY_MODE=auto` alone uses the recorded page, because all three demo numbers have one) |
| 0:25–0:37 | Beat 2: read-back → "Yes" → scope card (3 items + "+3 more", consent row, simulated door code) | "Every item says what will prove it. The pro agrees the front door camera logs only arrive and leave." | "Door code: simulated (no lock API)" |
| 0:37–0:39 | Button "simulated time → Thu 2:15 PM" | — | "simulated time" |
| 0:39–0:53 | Beat 3: invoice → payment card builds row by row | "Fixed rules, not a model, match the invoice to the scope and to photos taken during the visit." | Alexa subtitle beat 3 · one honest row "Not confirmed: hallway smoke detector, no photo" |
| 0:53–1:03 | Beat 4: "Pay for this order" → platform sheet "Alexa+ checkout · simulated", voice code •••• → "Order confirmed" | "Checkout belongs to Alexa. The other 370 stays unpaid until I decide." | "sandbox payment · Visa ending 4242" |
| 1:03–1:25 | How it works: host with Developer view visible; then a diagram (MCP server ↔ host; registry; camera webhooks with HMAC; rules engine; checkout sessions) | "It's a self-hosted MCP server, protocol 2025-11-25 over Streamable HTTP, with MCP Apps cards. The license check hits Florida's live registry. Camera events arrive in the Ring Partner API webhook format, signature checked. And the payment step hands off to the platform." | labels LIVE / FIXTURE / SANDBOX / SIMULATED as in the Developer view |
| 1:25–1:40 | Beat 5: New session → "What's left with the electrician?" → status card → draft note | "It remembers the job across sessions. It drafts the note; I send it." | — |
| 1:40–1:55 | Beat 6: simulated time → Nov 12, new session → warranty card → "Book free visit" ($0.00) | "A month later the outlet fails. The warranty, the scope and the photos are already there." | — |
| 1:55–2:10 | Real Echo Show 8 insert (only if the ASK skill test passes): "Alexa, open proof before pay" → payment card in APL | "The same server also runs as a classic Alexa skill on a real Echo Show." | "Alexa skill (development stage) calling the same MCP server" |
| 2:10–2:28 | Backtest table + two facts | "On my own 13 jobs, the gates would have flagged all five that went wrong. Florida received 4,847 unlicensed-activity complaints in one year, and paid 4.35 million dollars in 2025 to homeowners harmed by licensed contractors." | sources: DBPR ULA Report FY 2024-25; DBPR 2025 Accomplishments |
| 2:28–2:40 | Honesty card → repo URL | "Everything you saw runs offline from the repo in two commands. The friction log and product feedback are in it." | "Live: Florida license registry · Fixture: camera events · Sandbox: marketplace, payment · Simulated: Alexa+ host, door code" |

Cut order if over time: the real-device insert (1:55–2:10) first, then the warranty beat, then the diagram.

Voice-over word count ≈ 230 words (≈ 1:35 at 2.4 words/s), leaving room for Alexa's subtitled lines.
