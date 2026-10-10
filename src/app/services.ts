// Adapter between the proofpay MCP server and the outside world (marketplace, license registry,
// front door camera, sandbox clock) plus the deterministic core logic (reconcile, visit window,
// webhook signature). The MCP server talks ONLY to this interface.
//
// HTTP calls go to the sandbox services (SPEC §3.4, default http://127.0.0.1:8791).
// Pure logic comes from the CORE lane modules; until they land it comes from ./fake-services.ts
// (temporary, clearly named, returns the SPEC §1 demo numbers).
import type { Charge, LicenseCheck, PaymentPlan, Photo, Professional, ScopeOfWork, SourceMode, VisitWindow, Evidence } from "../core/types.ts";
// TEMPORARY: logic fakes until lane CORE lands src/core/{reconcile,registry,doorbell}. Swap these imports only.
import { lookupLicense as coreLookupLicense, reconcile as coreReconcile, verifySignature as coreVerify, visitWindow as coreVisitWindow } from "./fake-services.ts";

export type Env = {
  SPI_BASE: string; // sandbox marketplace base, e.g. http://127.0.0.1:8791/spi
  RING_API_BASE: string; // camera API base, e.g. http://127.0.0.1:8791/ring
  SIM_BASE: string; // sandbox clock base, e.g. http://127.0.0.1:8791/sim
  RING_SIGNING_KEY: string; // HMAC key for camera webhooks
  RING_TOKEN: string; // bearer for the camera history API ("sandbox" against the simulator)
  REGISTRY_MODE: "fixture" | "live" | "auto";
};

export function envFromProcess(e: NodeJS.ProcessEnv = process.env): Env {
  const sandbox = e.SANDBOX_BASE ?? `http://127.0.0.1:${e.SANDBOX_PORT ?? "8791"}`;
  const mode = (e.REGISTRY_MODE ?? "fixture") as Env["REGISTRY_MODE"];
  if (!["fixture", "live", "auto"].includes(mode)) throw new Error(`REGISTRY_MODE must be fixture|live|auto, got ${mode}`);
  return {
    SPI_BASE: e.SPI_BASE ?? `${sandbox}/spi`,
    RING_API_BASE: e.RING_API_BASE ?? `${sandbox}/ring`,
    SIM_BASE: e.SIM_BASE ?? `${sandbox}/sim`,
    RING_SIGNING_KEY: e.RING_SIGNING_KEY ?? "sandbox-signing-key-not-secret",
    RING_TOKEN: e.RING_TOKEN ?? "sandbox",
    REGISTRY_MODE: mode,
  };
}

/** One observable step of a tool call. Rendered by the host as a sub-chip with a mode badge. */
export type Step = { service: string; op: string; mode: SourceMode; ms: number; summary: string };

export type Policy = { kind: "cancellation" | "refund"; text: string };
export type Quote = {
  stage: "ESTIMATE" | "CONFIRMATION";
  alexaBookingId: string;
  partnerBookingId: string;
  status: string; // BookingStatus
  proId: string;
  start: number; // epoch ms
  end: number;
  lines: { description: string; quantity: number; price: number }[]; // estimate lines, cents
  total: number;
  policies: Policy[];
  paymentInstrument: { id: string; wallet: string }; // card on file, e.g. "•• 42" / "sandbox"
  proConsentsToVisitLog: boolean;
};

/** A front door camera event as received (webhook) or fetched (history API). Timestamps only. */
export type CameraEvent = {
  id: string;
  kind: "button_press" | "motion_detected" | "ding" | "motion" | "on_demand";
  subType: string | null; // "human" for person motion
  at: number; // epoch ms
  deviceId: string;
  accountId: string | null;
};

export type Invoice = { charges: Charge[]; submittedAt: number | null };
export type Capture = { captureId: string; amount: number; status: string };

