// Visit window from front door camera events (SPEC 3.3). Only timestamps are used:
// no video, no snapshots, no faces, no recognition. Consent not granted -> nothing is read.
//
// arrival   = first button_press / ding, or human motion, from (booking.start - 60 min) to (booking.end + 120 min)
// departure = last human motion after the arrival, in the same span
import type { SourceMode, VisitWindow } from "../types.ts";
import type { RingHistoryPage, RingWebhook } from "./ring-format.ts";

export const ARRIVAL_LOOKBACK_MS = 60 * 60_000;
export const DEPARTURE_LOOKAHEAD_MS = 120 * 60_000;
export const CAMERA_SERVICE = "Front door camera (Ring Partner API format)";

/** Normalized camera event. subType is null when the source does not classify motion. */
export interface DoorEvent {
  id: string;
  kind: "button_press" | "ding" | "motion" | "on_demand";
  subType: string | null;
  timestamp: number;
}

export function doorEventFromWebhook(w: RingWebhook): DoorEvent {
  if (w.data.type === "button_press") return { id: w.data.id, kind: "button_press", subType: null, timestamp: w.data.attributes.timestamp };
  return { id: w.data.id, kind: "motion", subType: w.data.attributes.sub_type, timestamp: w.data.attributes.timestamp };
}

/**
 * History events carry no motion subtype. When the page was fetched with event_types=ding,motion.human,
 * pass { motionSubType: "human" } so its motion events count as human motion; otherwise they don't count.
 */
export function doorEventsFromHistory(page: RingHistoryPage, opts?: { motionSubType?: string }): DoorEvent[] {
  return page.data.map((e) => ({
    id: e.id,
    kind: e.attributes.event_type,
    subType: e.attributes.event_type === "motion" ? opts?.motionSubType ?? null : null,
    timestamp: e.attributes.start,
  }));
}

export interface VisitWindowOptions {
  mode?: SourceMode; // default "simulated" (the sandbox Ring simulator)
  ref?: string; // e.g. device id or booking id
}

const isHumanMotion = (e: DoorEvent) => e.kind === "motion" && e.subType === "human";
const isArrivalSignal = (e: DoorEvent) => e.kind === "button_press" || e.kind === "ding" || isHumanMotion(e);

export function visitWindow(
  events: ReadonlyArray<DoorEvent | RingWebhook>,
  booking: { start: number; end: number },
  consentGranted: boolean,
  opts: VisitWindowOptions = {},
): VisitWindow {
  const mode = opts.mode ?? "simulated";
  if (!consentGranted) {
    return { arrivedAt: null, leftAt: null, eventIds: [], source: { service: CAMERA_SERVICE, mode, ref: "not used: visit logging consent missing" } };
  }
  const from = booking.start - ARRIVAL_LOOKBACK_MS;
  const to = booking.end + DEPARTURE_LOOKAHEAD_MS;
  const evs = events
    .map((e) => ("data" in e ? doorEventFromWebhook(e) : e))
    .filter((e) => e.timestamp >= from && e.timestamp <= to)
    .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const arrival = evs.find(isArrivalSignal);
  let departure: DoorEvent | undefined;
  if (arrival) for (const e of evs) if (isHumanMotion(e) && e.timestamp > arrival.timestamp) departure = e;
  const source = { service: CAMERA_SERVICE, mode, ...(opts.ref ? { ref: opts.ref } : {}) };
  return {
    arrivedAt: arrival ? arrival.timestamp : null,
    leftAt: departure ? departure.timestamp : null,
    eventIds: [arrival?.id, departure?.id].filter((x): x is string => typeof x === "string"),
    source,
  };
}
