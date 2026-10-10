// Integration: sandbox on an ephemeral port + a test webhook receiver on an ephemeral port.
// reset -> book (ESTIMATE -> CONFIRMATION) -> advance clock -> signed webhooks verified -> invoice + photos ->
// reconcile gives the demo plan.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
  assert.equal(b0.payment.cardOnFile.last2, "42");
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

  // Partial capture of the proven part; idempotent retry; cannot exceed the invoice.
  const cap = await call<{ capture: Capture }>("/spi/capture", { partnerBookingId: "PB-1001", amount: plan.payNow, idempotencyKey: "pay-1" });
  assert.equal(cap.status, 200);
  assert.deepEqual([cap.json.capture.captureId, cap.json.capture.amount, cap.json.capture.remaining, cap.json.capture.paymentMethod.mode], ["CAP-1001", 105000, 37000, "sandbox"]);
  const again = await call<{ capture: Capture }>("/spi/capture", { partnerBookingId: "PB-1001", amount: plan.payNow, idempotencyKey: "pay-1" });
  assert.deepEqual(again.json.capture, cap.json.capture);
  const over = await call<{ error: { code: string } }>("/spi/capture", { partnerBookingId: "PB-1001", amount: 40000 });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, "exceeds_invoice");
  assert.equal((await call("/spi/capture", { partnerBookingId: "PB-1001", amount: 10.5 })).status, 400);

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
