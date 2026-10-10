// Adapter between the proofpay MCP server and the outside world (marketplace, license registry,
// front door camera, sandbox clock) plus the deterministic core logic (reconcile, visit window,
// webhook signature). The MCP server talks ONLY to this interface.
//
// HTTP calls go to the sandbox services (src/sandbox/server.ts, SPEC §3.4, default http://127.0.0.1:8791).
// Base URLs come from env, so the camera simulator can be swapped for the real Partner API base and a
// Playground token without code changes. Pure logic comes from src/core (lane CORE).
import type { Charge, Evidence, LicenseCheck, PaymentPlan, Photo, Professional, ScopeOfWork, SourceMode, VisitWindow } from "../core/types.ts";
import { reconcile as coreReconcile } from "../core/reconcile.ts";
import { lookupLicense as coreLookupLicense } from "../core/registry/lookup.ts";
import { loadRegistryFixtures, type RegistryFixtures } from "../core/registry/fixtures.ts";
import { verify as coreVerify } from "../core/doorbell/hmac.ts";
import { parseRingWebhook, ringHistoryPageSchema, type RingHistoryPage } from "../core/doorbell/ring-format.ts";
import { doorEventFromWebhook, doorEventsFromHistory, visitWindow as coreVisitWindow, type DoorEvent } from "../core/doorbell/visit.ts";

export type Env = {
  SPI_BASE: string; // sandbox marketplace base, e.g. http://127.0.0.1:8791/spi
  RING_API_BASE: string; // camera API base, e.g. http://127.0.0.1:8791/ring
  SIM_BASE: string; // sandbox clock base, e.g. http://127.0.0.1:8791/sim
  RING_SIGNING_KEY: string; // HMAC key for camera webhooks
  RING_TOKEN: string; // bearer for the camera history API ("sandbox" against the simulator)
  CAMERA_MODE: SourceMode; // how camera facts are labelled: "simulated" against the sandbox simulator
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
    RING_SIGNING_KEY: e.RING_SIGNING_KEY || "sandbox-signing-key", // sandbox literal, same default as src/sandbox/server.ts
    RING_TOKEN: e.RING_TOKEN ?? "sandbox",
    CAMERA_MODE: (e.CAMERA_MODE as SourceMode | undefined) ?? "simulated",
    REGISTRY_MODE: mode,
  };
}

/** One observable step of a tool call. Rendered by the host as a sub-chip with a mode badge. */
export type Step = { service: string; op: string; mode: SourceMode; ms: number; summary: string };

export type Policy = { kind: "cancellation" | "refund"; text: string };
/** A marketplace booking at ESTIMATE or CONFIRMATION stage, normalized for the add-on. */
export type Quote = {
  stage: "ESTIMATE" | "CONFIRMATION";
  alexaBookingId: string;
  partnerBookingId: string;
  status: string; // BookingStatus
  proId: string;
  businessName: string;
  title: string;
  start: number; // epoch ms
  end: number;
  scope: ScopeOfWork; // items with this pro's prices and proof rules; consent as recorded on the booking
  total: number;
  policies: Policy[];
  paymentInstrument: { id: string; wallet: string }; // card on file, e.g. "•• 42" / "sandbox"
  proConsentsToVisitLog: boolean;
  doorCode: { from: number; to: number; note: string };
};

/** A front door camera event (normalized by core) plus where it came from. Timestamps and ids only. */
export type CameraEvent = DoorEvent & { deviceId: string; accountId: string | null };

export type Invoice = { charges: Charge[]; issuedAt: number | null; invoiceId: string | null };
export type Capture = { captureId: string; amount: number; status: string; remaining: number | null };
export type BookingRequest =
  | { stage: "ESTIMATE"; proId: string; alexaBookingId: string }
  | { stage: "CONFIRMATION"; alexaBookingId: string; partnerBookingId: string; homeownerConsentToVisitLogging: boolean };

export interface Services {
  readonly registryMode: Env["REGISTRY_MODE"];
  now(): Promise<{ now: number; simulated: boolean }>;
  listProfessionals(q: { projectDescription: string; zipCode: string; trade: string }): Promise<Professional[]>;
  /** `now` = check time shown as "checked <time>" (the simulated clock in fixture mode). */
  lookupLicense(licenseNumber: string, claimedName: string, now?: number): Promise<LicenseCheck>;
  createBooking(r: BookingRequest): Promise<Quote>;
  cancelBooking(partnerBookingId: string): Promise<{ status: string }>;
  getInvoice(partnerBookingId: string): Promise<Invoice | null>; // null = not posted yet
  getPhotos(partnerBookingId: string): Promise<Photo[]>;
  capture(r: { partnerBookingId: string; amount: number; idempotencyKey: string }): Promise<Capture>;
  cameraHistory(deviceId: string): Promise<CameraEvent[]>;
  /** Constant-time check of the X-Signature header over the RAW request bytes. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | string[] | undefined): boolean;
  /** Parse a verified webhook body (Ring Partner API v1.1). Throws on anything else. */
  parseWebhook(rawBody: Buffer): CameraEvent[];
  visitWindow(events: CameraEvent[], booking: { start: number; end: number }, consentGranted: boolean): VisitWindow;
  reconcile(scope: ScopeOfWork, invoice: Charge[], evidence: Evidence): PaymentPlan;
}