export interface Services {
  readonly registryMode: Env["REGISTRY_MODE"];
  readonly signingKey: string;
  now(): Promise<{ now: number; simulated: boolean }>;
  listProfessionals(q: { projectDescription: string; zipCode: string; trade: string }): Promise<Professional[]>;
  /** `now` = check time shown as "checked <time>" (the simulated clock in fixture mode). */
  lookupLicense(licenseNumber: string, claimedName: string, now?: number): Promise<LicenseCheck>;
  createBooking(r: { stage: "ESTIMATE" | "CONFIRMATION"; proId: string; alexaBookingId: string; partnerBookingId?: string; projectDescription: string }): Promise<Quote>;
  cancelBooking(partnerBookingId: string, reason: string): Promise<{ status: string }>;
  getInvoice(partnerBookingId: string): Promise<Invoice | null>; // null = not posted yet
  getPhotos(partnerBookingId: string): Promise<Photo[]>;
  capture(r: { partnerBookingId: string; amount: number; idempotencyKey: string }): Promise<Capture>;
  cameraHistory(deviceId: string, from: number, to: number): Promise<CameraEvent[]>;
  /** Constant-time check of the X-Signature header over the RAW request bytes. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  /** Parse a verified webhook body into camera events (empty array if it carries none). */
  parseWebhook(rawBody: Buffer): CameraEvent[];
  visitWindow(events: CameraEvent[], booking: { start: number; end: number }, consentGranted: boolean): VisitWindow;
  reconcile(scope: ScopeOfWork, invoice: Charge[], evidence: Evidence): PaymentPlan;
}

// ---------- wire shapes of the sandbox services (Home Services SPI style) ----------
export type SpiProfessional = {
  professionalId: string; businessName: string; trade: string; rating: number; reviewCount: number;
  costEstimate: number; // cents
  licenseNumber: string;
};
export type SpiCharge = { chargeDescription: string; chargeCategory: Charge["chargeCategory"]; amount: number; quantity?: number; scopeItemId?: string };
export type SpiCreateBookingResponse = {
  stage: "ESTIMATE" | "CONFIRMATION";
  booking: { alexaBookingId: string; partnerBookingId: string; status: string; professionalId: string; appointment: { start: string; end: string } };
  purchaseDetails: {
    charges: SpiCharge[];
    total: number;
    policies: { policyType: "CANCELLATION" | "REFUND"; text: string }[];
    paymentInstruments: { paymentInstrumentType: string; paymentInstrumentId: string; wallet: string }[];
  };
  visitLogging?: { proConsent: boolean };
};
export type HistoryResponse = {
  data: { type: "history-events"; id: string; attributes: { event_type: string; start: string | number; end?: string | number }; relationships: { source: { data: { type: "devices"; id: string } } } }[];
  links?: { next?: string | null };
};

const toMs = (t: string | number): number => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));

export function toProfessional(p: SpiProfessional): Professional {
  return { proId: p.professionalId, businessName: p.businessName, trade: p.trade, rating: p.rating, reviewCount: p.reviewCount, costEstimate: p.costEstimate, claimedLicense: p.licenseNumber };
}

export function toQuote(r: SpiCreateBookingResponse): Quote {
  const pd = r.purchaseDetails;
  const card = pd.paymentInstruments[0] ?? { paymentInstrumentId: "card on file", wallet: "sandbox" };
  return {
    stage: r.stage,
    alexaBookingId: r.booking.alexaBookingId,
    partnerBookingId: r.booking.partnerBookingId,
    status: r.booking.status,
    proId: r.booking.professionalId,
    start: toMs(r.booking.appointment.start),
    end: toMs(r.booking.appointment.end),
    lines: pd.charges.map((c) => ({ description: c.chargeDescription, quantity: c.quantity ?? 1, price: c.amount })),
    total: pd.total,
    policies: pd.policies.map((p) => ({ kind: p.policyType === "REFUND" ? "refund" : "cancellation", text: p.text })),
    paymentInstrument: { id: card.paymentInstrumentId, wallet: card.wallet },
    proConsentsToVisitLog: !!r.visitLogging?.proConsent,
  };
}

export function fromHistory(r: HistoryResponse): CameraEvent[] {
  return r.data.map((e) => ({
    id: e.id,
    kind: (e.attributes.event_type === "ding" ? "ding" : e.attributes.event_type === "on_demand" ? "on_demand" : "motion") as CameraEvent["kind"],
    subType: e.attributes.event_type === "motion" ? "human" : null,
    at: toMs(e.attributes.start),
    deviceId: e.relationships.source.data.id,
    accountId: null,
  }));
}

