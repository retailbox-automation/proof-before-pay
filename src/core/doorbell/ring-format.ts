// Ring Partner API v1.1 payload shapes, as documented at
// https://developer.amazon.com/docs/ring/api-documentation.html (fetched 2026-10-10):
//   webhooks: motion_detected, button_press (JSON:API style, meta.version "1.1" with account_id)
//   history:  GET /v1/history/devices/{device_id}/events -> { data: history-events[], links.next }
// Builders are pure and deterministic: every id and time comes from the caller.
import { createHash } from "node:crypto";
import { z } from "zod";

export const RING_WEBHOOK_VERSION = "1.1" as const;
export const RING_MOTION_SUB_TYPES = ["motion", "human", "vehicle", "package_delivery", "other_motion"] as const;
export type RingMotionSubType = (typeof RING_MOTION_SUB_TYPES)[number];
/**
 * The docs show both "<device_id>_motion_<timestamp>" (payload example) and "<device_id>_<sub_type>_<timestamp>"
 * (field table) for motion ids. SPEC 3.3 follows the example; the id is opaque to consumers either way.
 */
export const MOTION_ID_INFIX = "motion";

export interface RingWebhookMeta {
  version: typeof RING_WEBHOOK_VERSION;
  time: string; // ISO 8601, when Ring sent the webhook
  request_id: string; // idempotency key
  account_id: string; // e.g. "ava1.ring.account.XXXYYY"
}
export interface RingDeviceRelationships {
  devices: { links: { self: string } };
}
export interface RingMotionDetectedWebhook {
  meta: RingWebhookMeta;
  data: {
    id: string;
    type: "motion_detected";
    attributes: {
      source: string;
      source_type: "devices";
      timestamp: number; // epoch ms
      timestamp_readable: string; // "YYYY-MM-DD HH:MM:SS", device-local, no offset
      sub_type: RingMotionSubType;
      component_ids?: string[]; // multi-camera devices only
    };
    relationships: RingDeviceRelationships;
  };
}
export interface RingButtonPressWebhook {
  meta: RingWebhookMeta;
  data: {
    id: string;
    type: "button_press";
    attributes: { source: string; source_type: "devices"; timestamp: number };
    relationships: RingDeviceRelationships;
  };
}
export type RingWebhook = RingMotionDetectedWebhook | RingButtonPressWebhook;

export interface WebhookEnvelope {
  accountId: string;
  requestId: string;
  /** When the webhook is sent (epoch ms) -> meta.time. */
  sentAt: number;
}

/** "YYYY-MM-DD HH:MM:SS" in the given IANA zone (Ring renders device-local time without an offset). */
export function timestampReadable(ms: number, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Deterministic UUID-shaped id from a seed (sandbox request ids). */
export function requestIdFor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function meta(e: WebhookEnvelope): RingWebhookMeta {
  return { version: RING_WEBHOOK_VERSION, time: new Date(e.sentAt).toISOString(), request_id: e.requestId, account_id: e.accountId };
}

const devicesRel = (deviceId: string): RingDeviceRelationships => ({ devices: { links: { self: `/v1/devices/${deviceId}` } } });

export function motionDetectedWebhook(a: WebhookEnvelope & { deviceId: string; timestamp: number; subType: RingMotionSubType; timeZone?: string; componentIds?: string[] }): RingMotionDetectedWebhook {
  const attributes: RingMotionDetectedWebhook["data"]["attributes"] = {
    source: a.deviceId,
    source_type: "devices",
    timestamp: a.timestamp,
    timestamp_readable: timestampReadable(a.timestamp, a.timeZone),
    sub_type: a.subType,
  };
  if (a.componentIds) attributes.component_ids = [...a.componentIds];
  return {
    meta: meta(a),
    data: { id: `${a.deviceId}_${MOTION_ID_INFIX}_${a.timestamp}`, type: "motion_detected", attributes, relationships: devicesRel(a.deviceId) },
  };
}

export function buttonPressWebhook(a: WebhookEnvelope & { deviceId: string; timestamp: number }): RingButtonPressWebhook {
  return {
    meta: meta(a),
    data: {
      id: `${a.deviceId}_button_press_${a.timestamp}`,
      type: "button_press",
      attributes: { source: a.deviceId, source_type: "devices", timestamp: a.timestamp },
      relationships: devicesRel(a.deviceId),
    },
  };
}

// ---------- History API ----------
export type RingHistoryEventType = "motion" | "ding" | "on_demand";
export interface RingHistoryEvent {
  type: "history-events";
  id: string; // opaque
  attributes: { event_type: RingHistoryEventType; is_third_party_reviewed: boolean; start: number; end: number };
  relationships: { source: { data: { type: "devices"; id: string } } };
}
export interface RingHistoryPage {
  data: RingHistoryEvent[];
  links: { next?: string }; // absent when there are no more pages
}

export function historyEvent(a: { id: string; deviceId: string; eventType: RingHistoryEventType; start: number; end: number; reviewed?: boolean }): RingHistoryEvent {
  return {
    type: "history-events",
    id: a.id,
    attributes: { event_type: a.eventType, is_third_party_reviewed: a.reviewed ?? false, start: a.start, end: a.end },
    relationships: { source: { data: { type: "devices", id: a.deviceId } } },
  };
}

// ---------- Validation of received payloads (after the HMAC check) ----------
const metaSchema = z.object({ version: z.literal("1.1"), time: z.string(), request_id: z.string().min(1), account_id: z.string().min(1) });
const relSchema = z.object({ devices: z.object({ links: z.object({ self: z.string() }) }) });
export const ringWebhookSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("motion_detected"),
    id: z.string().min(1),
    attributes: z.object({
      source: z.string().min(1),
      source_type: z.literal("devices"),
      timestamp: z.number().int().nonnegative(),
      timestamp_readable: z.string(),
      sub_type: z.enum(RING_MOTION_SUB_TYPES),
      component_ids: z.array(z.string()).optional(),
    }),
    relationships: relSchema,
  }),
  z.object({
    type: z.literal("button_press"),
    id: z.string().min(1),
    attributes: z.object({ source: z.string().min(1), source_type: z.literal("devices"), timestamp: z.number().int().nonnegative() }),
    relationships: relSchema,
  }),
]);
const webhookEnvelopeSchema = z.object({ meta: metaSchema, data: ringWebhookSchema });

/** Throws a ZodError on anything that is not a v1.1 motion_detected / button_press payload. */
export function parseRingWebhook(json: unknown): RingWebhook {
  return webhookEnvelopeSchema.parse(json) as RingWebhook;
}

export const ringHistoryPageSchema = z.object({
  data: z.array(z.object({
    type: z.literal("history-events"),
    id: z.string(),
    attributes: z.object({ event_type: z.enum(["motion", "ding", "on_demand"]), is_third_party_reviewed: z.boolean(), start: z.number(), end: z.number() }),
    relationships: z.object({ source: z.object({ data: z.object({ type: z.literal("devices"), id: z.string() }) }) }),
  })),
  links: z.object({ next: z.string().optional() }),
});
