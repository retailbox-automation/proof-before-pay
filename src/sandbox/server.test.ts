// Integration: sandbox on an ephemeral port + a test webhook receiver on an ephemeral port.
// reset -> book (ESTIMATE -> CONFIRMATION) -> advance clock -> signed webhooks verified -> invoice + photos ->
// reconcile gives the demo plan.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSandbox, type RunningSandbox } from "./server.ts";
import { validateScenario } from "./scenario.ts";
import { verify } from "../core/doorbell/hmac.ts";
import { parseRingWebhook, type RingWebhook } from "../core/doorbell/ring-format.ts";
import { visitWindow } from "../core/doorbell/visit.ts";
import { loadRegistryFixtures, APP_ROOT } from "../core/registry/fixtures.ts";
import { lookupLicense } from "../core/registry/lookup.ts";
import { reconcile } from "../core/reconcile.ts";
import type { Booking, Capture, Invoice } from "./state.ts";
import type { CheckoutSession } from "./checkout.ts";
import type { Photo } from "../core/types.ts";

const KEY = "sandbox-signing-key";
const T = (hhmm: string) => Date.parse(`2026-10-15T${hhmm}:00-04:00`);
type Received = { raw: Buffer; signature: string | undefined; contentType: string | undefined };

let receiver: Server;
let receiverUrl = "";
let received: Received[] = [];
let sandbox: RunningSandbox;

