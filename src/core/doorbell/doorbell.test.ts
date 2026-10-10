import { test } from "node:test";
import assert from "node:assert/strict";
import { buttonPressWebhook, historyEvent, motionDetectedWebhook, parseRingWebhook, requestIdFor, ringHistoryPageSchema, timestampReadable } from "./ring-format.ts";
import { sign, verify } from "./hmac.ts";
import { doorEventsFromHistory, visitWindow, type DoorEvent } from "./visit.ts";

const KEY = "sandbox-signing-key";
const TZ = "America/New_York";
const T = (hhmmss: string) => Date.parse(`2026-10-15T${hhmmss}-04:00`);
const DEV = "sandbox-front-door-01";
const ACCOUNT = "ava1.ring.account.SANDBOX01";
const BOOKING = { start: T("10:00:00"), end: T("12:00:00") };

// ---------- payload shapes ----------
test("motion_detected payload matches the documented v1.1 shape", () => {
  const w = motionDetectedWebhook({ deviceId: DEV, timestamp: T("10:02:30"), subType: "human", timeZone: TZ, accountId: ACCOUNT, requestId: "req-1", sentAt: T("10:02:31") });
  assert.deepEqual(w, {
    meta: { version: "1.1", time: "2026-10-15T14:02:31.000Z", request_id: "req-1", account_id: ACCOUNT },
    data: {
      id: `${DEV}_motion_1792072950000`,
      type: "motion_detected",
      attributes: { source: DEV, source_type: "devices", timestamp: 1792072950000, timestamp_readable: "2026-10-15 10:02:30", sub_type: "human" },
      relationships: { devices: { links: { self: `/v1/devices/${DEV}` } } },
    },
  });
  assert.deepEqual(Object.keys(w.data.attributes), ["source", "source_type", "timestamp", "timestamp_readable", "sub_type"]);
  // Docs example: timestamp 1786715596787 -> "2026-08-14 08:53:16" (device-local, UTC-5 there).
  assert.equal(timestampReadable(1786715596787, "America/Chicago"), "2026-08-14 08:53:16");
  assert.equal(timestampReadable(1786715596787), "2026-08-14 13:53:16");
});

test("button_press payload matches the documented v1.1 shape", () => {
  const w = buttonPressWebhook({ deviceId: DEV, timestamp: T("10:02:00"), accountId: ACCOUNT, requestId: "req-2", sentAt: T("10:02:01") });
  assert.deepEqual(w, {
    meta: { version: "1.1", time: "2026-10-15T14:02:01.000Z", request_id: "req-2", account_id: ACCOUNT },
    data: {
      id: `${DEV}_button_press_1792072920000`,
      type: "button_press",
      attributes: { source: DEV, source_type: "devices", timestamp: 1792072920000 },
      relationships: { devices: { links: { self: `/v1/devices/${DEV}` } } },
    },
  });
  assert.deepEqual(parseRingWebhook(JSON.parse(JSON.stringify(w))), w);
  assert.throws(() => parseRingWebhook({ ...w, meta: { ...w.meta, version: "1.0" } }));
  assert.throws(() => parseRingWebhook({ meta: w.meta, data: { ...w.data, type: "device_added" } }));
});