// ---------- wire shapes of the sandbox services (src/sandbox/state.ts) ----------
export type SandboxBooking = {
  alexaBookingId: string; partnerBookingId: string; stage: "ESTIMATE" | "CONFIRMATION"; status: string;
  proId: string; businessName: string; title: string; serviceDescription: string;
  timeSlot: { start: number; end: number }; costEstimate: number; scope: ScopeOfWork;
  visitLogging: { proAgreed: boolean; homeownerAgreed: boolean; what: string };
  doorCode: { validFrom: number; validTo: number; simulated: true; note: string };
  payment: { cardOnFile: { label: string; last2: string; mode: string }; refundPolicy: string };
};

export function toQuote(b: SandboxBooking): Quote {
  return {
    stage: b.stage,
    alexaBookingId: b.alexaBookingId,
    partnerBookingId: b.partnerBookingId,
    status: b.status,
    proId: b.proId,
    businessName: b.businessName,
    title: b.title,
    start: b.timeSlot.start,
    end: b.timeSlot.end,
    scope: b.scope,
    total: b.scope.items.reduce((s, i) => s + i.price, 0),
    // The marketplace states a refund policy. Cancellation: nothing is charged before proof, so it costs nothing.
    policies: [
      { kind: "refund", text: b.payment.refundPolicy },
      { kind: "cancellation", text: "Nothing is charged before the work is proven, so cancelling costs nothing." },
    ],
    paymentInstrument: { id: `•• ${b.payment.cardOnFile.last2}`, wallet: b.payment.cardOnFile.mode },
    proConsentsToVisitLog: b.visitLogging.proAgreed,
    doorCode: { from: b.doorCode.validFrom, to: b.doorCode.validTo, note: b.doorCode.note },
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) { super(message); this.status = status; this.code = code; }
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
  if (!res.ok) {
    let code: string | null = null, msg = text.slice(0, 200);
    try { const j = JSON.parse(text) as { error?: { code?: string; message?: string } }; code = j.error?.code ?? null; msg = j.error?.message ?? msg; } catch { /* not JSON */ }
    throw new HttpError(res.status, code, `${init.method ?? "GET"} ${new URL(url).pathname} -> HTTP ${res.status} ${msg}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createServices(env: Env = envFromProcess()): Services {
  const spi = (p: string) => `${env.SPI_BASE}${p}`;
  let fixtures: RegistryFixtures | null = null;
  const regFixtures = () => (fixtures ??= loadRegistryFixtures());
  return {
    registryMode: env.REGISTRY_MODE,

    async now() {
      try {
        const c = await call<{ now: number }>(`${env.SIM_BASE}/clock`);
        return { now: c.now, simulated: true };
      } catch {
        return { now: Date.now(), simulated: false };
      }
    },

    async listProfessionals(q) {
      const r = await call<{ professionals: Professional[] }>(spi("/ListProfessionals"), { method: "POST", json: { trade: q.trade, serviceDescription: q.projectDescription, postalCode: q.zipCode } });
      return r.professionals;
    },

    lookupLicense(licenseNumber, claimedName, now) {
      return coreLookupLicense(licenseNumber, claimedName, { mode: env.REGISTRY_MODE, fixtures: regFixtures(), now: env.REGISTRY_MODE === "fixture" ? now : undefined });
    },

    async createBooking(r) {
      const res = await call<{ booking: SandboxBooking }>(spi("/CreateBooking"), { method: "POST", json: r });
      return toQuote(res.booking);
    },

    async cancelBooking(partnerBookingId) {
      const r = await call<{ booking: SandboxBooking }>(spi("/CancelBooking"), { method: "POST", json: { partnerBookingId } });
      return { status: r.booking.status };
    },

    async getInvoice(partnerBookingId) {
      try {
        const r = await call<{ invoice: { charges: Charge[]; issuedAt: number; invoiceId: string } }>(spi(`/invoice/${encodeURIComponent(partnerBookingId)}`));
        return { charges: r.invoice.charges, issuedAt: r.invoice.issuedAt, invoiceId: r.invoice.invoiceId };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },

    async getPhotos(partnerBookingId) {
      const r = await call<{ photos: Photo[] }>(spi(`/photos/${encodeURIComponent(partnerBookingId)}`));
      return r.photos;
    },

    async capture(r) {
      const c = await call<{ capture: { captureId: string; amount: number; status: string; remaining: number } }>(spi("/capture"), { method: "POST", json: r });
      return { captureId: c.capture.captureId, amount: c.capture.amount, status: c.capture.status, remaining: c.capture.remaining };
    },

    async cameraHistory(deviceId) {
      const out: CameraEvent[] = [];
      let path: string | undefined = `/v1/history/devices/${encodeURIComponent(deviceId)}/events?event_types=ding,motion.human`;
      for (let pages = 0; path && pages < 20; pages++) {
        const page = ringHistoryPageSchema.parse(await call(`${env.RING_API_BASE}${path}`, { headers: { Authorization: `Bearer ${env.RING_TOKEN}` } })) as RingHistoryPage;
        for (const e of doorEventsFromHistory(page, { motionSubType: "human" })) out.push({ ...e, deviceId, accountId: null });
        path = page.links.next;
      }
      return out;
    },

    verifyWebhook(rawBody, header) {
      return coreVerify(rawBody, header, env.RING_SIGNING_KEY);
    },
    parseWebhook(rawBody) {
      const w = parseRingWebhook(JSON.parse(rawBody.toString("utf8")));
      return [{ ...doorEventFromWebhook(w), deviceId: w.data.attributes.source, accountId: w.meta.account_id }];
    },
    visitWindow: (events, booking, consent) => coreVisitWindow(events, booking, consent, { mode: env.CAMERA_MODE }),
    reconcile: (scope, invoice, evidence) => coreReconcile(scope, invoice, evidence),
  };
}