before(async () => {
  receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ raw: Buffer.concat(chunks), signature: req.headers["x-signature"] as string | undefined, contentType: req.headers["content-type"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"processed"}');
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  const addr = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/webhooks/doorbell`;
  sandbox = await startSandbox({ port: 0, webhookUrl: receiverUrl, quiet: true });
});

after(async () => {
  await sandbox.close();
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
});

async function call<T = Record<string, unknown>>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const init: RequestInit = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
  const res = await fetch(sandbox.url + path, init);
  return { status: res.status, json: (await res.json()) as T };
}

async function req<T = Record<string, unknown>>(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T; text: string }> {
  const res = await fetch(sandbox.url + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T, text };
}

async function bookP1(alexaBookingId: string, consent = true): Promise<Booking> {
  const est = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId, proId: "P1" });
  assert.equal(est.status, 200);
  const conf = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "CONFIRMATION", alexaBookingId, partnerBookingId: est.json.booking.partnerBookingId, homeownerConsentToVisitLogging: consent });
  assert.equal(conf.status, 200);
  return conf.json.booking;
}

test("listens on an ephemeral port, not the default 8791", () => {
  assert.notEqual(sandbox.port, 8791);
  assert.ok(sandbox.port > 0);
});

test("full demo flow: book -> advance -> verified webhooks -> invoice + photos -> reconcile = demo plan", async () => {
  received = [];
  const reset = await call<{ now: number; bookings: unknown[] }>("/sim/reset", { scenario: "demo" });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.now, Date.parse("2026-10-14T18:00:00-04:00"));
  assert.deepEqual(reset.json.bookings, []);

  const pros = await call<{ professionals: Array<{ proId: string; businessName: string; costEstimate: number; claimedLicense: string; rating: number; reviewCount: number }> }>("/spi/ListProfessionals", { trade: "electrician" });
  assert.deepEqual(pros.json.professionals.map((p) => [p.proId, p.businessName, p.claimedLicense, p.costEstimate, p.rating, p.reviewCount]), [
    ["P1", "Bright Current Electric", "EC99000101", 112000, 4.8, 212],
    ["P2", "Harbor Line Electrical", "EC99000102", 126000, 4.6, 98],
    ["P3", "Quick Volt Pros", "EC99000103", 94000, 4.9, 37],
  ]);

  // ESTIMATE: read-back data for the voice confirmation.
  const est = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-demo-1", proId: "P1" });
  const b0 = est.json.booking;
  assert.equal(b0.partnerBookingId, "PB-1001");
  assert.equal(b0.status, "PENDING");
  assert.deepEqual(b0.timeSlot, { start: T("10:00"), end: T("12:00") });
  assert.equal(b0.scope.items.length, 6);
  assert.equal(b0.scope.items.reduce((s, i) => s + i.price, 0), 112000);
  assert.deepEqual([b0.scope.visitLoggingConsent.byPro, b0.scope.visitLoggingConsent.byHomeowner, b0.scope.visitLoggingConsent.granted], [true, false, false]);
  assert.equal(b0.doorCode.simulated, true);
  assert.deepEqual([b0.payment.cardOnFile.brand, b0.payment.cardOnFile.last_digits], ["visa", "4242"]);
  // SPI Purchase shapes on the estimate: charges, CANCELLATION policy, CARD instrument.
  assert.equal(b0.purchaseDetails.charges.reduce((s, c) => s + c.amount, 0), 112000);
  assert.deepEqual(b0.purchaseDetails.policies.map((x) => x.policyType), ["CANCELLATION"]);
  assert.match(b0.purchaseDetails.policies[0].policyDescription, /cancellation/i);
  assert.deepEqual(b0.purchaseDetails.paymentInstruments, [{ paymentInstrumentType: "CARD", paymentInstrumentId: "Visa **** 4242", wallet: "sandbox" }]);
  assert.equal((await call("/spi/invoice/PB-1001")).status, 404);
  assert.deepEqual((await call<{ photos: Photo[] }>("/spi/photos/PB-1001")).json.photos, []);

  // CONFIRMATION with the homeowner's consent.
  const conf = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "CONFIRMATION", alexaBookingId: "AB-demo-1", partnerBookingId: "PB-1001", homeownerConsentToVisitLogging: true });
  const booking = conf.json.booking;
  assert.equal(booking.status, "CONFIRMED");
  assert.equal(booking.scope.visitLoggingConsent.granted, true);
  assert.equal(booking.scope.visitLoggingConsent.at, Date.parse("2026-10-14T18:00:00-04:00"));

  // Simulated time -> Thu 2:15 PM.
  const adv = await call<{ nowLocal: string; emitted: Array<{ delivered: boolean; status: number }>; invoiceVisible: boolean; photosVisible: number; bookings: Array<{ status: string }> }>("/sim/advance", { to: "demo" });
  assert.equal(adv.status, 200);
  assert.equal(adv.json.nowLocal, "2026-10-15 14:15:00");
  assert.equal(adv.json.emitted.length, 7);
  assert.ok(adv.json.emitted.every((d) => d.delivered && d.status === 200));
  assert.equal(adv.json.invoiceVisible, true);
  assert.equal(adv.json.photosVisible, 5);
  assert.equal(adv.json.bookings[0].status, "COMPLETED");

  // Every webhook verifies over the raw bytes with the signing key; wrong key fails.
  assert.equal(received.length, 7);
  const hooks: RingWebhook[] = [];
  for (const r of received) {
    assert.equal(r.contentType, "application/json");
    assert.equal(verify(r.raw, r.signature, KEY), true);
    assert.equal(verify(r.raw, r.signature, "wrong-key"), false);
    hooks.push(parseRingWebhook(JSON.parse(r.raw.toString("utf8"))));
  }
  assert.deepEqual(hooks.map((h) => h.data.type === "motion_detected" ? `motion:${h.data.attributes.sub_type}` : "button_press"),
    ["motion:human", "motion:vehicle", "button_press", "motion:human", "motion:human", "motion:human", "motion:human"]);
  const ts = hooks.map((h) => h.data.attributes.timestamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(new Set(hooks.map((h) => h.meta.request_id)).size, 7);
  assert.ok(hooks.every((h) => h.meta.version === "1.1" && h.meta.account_id === "ava1.ring.account.SANDBOX01"));

  // Invoice + photos.
  const invoice = (await call<{ invoice: Invoice }>("/spi/invoice/PB-1001")).json.invoice;
  assert.equal(invoice.total, 142000);
  assert.equal(invoice.charges.length, 7);
  assert.deepEqual(invoice.charges[6], { chargeDescription: "Electrical inspection", chargeCategory: "SERVICE", amount: 30000 });
  const photos = (await call<{ photos: Photo[] }>("/spi/photos/PB-1001")).json.photos;
  assert.deepEqual(photos.map((p) => p.scopeItemId), ["S1", "S2", "S3", "S4", "S6"]);
  assert.ok(photos.every((p) => p.takenAt >= T("10:05") && p.takenAt <= T("11:35")));

  // Evidence -> reconcile.
  const license = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "fixture", fixtures: loadRegistryFixtures(), now: T("14:15") });
  const visit = visitWindow(hooks, booking.timeSlot, booking.scope.visitLoggingConsent.granted, { mode: "sandbox", ref: "sandbox-front-door-01" });
  assert.deepEqual([visit.arrivedAt, visit.leftAt], [T("10:02"), T("11:40")]);
  const plan = reconcile(booking.scope, invoice.charges, { license, visit, photos });
  assert.equal(plan.payNow, 105000);
  assert.equal(plan.waits, 37000);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.notConfirmed.length, 2);

  // Checkout (UCP-shaped): prepare the proven items -> Create -> Update -> Complete, with idempotency,
  // decline, amount guard and no double charge.
  const U = { Authorization: "Bearer pbp-sandbox-test-user" };
  const proven = plan.lines.filter((l) => l.verdict.kind === "proven").map((l) => (l.verdict as { scopeItemId: string }).scopeItemId);
  const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  assert.equal((await req("POST", "/partner/checkout/prepare", { partnerBookingId: "PB-1001", scopeItemIds: proven, amount: 105000, planHash: hash })).status, 401);
  const badAmount = await req<{ error: { code: string } }>("POST", "/partner/checkout/prepare", { partnerBookingId: "PB-1001", scopeItemIds: proven, amount: 112000, planHash: hash }, U);
  assert.deepEqual([badAmount.status, badAmount.json.error.code], [409, "amount_mismatch"]);
  const prep = await req<{ checkout: CheckoutSession }>("POST", "/partner/checkout/prepare", { partnerBookingId: "PB-1001", scopeItemIds: proven, amount: 105000, planHash: hash }, U);
  const cs = prep.json.checkout;
  assert.equal(prep.status, 200);
  assert.deepEqual([cs.id, cs.status, cs.line_items.length], ["cs_1001", "incomplete", 5]);
  assert.deepEqual(cs.totals, [{ type: "subtotal", amount: 105000 }, { type: "fee", amount: 0 }, { type: "total", amount: 105000 }]);
  assert.equal(cs.links[0].title, "Refund policy · Bright Current Electric");
  assert.deepEqual(cs.payment.instruments.map((i) => `${i.handler_id}:${i.display.brand}:${i.display.last_digits}`), ["partner_card_on_file:visa:4242", "partner_card_on_file:visa:0002"]);
  const lines = cs.line_items.map((l) => ({ item: { id: l.item.id }, quantity: 1 }));
  assert.equal((await req("POST", "/checkout-sessions", { line_items: lines }, U)).status, 400); // no Idempotency-Key
  const withS5 = await req<{ error: { code: string } }>("POST", "/checkout-sessions", { line_items: [...lines, { item: { id: "PB-1001:S5" }, quantity: 1 }] }, { ...U, "Idempotency-Key": "k-tamper" });
  assert.deepEqual([withS5.status, withS5.json.error.code], [409, "quote_mismatch"]);
  const created = await req<CheckoutSession>("POST", "/checkout-sessions", { line_items: lines }, { ...U, "Idempotency-Key": "k-create", "Request-Id": "r-1" });
  assert.deepEqual([created.status, created.json.id, created.json.status], [201, "cs_1001", "incomplete"]);
  const replay = await req("POST", "/checkout-sessions", { line_items: lines }, { ...U, "Idempotency-Key": "k-create" });
  assert.deepEqual([replay.status, replay.text], [201, created.text]);
  const conflict = await req<{ code: string }>("POST", "/checkout-sessions", { line_items: lines.slice(1) }, { ...U, "Idempotency-Key": "k-create" });
  assert.deepEqual([conflict.status, conflict.json.code], [409, "idempotency_conflict"]);
  const ready = await req<CheckoutSession>("PUT", "/checkout-sessions/cs_1001", { line_items: lines, buyer: { first_name: "Sandbox", last_name: "Homeowner" } }, U);
  assert.equal(ready.json.status, "ready_for_complete");
  const pay = (pm: string) => ({ payment: { instruments: [{ id: "instr_1", handler_id: "partner_card_on_file", type: "card", credential: { type: "payment_method_reference", payment_method_id: pm } }] } });
  const declined = await req<{ status: string; messages: { code: string }[] }>("POST", "/checkout-sessions/cs_1001/complete", pay("pm_visa_0002"), { ...U, "Idempotency-Key": "k-pay-0" });
  assert.deepEqual([declined.status, declined.json.status, declined.json.messages[0].code], [200, "incomplete", "payment_failed"]);
  assert.equal((await call<{ charges: Capture[] }>("/sim/charges")).json.charges.length, 0);
  const done = await req<CheckoutSession>("POST", "/checkout-sessions/cs_1001/complete", pay("pm_visa_4242"), { ...U, "Idempotency-Key": "k-pay-1" });
  assert.deepEqual([done.status, done.json.status, done.json.order?.id], [200, "completed", "ORD-1001"]);
  const again = await req("POST", "/checkout-sessions/cs_1001/complete", pay("pm_visa_4242"), { ...U, "Idempotency-Key": "k-pay-1" });
  assert.deepEqual([again.status, again.text], [200, done.text]);
  assert.equal((await req("POST", "/checkout-sessions/cs_1001/complete", pay("pm_visa_4242"), { ...U, "Idempotency-Key": "k-pay-2" })).status, 409);
  const charges = (await call<{ charges: Capture[] }>("/sim/charges")).json.charges;
  assert.deepEqual(charges.map((c) => [c.amount, c.paymentMethod.last_digits]), [[105000, "4242"]]);
  assert.equal((await req("GET", "/checkout-sessions/cs_1001", undefined, { Authorization: "Bearer pbp-sandbox-someone-else" })).status, 404);

  // Warranty (partner-side extension): a month later, covered by the 90-day labor warranty; $0.00 return visit.
  const offerEarly = await req<{ warranty: { covered: boolean } }>("POST", "/partner/warranty-claims", { partnerBookingId: "PB-1001", scopeItemIds: ["S2", "S6"] });
  assert.equal(offerEarly.status, 401);
  assert.equal((await call<{ nowLocal: string }>("/sim/advance", { to: "warranty" })).json.nowLocal, "2026-11-12 09:00:00");
  const offer = await req<{ warranty: { covered: boolean; warrantyEnds: number; laborWarrantyDays: number; returnVisit: { start: number; end: number }; amount: number; booking: Booking | null } }>("POST", "/partner/warranty-claims", { partnerBookingId: "PB-1001", scopeItemIds: ["S2", "S6"] }, U);
  assert.deepEqual([offer.json.warranty.covered, offer.json.warranty.laborWarrantyDays, offer.json.warranty.amount, offer.json.warranty.booking], [true, 90, 0, null]);
  assert.equal(new Date(offer.json.warranty.warrantyEnds).toLocaleDateString("en-US", { timeZone: "America/New_York" }), "1/13/2027");
  assert.deepEqual(offer.json.warranty.returnVisit, { start: Date.parse("2026-11-16T10:00:00-05:00"), end: Date.parse("2026-11-16T12:00:00-05:00") });
  const booked = await req<{ warranty: { booking: Booking } }>("POST", "/partner/warranty-claims", { partnerBookingId: "PB-1001", scopeItemIds: ["S2", "S6"], confirm: true }, U);
  const wb = booked.json.warranty.booking;
  assert.deepEqual([wb.kind, wb.status, wb.warrantyFor, wb.costEstimate, wb.purchaseDetails.charges[0].amount], ["warranty_return", "CONFIRMED", "PB-1001", 0, 0]);
  const twice = await req<{ warranty: { booking: Booking } }>("POST", "/partner/warranty-claims", { partnerBookingId: "PB-1001", scopeItemIds: ["S2", "S6"], confirm: true }, U);
  assert.equal(twice.json.warranty.booking.partnerBookingId, wb.partnerBookingId); // one return visit, not two

  // Ring history API: bearer required; newest first; composite filter.
  assert.equal((await call("/ring/v1/history/devices/sandbox-front-door-01/events")).status, 401);
  const auth = { Authorization: "Bearer sandbox" };
  const all = await call<{ data: Array<{ type: string; attributes: { event_type: string; start: number; end: number } }>; links: { next?: string } }>("/ring/v1/history/devices/sandbox-front-door-01/events", undefined, auth);
  assert.equal(all.status, 200);
  assert.equal(all.json.data.length, 7);
  assert.deepEqual(all.json.links, {});
  assert.ok(all.json.data.every((e, i, a) => e.type === "history-events" && (i === 0 || a[i - 1].attributes.start >= e.attributes.start)));
  const people = await call<{ data: Array<{ attributes: { event_type: string } }> }>("/ring/v1/history/devices/sandbox-front-door-01/events?event_types=ding,motion.human", undefined, auth);
  assert.equal(people.json.data.length, 6);
  assert.equal((await call("/ring/v1/history/devices/nope/events", undefined, auth)).status, 404);

  // Clock never goes backwards; completed job can't be cancelled.
  assert.equal((await call("/sim/advance", { to: T("09:00") })).status, 400);
  assert.equal((await call("/spi/CancelBooking", { partnerBookingId: "PB-1001" })).status, 409);
});

test("deterministic: two runs after reset produce byte-identical webhooks and the same ids", async () => {
  const run = async () => {
    received = [];
    await call("/sim/reset", { scenario: "demo" });
    const b = await bookP1("AB-determinism");
    await call("/sim/advance", { to: "demo" });
    return { id: b.partnerBookingId, bodies: received.map((r) => r.raw.toString("utf8")), sigs: received.map((r) => r.signature) };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.id, "PB-1001");
  assert.deepEqual(a, b);
  assert.equal(a.bodies.length, 7);
});

test("no booking or a cancelled booking: only background camera events, no invoice, no photos", async () => {
  received = [];
  await call("/sim/reset", {});
  const adv = await call<{ emitted: unknown[]; invoiceVisible: boolean }>("/sim/advance", { to: "demo" });
  assert.equal(adv.json.emitted.length, 1); // the 08:30 mail carrier
  assert.equal(received.length, 1);

  received = [];
  await call("/sim/reset", {});
  const b = await bookP1("AB-cancel");
  const cancelled = await call<{ booking: Booking }>("/spi/CancelBooking", { partnerBookingId: b.partnerBookingId });
  assert.equal(cancelled.json.booking.status, "CANCELLED");
  const adv2 = await call<{ emitted: unknown[]; invoiceVisible: boolean; photosVisible: number }>("/sim/advance", { to: "demo" });
  assert.equal(adv2.json.emitted.length, 1);
  assert.equal(adv2.json.invoiceVisible, false);
  assert.equal(adv2.json.photosVisible, 0);
  assert.equal((await call(`/spi/invoice/${b.partnerBookingId}`)).status, 404);
});

test("booking rules: idempotent ESTIMATE, consent must be explicit, slot rules, bad input", async () => {
  await call("/sim/reset", {});
  const e1 = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-x", proId: "P2" });
  const e2 = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-x", proId: "P2" });
  assert.equal(e1.json.booking.partnerBookingId, e2.json.booking.partnerBookingId);
  assert.equal(e1.json.booking.costEstimate, 126000);
  const noConsent = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "CONFIRMATION", alexaBookingId: "AB-x", partnerBookingId: e1.json.booking.partnerBookingId });
  assert.equal(noConsent.json.booking.scope.visitLoggingConsent.granted, false);
  // Second confirmed booking for the same slot is refused.
  const p1 = await call<{ booking: Booking }>("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-y", proId: "P1" });
  const taken = await call<{ error: { code: string } }>("/spi/CreateBooking", { stage: "CONFIRMATION", alexaBookingId: "AB-y", partnerBookingId: p1.json.booking.partnerBookingId, homeownerConsentToVisitLogging: true });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error.code, "slot_taken");
  assert.equal((await call("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-z", proId: "P1", timeSlot: { start: T("13:00"), end: T("15:00") } })).status, 409);
  assert.equal((await call("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-z", proId: "P9" })).status, 404);
  assert.equal((await call("/spi/CreateBooking", { stage: "LATER", alexaBookingId: "AB-z" })).status, 400);
  assert.equal((await call("/spi/GetBooking?partnerBookingId=PB-9999")).status, 404);
  assert.equal((await call<{ booking: Booking }>(`/spi/GetBooking?partnerBookingId=${e1.json.booking.partnerBookingId}`)).json.booking.proId, "P2");
  assert.equal((await call("/sim/reset", { scenario: "nope" })).status, 400);
  assert.equal((await call("/nope")).status, 404);
  const bad = await fetch(sandbox.url + "/spi/CreateBooking", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  // After the slot starts, nothing new can be booked.
  await call("/sim/advance", { to: T("10:30") });
  assert.equal((await call("/spi/CreateBooking", { stage: "ESTIMATE", alexaBookingId: "AB-late", proId: "P1" })).status, 409);
});

test("CORS: the host origin may call /sim/advance; other origins get no CORS headers", async () => {
  const ok = await fetch(sandbox.url + "/sim/clock", { headers: { Origin: "http://127.0.0.1:5178" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://127.0.0.1:5178");
  const no = await fetch(sandbox.url + "/sim/clock", { headers: { Origin: "http://evil.example" } });
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

test("scenario file: epoch values match their local-time twins; a mismatch is rejected", () => {
  const raw = JSON.parse(readFileSync(join(APP_ROOT, "fixtures/demo/scenario.json"), "utf8"));
  const s = validateScenario(raw);
  assert.equal(s.job.timeSlot.start, 1792072800000);
  assert.equal(s.clock.demoAdvanceTo, 1792088100000);
  raw.photos[0].takenAt += 60_000;
  assert.throws(() => validateScenario(raw), /takenAt|PH-S1/);
});