test("history event shape and deterministic request ids", () => {
  const e = historyEvent({ id: "evt-1", deviceId: DEV, eventType: "ding", start: 1, end: 2 });
  assert.deepEqual(e, { type: "history-events", id: "evt-1", attributes: { event_type: "ding", is_third_party_reviewed: false, start: 1, end: 2 }, relationships: { source: { data: { type: "devices", id: DEV } } } });
  assert.ok(ringHistoryPageSchema.safeParse({ data: [e], links: {} }).success);
  assert.equal(requestIdFor("a"), requestIdFor("a"));
  assert.notEqual(requestIdFor("a"), requestIdFor("b"));
  assert.match(requestIdFor("a"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------- HMAC ----------
test("signature: matches an independent HMAC (Python hmac.hexdigest) and round-trips", () => {
  const raw = '{"meta":{"version":"1.1"},"data":{"id":"x"}}';
  assert.equal(sign(raw, KEY), "sha256=ef0933e457059dbda8710b7f12f6d2a4eac2ea6142f3bbf02d2b4d5c08a12ec7");
  const body = JSON.stringify(buttonPressWebhook({ deviceId: DEV, timestamp: T("10:02:00"), accountId: ACCOUNT, requestId: "r", sentAt: T("10:02:01") }));
  const header = sign(body, KEY);
  assert.equal(verify(body, header, KEY), true);
  assert.equal(verify(Buffer.from(body, "utf8"), header, KEY), true);
  assert.equal(verify(body, header.toUpperCase().replace("SHA256=", "sha256="), KEY), true); // hex case-insensitive
});

test("signature: tampered body, re-serialized JSON, wrong key, bad headers all fail", () => {
  const body = JSON.stringify(motionDetectedWebhook({ deviceId: DEV, timestamp: T("11:40:00"), subType: "human", timeZone: TZ, accountId: ACCOUNT, requestId: "r", sentAt: T("11:40:01") }));
  const header = sign(body, KEY);
  assert.equal(verify(body.replace("11:40:00", "13:40:00"), header, KEY), false); // tampered
  assert.equal(verify(JSON.stringify(JSON.parse(body), null, 2), header, KEY), false); // re-serialized with whitespace
  const parsed = JSON.parse(body);
  assert.equal(verify(JSON.stringify({ data: parsed.data, meta: parsed.meta }), header, KEY), false); // key order changed
  assert.equal(verify(body, header, "another-key"), false);
  assert.equal(verify(body, header, ""), false);
  assert.equal(verify(body, header.replace("sha256=", ""), KEY), false);
  assert.equal(verify(body, "sha256=abc", KEY), false);
  assert.equal(verify(body, undefined, KEY), false);
  assert.equal(verify(body, [header, header], KEY), false);
  assert.throws(() => sign(body, ""));
});

// ---------- visit window ----------
function demoEvents(): DoorEvent[] {
  const m = (hhmmss: string, subType: string): DoorEvent => ({ id: `${DEV}_motion_${T(hhmmss)}`, kind: "motion", subType, timestamp: T(hhmmss) });
  return [
    m("08:30:00", "human"), // mail carrier, more than 60 min before the booking: ignored
    m("09:58:00", "vehicle"), // van parks: not a person
    { id: `${DEV}_button_press_${T("10:02:00")}`, kind: "button_press", subType: null, timestamp: T("10:02:00") },
    m("10:02:30", "human"),
    m("10:31:00", "human"),
    m("11:08:00", "human"),
    m("11:40:00", "human"),
    m("14:30:00", "human"), // more than 120 min after the booking end: ignored
  ];
}

test("visit window for the demo scenario: 10:02-11:40", () => {
  const v = visitWindow(demoEvents().reverse(), BOOKING, true, { mode: "sandbox", ref: DEV });
  assert.equal(v.arrivedAt, T("10:02:00"));
  assert.equal(v.leftAt, T("11:40:00"));
  assert.deepEqual(v.eventIds, [`${DEV}_button_press_${T("10:02:00")}`, `${DEV}_motion_${T("11:40:00")}`]);
  assert.deepEqual(v.source, { service: "Front door camera (Ring Partner API format)", mode: "sandbox", ref: DEV });
});

test("visit window accepts raw webhooks; consent missing -> nulls with the reason in source", () => {
  const hooks = [
    buttonPressWebhook({ deviceId: DEV, timestamp: T("10:02:00"), accountId: ACCOUNT, requestId: "1", sentAt: T("10:02:01") }),
    motionDetectedWebhook({ deviceId: DEV, timestamp: T("11:40:00"), subType: "human", timeZone: TZ, accountId: ACCOUNT, requestId: "2", sentAt: T("11:40:01") }),
  ];
  const v = visitWindow(hooks, BOOKING, true);
  assert.equal(v.arrivedAt, T("10:02:00"));
  assert.equal(v.leftAt, T("11:40:00"));
  assert.equal(v.source.mode, "simulated");

  const none = visitWindow(hooks, BOOKING, false);
  assert.deepEqual(none, { arrivedAt: null, leftAt: null, eventIds: [], source: { service: "Front door camera (Ring Partner API format)", mode: "simulated", ref: "not used: visit logging consent missing" } });
});

test("visit window edge cases: no person, arrival only, human-motion arrival, history events", () => {
  const vehicleOnly: DoorEvent[] = [{ id: "v", kind: "motion", subType: "vehicle", timestamp: T("10:05:00") }];
  assert.deepEqual([visitWindow(vehicleOnly, BOOKING, true).arrivedAt, visitWindow(vehicleOnly, BOOKING, true).leftAt], [null, null]);

  const ringOnly: DoorEvent[] = [{ id: "b", kind: "button_press", subType: null, timestamp: T("10:02:00") }];
  const r = visitWindow(ringOnly, BOOKING, true);
  assert.equal(r.arrivedAt, T("10:02:00"));
  assert.equal(r.leftAt, null);
  assert.deepEqual(r.eventIds, ["b"]);

  // Window edges are inclusive: exactly 60 min before start and 120 min after end count.
  const edges: DoorEvent[] = [
    { id: "a", kind: "motion", subType: "human", timestamp: BOOKING.start - 60 * 60_000 },
    { id: "z", kind: "motion", subType: "human", timestamp: BOOKING.end + 120 * 60_000 },
  ];
  const e = visitWindow(edges, BOOKING, true);
  assert.deepEqual([e.arrivedAt, e.leftAt], [edges[0].timestamp, edges[1].timestamp]);

  // History page: ding + motion fetched with event_types=ding,motion.human.
  const page = { data: [
    historyEvent({ id: "h2", deviceId: DEV, eventType: "motion", start: T("11:40:00"), end: T("11:40:30") }),
    historyEvent({ id: "h1", deviceId: DEV, eventType: "ding", start: T("10:02:00"), end: T("10:02:20") }),
  ], links: {} };
  const asHuman = visitWindow(doorEventsFromHistory(page, { motionSubType: "human" }), BOOKING, true);
  assert.deepEqual([asHuman.arrivedAt, asHuman.leftAt, asHuman.eventIds], [T("10:02:00"), T("11:40:00"), ["h1", "h2"]]);
  const unclassified = visitWindow(doorEventsFromHistory(page), BOOKING, true);
  assert.deepEqual([unclassified.arrivedAt, unclassified.leftAt], [T("10:02:00"), null]);
});
