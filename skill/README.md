# Proof Before Pay: Alexa skill for a real Echo Show

This is a custom Alexa skill (Alexa Skills Kit) that runs the same demo as the Echo Show simulator, on a real device. The skill holds no business logic. It is an MCP client of the `proofpay` server: every intent calls one proofpay tool over Streamable HTTP (protocol 2025-11-25, `Authorization: Bearer pbp-sandbox-<user>`). It speaks the tool's own line and draws the tool's card as an APL 2024.3 document when the device has a screen.

Payment belongs to Alexa+ (SPEC §7.1). The skill never collects payment, card data or a voice code. For "pay the proven part" it asks proofpay to prepare the checkout session, which holds the proven items only, and says that Alexa completes checkout on the platform.

## Files

| Path | What |
|---|---|
| `interaction-model/en-US.json` | Invocation name "proof before pay", the intents, and the `ProName` slot type. Paste it into the console JSON Editor. |
| `skill-package/skill.json` | Reference manifest for ask-cli: APL interface and HTTPS endpoint placeholder. The console sets the same values. |
| `src/handler.ts` | ask-sdk-core handlers: intent → proofpay tool, speech, APL, session state for "yes". |
| `src/proofpay.ts` | MCP client: one MCP session per Alexa session, a 6 s deadline per call (connect + tools/list + call), and one retry on a fresh session. |
| `src/apl.ts`, `apl/*.json` | APL 2024.3 documents (pros, payment, status, warranty, generic card) and the datasource mapping from the server's card model. |
| `src/server.ts` | Own HTTPS or HTTP endpoint (`POST /alexa`, `GET /healthz`) with request signature and timestamp verification. |
| `src/verify.ts` | Amazon's documented verification on `node:crypto`: cert URL rules, chain to a trusted root, SAN `echo-api.amazon.com`, `Signature-256` over the raw body, timestamp within 150 s. |
| `src/lambda.ts` | `handler(event, context)` for Alexa-hosted or Lambda, bundled by `npm run skill:bundle`. |
| `test/` | `node --test` against a real proofpay server and sandbox on ephemeral ports, plus the verifier tests. |

## Intents → tools

| User says | Intent | proofpay tool |
|---|---|---|
| "I need a licensed electrician to replace outlets …" | FindProsIntent (`{job}` AMAZON.SearchQuery) | `find_pros` |
| "Book Bright Current" | BookIntent (`{pro}` ProName) | `book_job` confirm=false (read-back) |
| "Yes" | ConfirmIntent | depends on what was offered: `book_job` confirm=true · `draft_note` · `warranty_callback` confirm=true · `cancel_booking` confirm=true |
| "He sent the invoice" | ReviewInvoiceIntent | `review_invoice` |
| "Pay the proven part" | PayProvenIntent | `prepare_checkout`, then "Alexa completes the checkout on the platform." `pay_proven` is never called. |
| "What's left with the electrician?" | StatusIntent | `job_status` |
| "The bathroom outlet stopped working again" | WarrantyIntent | `warranty_callback` |
| help / stop / cancel / no / anything else | AMAZON.* | none |

Touching a card button sends `Alexa.Presentation.APL.UserEvent` and takes the same path as the spoken line (Book, Pay, Draft a note, Yes).

If a tool is not on the server yet (`prepare_checkout` and `warranty_callback` were added to the server later), the skill checks `tools/list`, says "That step isn't available yet.", and logs `tool not available yet`. It does not fail.

Assumed contract for those two tools, so APP can match it or tell me otherwise:
- First call with `{}`, then `{ confirm: true }` after the homeowner says yes.
- `structuredContent = { speech, view, card, data }`, the same as the other tools.
- `view: "warranty"` for the warranty card. `data.needsConfirmation` decides whether "yes" is armed.
- For checkout, `data.plan` or `data.summary` carries `payNow` and `waits` in cents.

## Run and test locally

```bash
cd proof-before-pay
npm run skill:test                     # 23 tests: demo flow against a live server, verifier, bundle
npm run demo                           # sandbox 8791 + proofpay 8787 + host 5178 (fixture registry)
PBP_TOKEN=pbp-sandbox-echo-demo npm run skill:start   # skill endpoint on http://127.0.0.1:8795/alexa
```