/** Ring Partner API v1.1 webhook body -> camera events. Only timestamps and ids are kept. */
export function parseWebhook(rawBody: Buffer): CameraEvent[] {
  const j = JSON.parse(rawBody.toString("utf8")) as {
    data?: { type?: string; id?: string; attributes?: { source?: string; timestamp?: number | string; sub_type?: string } };
    meta?: { account_id?: string };
  };
  const d = j.data;
  if (!d?.type || !d.id || d.attributes?.timestamp === undefined || !d.attributes.source) return [];
  if (d.type !== "motion_detected" && d.type !== "button_press") return [];
  return [{ id: d.id, kind: d.type, subType: d.attributes.sub_type ?? null, at: toMs(d.attributes.timestamp), deviceId: d.attributes.source, accountId: j.meta?.account_id ?? null }];
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "GET"} ${url} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createServices(env: Env = envFromProcess()): Services {
  const spi = (p: string) => `${env.SPI_BASE}${p}`;
  return {
    registryMode: env.REGISTRY_MODE,
    signingKey: env.RING_SIGNING_KEY,

    async now() {
      try {
        const c = await call<{ now: number }>(`${env.SIM_BASE}/clock`);
        return { now: c.now, simulated: true };
      } catch {
        return { now: Date.now(), simulated: false };
      }
    },

    async listProfessionals(q) {
      const r = await call<{ professionals: SpiProfessional[] }>(spi("/ListProfessionals"), {
        method: "POST",
        json: { zipCode: q.zipCode, projectDescription: q.projectDescription, service: { serviceId: q.trade } },
      });
      return r.professionals.map(toProfessional);
    },

    lookupLicense(licenseNumber, claimedName, now) {
      return coreLookupLicense(licenseNumber, claimedName, { mode: env.REGISTRY_MODE, now });
    },

    async createBooking(r) {
      const res = await call<SpiCreateBookingResponse>(spi("/CreateBooking"), {
        method: "POST",
        json: {
          stage: r.stage,
          alexaBookingId: r.alexaBookingId,
          partnerBookingId: r.partnerBookingId,
          professionalId: r.proId,
          project: { projectDescription: r.projectDescription },
          paymentInstruments: [{ paymentInstrumentType: "CARD", paymentInstrumentId: "card-on-file", wallet: "sandbox" }],
        },
      });
      return toQuote(res);
    },

    async cancelBooking(partnerBookingId, reason) {
      const r = await call<{ bookingStatus: string }>(spi("/CancelBooking"), { method: "POST", json: { partnerBookingId, cancellationReason: reason } });
      return { status: r.bookingStatus };
    },

    async getInvoice(partnerBookingId) {
      try {
        return await call<Invoice>(spi(`/invoice/${encodeURIComponent(partnerBookingId)}`));
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },

    async getPhotos(partnerBookingId) {
      const r = await call<{ photos: { photoId: string; scopeItemId: string | null; takenAt: number }[] }>(spi(`/photos/${encodeURIComponent(partnerBookingId)}`));
      return r.photos.map((p) => ({ ...p, source: { service: "Marketplace job photos", mode: "sandbox" as const, ref: p.photoId } }));
    },

    async capture(r) {
      return call<Capture>(spi("/capture"), { method: "POST", json: r });
    },

    async cameraHistory(deviceId, from, to) {
      const r = await call<HistoryResponse>(
        `${env.RING_API_BASE}/v1/history/devices/${encodeURIComponent(deviceId)}/events?start=${from}&end=${to}`,
        { headers: { Authorization: `Bearer ${env.RING_TOKEN}` } },
      );
      return fromHistory(r);
    },

    verifyWebhook(rawBody, header) {
      return coreVerify(rawBody, header, env.RING_SIGNING_KEY);
    },
    parseWebhook,
    visitWindow: (events, booking, consent) => coreVisitWindow(events, booking, consent),
    reconcile: (scope, invoice, evidence) => coreReconcile(scope, invoice, evidence),
  };
}