Env for `skill:start`: `SKILL_PORT` (8795), `SKILL_HOST` (127.0.0.1), `MCP_URL` (http://127.0.0.1:8787/mcp), `PBP_TOKEN` (pbp-sandbox-<user>), `ALEXA_SKILL_ID` (requests for other skills are refused), `MCP_TIMEOUT_MS` (6000), `SKILL_TLS_KEY` + `SKILL_TLS_CERT` (PEM paths, to serve HTTPS directly).

`SKIP_SIGNATURE_CHECK=1` turns verification off. Use it only for local curl tests, and never while a tunnel is up.

"Simulated time" for the device run means advancing the sandbox clock, which delivers the camera webhooks and posts the invoice. Press the button in the host simulator, or run:
`curl -X POST -H 'Content-Type: application/json' -d '{"to":"demo"}' http://127.0.0.1:8791/sim/advance`

## Deploy (a): own HTTPS endpoint through a tunnel (recommended, no AWS account, no card)

The skill endpoint runs on the same Mac as proofpay and calls it at `127.0.0.1`. Only the skill endpoint is public, and only while recording. The proofpay server stays localhost-only, because its Host validation rejects public hostnames.

1. Start the stack: `npm run demo`. In a second terminal: `PBP_TOKEN=pbp-sandbox-echo-demo npm run skill:start`.
2. Start the tunnel: `cloudflared tunnel --url http://127.0.0.1:8795`. It prints `https://<random>.trycloudflare.com`. `ngrok http 8795` also works; both are installed on the build Mac.
3. In the developer console (developer.amazon.com/alexa/console/ask), signed in with the same Amazon account as the Echo Show:
   1. Create Skill. Name: Proof Before Pay. Locale: English (US). Type: Other → Custom. Hosting: Provision your own. Template: Start from Scratch.
   2. Build → Interaction Model → JSON Editor. Paste `interaction-model/en-US.json`, then Save and Build skill.
   3. Build → Interfaces → turn on Alexa Presentation Language. Select the Hub Landscape profiles, then Save Interfaces and Build again.
   4. Build → Endpoint → HTTPS. Default Region: `https://<random>.trycloudflare.com/alexa`. SSL certificate: "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority". Save Endpoints.
   5. Copy the Skill ID (amzn1.ask.skill.…). Restart the endpoint with `ALEXA_SKILL_ID=<id>` set.
   6. Test tab: set the stage to Development. Type "open proof before pay" with Device Display on. The first request logs the device viewport (`viewport {...}`) to the endpoint console.
4. On the Echo Show 8, which must be registered to the same Amazon account: in the Alexa app, Alexa+ path: menu → More → Alexa+ Store → Browse Alexa Skills and Games → Your Skills → Dev → Proof Before Pay → Enable to use. Standard path: menu → Skills & Games → Your Skills → Dev.
5. Say "Alexa, open proof before pay" → "I need a licensed electrician to replace outlets and smoke detectors in the master bath" → "Book Bright Current" → "Yes" → (advance the sandbox clock) → "He sent the invoice" → "Pay the proven part". Then, in a new session: "Alexa, ask proof before pay what's left with the electrician" → "Yes".
6. Stop the tunnel when the recording is done. A quick tunnel gets a new hostname on every start, so update the console endpoint each time.

## Deploy (b): Alexa-hosted (documented, NOT usable today)

Steps, if the blockers below are lifted:
1. Create Skill with Hosting: Alexa-hosted (Node.js). Do the interaction model and APL interface the same way as (a) 3.2 and 3.3.
2. Build a self-contained bundle with the server address baked in. I could not confirm that Alexa-hosted lets you set environment variables, so the address is baked in at build time:
   `npx esbuild skill/src/lambda.ts --bundle --platform=node --format=cjs --target=node16 --outfile=skill/dist/lambda/index.js --define:process.env.MCP_URL='"https://<public-proofpay-host>/mcp"' --define:process.env.PBP_TOKEN='"pbp-sandbox-echo-demo"'`
3. Code tab: replace `lambda/index.js` with the bundle, remove the dependencies from `lambda/package.json`, then Deploy.
4. Do the device steps the same way as (a) 4–5.

Blockers:
- Amazon's page (updated Mar 16, 2026) says Alexa-hosted runs Node.js 16.x, and you can't change it. Node 16 has no global `fetch`, and the MCP client needs it. The bundle is tested only on the current Node, in `skill.test.ts`.
- proofpay would have to be public. It currently accepts only localhost Host headers, and its bearer token is a guessable sandbox literal. Publishing it needs an APP-side change: a Host allowlist and real auth.

Own AWS Lambda (`nodejs22.x`) would avoid the Node 16 problem. It needs an AWS account with a card on file, so it is a payment decision for the owner, and it is not used here.

## What is verified and what is only documented

Verified by tests or a run:
- The demo flow through Alexa envelopes against the real proofpay server and sandbox on ephemeral ports: speech equals the tool's line, plus the APL datasource numbers (payNow 105000, waits 37000, Subtotal/Fees/Total $1,050.00 / $0.00 / $1,050.00, sources on every evidence row).
- The checkout path never calls `pay_proven` and never asks for a code.
- A tool that does not exist yet is handled gracefully.
- No-screen devices get speech and no APL directive.
- The 6 s deadline answers in about 0.4 s against a server that never responds (test budget 400 ms). A down server gets the error line.
- The verifier: a synthetic chain minted by openssl is accepted. A tampered body, a signature from another key, a wrong SAN, an untrusted root, missing headers, a timestamp more than 150 s old or in the future, and bad cert URLs are all rejected. The saved real Amazon chain (`echo-api-cert-12.pem`) validates against Node's root store at a date inside its validity window, and is rejected as expired today.
- Mutation checks: disabling the signature check, the timestamp check, the payment-card mapping, or the no-`pay_proven` rule each turns tests red.
- The real entry points as separate processes (sandbox, proofpay, two skill endpoints): the full flow over HTTP. The strict endpoint rejects an unsigned request with 400.
- The Lambda bundle (esbuild, cjs, target node16) answers through the live server on the current Node.

Only documented (needs the device or the console):
- That "Alexa, open …" reaches a dev-stage skill on an Alexa+ Echo Show 8.
- That APL renders there, and how it looks. The documents are JSON-checked: version 2024.3, colour tokens, no images or logos. They have not been rendered in the console's Device Display or on the device.
- That the interaction model builds in the console.
- The live Amazon signing chain currently served: only the saved 2023 chain was tested.
- Deploy path (b).

## Human gates (nothing here creates accounts, deploys or publishes)

1. Amazon developer account on the same Amazon login the Echo Show 8 is registered to.
2. Device setup and registration, plus any Alexa+ opt-in prompts on the Echo Show 8.
3. Creating the skill in the console and enabling it in the Alexa app (Your Skills → Dev).
4. Starting and stopping the public tunnel for the recording session.
5. No certification and no publishing. Not needed for the hackathon.
