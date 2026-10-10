// Sandbox state machine: marketplace bookings, simulated clock, camera events, photos, invoice, charges, warranty.
// Booking shapes follow the Home Services SPI (Browse-and-Choose discovery + CreateBooking stage, which the SPI
// documents as experimental and for Auto-Match: our combination). Invoice, photos, charges and warranty claims are
// partner-side extensions, not Alexa SPIs.
// Pure and deterministic: no wall clock, no randomness. Ids come from counters reset by reset().
// The HTTP layer (server.ts) only parses requests, calls these methods and delivers webhooks.
import type { BookingStatus, Charge, Photo, Professional, ScopeItem, ScopeOfWork } from "../core/types.ts";
import type { Scenario } from "./scenario.ts";
import {
  buttonPressWebhook, historyEvent, motionDetectedWebhook, requestIdFor,
  type RingHistoryEvent, type RingHistoryPage, type RingWebhook,
} from "../core/doorbell/ring-format.ts";

export class SandboxError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const MARKETPLACE_SERVICE = "Marketplace (Home Services SPI shapes, sandbox)";
export const PHOTOS_SERVICE = "Marketplace job photos (sandbox)";
export const HISTORY_PAGE_SIZE = 50;

export type CardOnFile = { id: string; brand: string; last_digits: string; mode: "sandbox" };
/** Home Services SPI Purchase: charges, policies (CANCELLATION), payment instruments (CARD). Amounts in cents. */
export interface PurchaseDetails {
  charges: { chargeDescription: string; chargeCategory: "SERVICE"; amount: number; quantity: number }[];
  policies: { policyType: "CANCELLATION"; policyDescription: string; policyUrl: string }[];
  paymentInstruments: { paymentInstrumentType: "CARD"; paymentInstrumentId: string; wallet: string }[];
}

export interface Booking {
  alexaBookingId: string;
  partnerBookingId: string;
  stage: "ESTIMATE" | "CONFIRMATION";
  status: BookingStatus;
  proId: string;
  businessName: string;
  title: string;
  serviceDescription: string;
  timeSlot: { start: number; end: number };
  costEstimate: number;
  /** Scope with this pro's prices; visitLoggingConsent reflects both sides as recorded on the booking. */
  scope: ScopeOfWork;
  visitLogging: { proAgreed: boolean; homeownerAgreed: boolean; what: string };
  doorCode: { validFrom: number; validTo: number; simulated: true; note: string };
  payment: { cardOnFile: CardOnFile; refundPolicy: string; cancellationPolicy: string };
  purchaseDetails: PurchaseDetails;
  /** "service" for the booked job, "warranty_return" for a $0.00 return visit under the pro's labor warranty. */
  kind: "service" | "warranty_return";
  warrantyFor: string | null;
  createdAt: number;
  confirmedAt: number | null;
  cancelledAt: number | null;
}

export interface Invoice {
  partnerBookingId: string;
  invoiceId: string;
  issuedAt: number;
  currency: "USD";
  charges: Charge[];
  total: number;
}

export interface Capture {
  captureId: string;
  partnerBookingId: string;
  amount: number;
  capturedTotal: number;
  invoiceTotal: number;
  remaining: number;
  status: "CAPTURED";
  capturedAt: number;
  paymentMethod: CardOnFile;
  idempotencyKey: string | null;
}

export interface WarrantyOffer {
  partnerBookingId: string;
  businessName: string;
  covered: boolean;
  reason: string;
  laborWarrantyDays: number;
  jobDate: number;
  warrantyEnds: number;
  returnVisit: { start: number; end: number };
  amount: 0;
  booking: Booking | null; // set once the return visit is booked
}

export interface EmittedEvent {
  webhook: RingWebhook;
  scenarioIndex: number;
}

const VISIT_LOGGING_WHAT = "arrive/leave timestamps only, no video kept";

export class SandboxState {
  readonly scenario: Scenario;
  now = 0;
  #bookings: Booking[] = [];
  #captures: Capture[] = [];
  #emitted: EmittedEvent[] = [];
  #bookingSeq = 0;
  #captureSeq = 0;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.reset();
  }

  reset(): void {
    this.now = this.scenario.clock.start;
    this.#bookings = [];
    this.#captures = [];
    this.#emitted = [];
    this.#bookingSeq = 0;
    this.#captureSeq = 0;
  }

  // ---------- marketplace ----------
  listProfessionals(filter: { trade?: string } = {}): Professional[] {
    return this.scenario.professionals
      .filter((p) => !filter.trade || p.trade.toLowerCase() === filter.trade.toLowerCase())
      .map((p) => ({ proId: p.proId, businessName: p.businessName, trade: p.trade, rating: p.rating, reviewCount: p.reviewCount, costEstimate: p.costEstimate, claimedLicense: p.claimedLicense }));
  }

  createBooking(req: { stage: "ESTIMATE" | "CONFIRMATION"; alexaBookingId: string; proId?: string; partnerBookingId?: string; timeSlot?: { start: number; end: number }; homeownerConsentToVisitLogging?: boolean }): Booking {
    if (req.stage === "ESTIMATE") return this.#estimate(req);
    const b = this.#find(req.partnerBookingId);
    if (b.alexaBookingId !== req.alexaBookingId) throw new SandboxError(409, "booking_mismatch", "alexaBookingId does not match this booking");
    if (b.status === "CANCELLED") throw new SandboxError(409, "cancelled", "booking was cancelled");
    if (b.stage === "CONFIRMATION") return this.#view(b); // idempotent
    if (this.now >= b.timeSlot.start) throw new SandboxError(409, "slot_passed", "the time slot has already started");
    const other = this.#activeBooking();
    if (other && other.partnerBookingId !== b.partnerBookingId) throw new SandboxError(409, "slot_taken", `slot already booked (${other.partnerBookingId})`);
    b.stage = "CONFIRMATION";
    b.status = "CONFIRMED";
    b.confirmedAt = this.now;
    b.visitLogging.homeownerAgreed = req.homeownerConsentToVisitLogging === true;
    return this.#view(b);
  }

  #estimate(req: { alexaBookingId: string; proId?: string; timeSlot?: { start: number; end: number } }): Booking {
    const existing = this.#bookings.find((b) => b.alexaBookingId === req.alexaBookingId);
    if (existing) return this.#view(existing); // idempotent per alexaBookingId
    const pro = this.scenario.professionals.find((p) => p.proId === req.proId);
    if (!pro) throw new SandboxError(404, "unknown_pro", `no professional ${req.proId ?? "(missing proId)"}`);
    const slot = this.scenario.job.timeSlot;
    if (req.timeSlot && (req.timeSlot.start !== slot.start || req.timeSlot.end !== slot.end)) {
      throw new SandboxError(409, "slot_unavailable", `only ${slot.startLocal} to ${slot.endLocal} is open in the sandbox`);
    }
    if (this.now >= slot.start) throw new SandboxError(409, "slot_passed", "the time slot has already started");
    this.#bookingSeq++;
    const partnerBookingId = `PB-${1000 + this.#bookingSeq}`;
    const items: ScopeItem[] = this.scenario.job.items.map((it, i) => ({ id: it.id, description: it.description, quantity: it.quantity, price: pro.prices[i], proof: [...it.proof] }));
    const job = this.scenario.job;
    const b: Booking = {
      alexaBookingId: req.alexaBookingId,
      partnerBookingId,
      stage: "ESTIMATE",
      status: "PENDING",
      proId: pro.proId,
      businessName: pro.businessName,
      title: job.title,
      serviceDescription: job.serviceDescription,
      timeSlot: { start: slot.start, end: slot.end },
      costEstimate: pro.costEstimate,
      scope: {
        jobId: job.jobId,
        proId: pro.proId,
        items,
        permit: job.permit,
        visitLoggingConsent: { granted: false, byPro: pro.visitLoggingAgreed, byHomeowner: false, at: null, source: { service: MARKETPLACE_SERVICE, mode: "sandbox", ref: partnerBookingId } },
      },
      visitLogging: { proAgreed: pro.visitLoggingAgreed, homeownerAgreed: false, what: VISIT_LOGGING_WHAT },
      doorCode: { validFrom: job.doorCode.validFrom, validTo: job.doorCode.validTo, simulated: true, note: job.doorCode.note },
      payment: { cardOnFile: this.defaultCard(), refundPolicy: pro.refundPolicy, cancellationPolicy: pro.cancellationPolicy },
      purchaseDetails: this.#purchase(items, pro.cancellationPolicy, pro.proId),
      kind: "service",
      warrantyFor: null,
      createdAt: this.now,
      confirmedAt: null,
      cancelledAt: null,
    };
    this.#bookings.push(b);
    return this.#view(b);
  }

  defaultCard(): CardOnFile {
    const c = this.scenario.homeowner.cards.find((x) => x.default)!;
    return { id: c.id, brand: c.brand, last_digits: c.last_digits, mode: c.mode };
  }

  #purchase(items: ScopeItem[], cancellationPolicy: string, proId: string): PurchaseDetails {
    const card = this.defaultCard();
    return {
      charges: items.map((i) => ({ chargeDescription: i.description, chargeCategory: "SERVICE", amount: i.price, quantity: i.quantity })),
      policies: [{ policyType: "CANCELLATION", policyDescription: cancellationPolicy, policyUrl: `https://marketplace.sandbox.example/pros/${proId}/policies#cancellation` }],
      paymentInstruments: [{ paymentInstrumentType: "CARD", paymentInstrumentId: `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)} **** ${card.last_digits}`, wallet: "sandbox" }],
    };
  }

  // ---------- warranty (partner-side extension) ----------
  /** Coverage under the pro's labor warranty, counted from the job date; confirm=true books a $0.00 return visit. */
  warrantyClaim(req: { partnerBookingId: string; scopeItemIds: string[]; confirm: boolean }): WarrantyOffer {
    const b = this.#find(req.partnerBookingId);
    const pro = this.scenario.professionals.find((p) => p.proId === b.proId)!;
    const status = this.#statusAt(b);
    const known = new Set(b.scope.items.map((i) => i.id));
    if (!req.scopeItemIds.length || req.scopeItemIds.some((id) => !known.has(id))) throw new SandboxError(400, "unknown_items", "scopeItemIds must be items of this booking");
    const jobDate = b.timeSlot.end;
    const warrantyEnds = jobDate + pro.laborWarrantyDays * 24 * 60 * 60_000;
    const slot = this.scenario.job.warrantySlot;
    let covered = true, reason = "covered by the labor warranty";
    if (status !== "COMPLETED") { covered = false; reason = "the job is not completed"; }
    else if (pro.laborWarrantyDays === 0) { covered = false; reason = "this pro offers no labor warranty"; }
    else if (this.now > warrantyEnds) { covered = false; reason = "the labor warranty has ended"; }
    let booking = this.#bookings.find((x) => x.kind === "warranty_return" && x.warrantyFor === b.partnerBookingId) ?? null;
    if (req.confirm && covered && !booking) {
      if (this.now >= slot.start) throw new SandboxError(409, "slot_passed", "the return-visit slot has already started");
      this.#bookingSeq++;
      booking = {
        ...structuredClone(b),
        alexaBookingId: `warranty-${b.alexaBookingId}`,
        partnerBookingId: `PB-${1000 + this.#bookingSeq}`,
        stage: "CONFIRMATION",
        status: "CONFIRMED",
        title: `Warranty return visit · ${b.title}`,
        timeSlot: { start: slot.start, end: slot.end },
        costEstimate: 0,
        purchaseDetails: { ...this.#purchase([], pro.cancellationPolicy, pro.proId), charges: [{ chargeDescription: "Warranty return visit (labor warranty)", chargeCategory: "SERVICE", amount: 0, quantity: 1 }] },
        kind: "warranty_return",
        warrantyFor: b.partnerBookingId,
        createdAt: this.now,
        confirmedAt: this.now,
        cancelledAt: null,
      };
      this.#bookings.push(booking);
    }
    return { partnerBookingId: b.partnerBookingId, businessName: b.businessName, covered, reason, laborWarrantyDays: pro.laborWarrantyDays, jobDate, warrantyEnds, returnVisit: { start: slot.start, end: slot.end }, amount: 0, booking: booking ? structuredClone(booking) : null };
  }

  getBooking(partnerBookingId: string | undefined): Booking {
    return this.#view(this.#find(partnerBookingId));
  }

  cancelBooking(partnerBookingId: string | undefined): Booking {
    const b = this.#find(partnerBookingId);
    const status = this.#statusAt(b);
    if (status === "COMPLETED") throw new SandboxError(409, "completed", "a completed job can't be cancelled");
    if (status !== "CANCELLED") {
      b.status = "CANCELLED";
      b.cancelledAt = this.now;
    }
    return this.#view(b);
  }

  invoice(partnerBookingId: string): Invoice {
    const b = this.#find(partnerBookingId);
    if (!this.#isActive(b) || this.now < this.scenario.invoice.issuedAt) throw new SandboxError(404, "no_invoice", "no invoice for this booking yet");
    const priceOf = new Map(b.scope.items.map((i) => [i.id, i.price] as const));
    const charges: Charge[] = this.scenario.invoice.lines.map((l) => {
      const amount = l.priceFrom === "scope" ? priceOf.get(l.scopeItemId!)! : l.amount!;
      const c: Charge = { chargeDescription: l.chargeDescription, chargeCategory: l.chargeCategory, amount };
      if (l.scopeItemId !== undefined) c.scopeItemId = l.scopeItemId;
      if (l.quantity !== undefined) c.quantity = l.quantity;
      return c;
    });
    return { partnerBookingId: b.partnerBookingId, invoiceId: this.scenario.invoice.invoiceId, issuedAt: this.scenario.invoice.issuedAt, currency: "USD", charges, total: charges.reduce((s, c) => s + c.amount, 0) };
  }

  photos(partnerBookingId: string): Photo[] {
    const b = this.#find(partnerBookingId);
    if (!this.#isActive(b)) return [];
    return this.scenario.photos
      .filter((p) => p.takenAt <= this.now)
      .map((p) => ({ photoId: p.photoId, scopeItemId: p.scopeItemId, takenAt: p.takenAt, source: { service: PHOTOS_SERVICE, mode: "sandbox", ref: `${b.partnerBookingId}/${p.photoId}` } }));
  }

  /** Records a charge against the booking (called by checkout Complete). Never more than the invoice total. */
  capture(req: { partnerBookingId?: string; amount: number; idempotencyKey?: string; paymentMethod?: CardOnFile }): Capture {
    const b = this.#find(req.partnerBookingId);
    if (req.idempotencyKey) {
      const prior = this.#captures.find((c) => c.idempotencyKey === req.idempotencyKey);
      if (prior) {
        if (prior.partnerBookingId !== b.partnerBookingId || prior.amount !== req.amount) throw new SandboxError(409, "idempotency_conflict", "idempotency key reused with different parameters");
        return { ...prior };
      }
    }
    if (!Number.isInteger(req.amount) || req.amount <= 0) throw new SandboxError(400, "bad_amount", "amount must be a positive integer number of cents");
    const inv = this.invoice(b.partnerBookingId);
    const captured = this.#captures.filter((c) => c.partnerBookingId === b.partnerBookingId).reduce((s, c) => s + c.amount, 0);
    if (captured + req.amount > inv.total) throw new SandboxError(409, "exceeds_invoice", `capture would exceed the invoice total (${captured} already captured of ${inv.total})`);
    this.#captureSeq++;
    const c: Capture = {
      captureId: `CAP-${1000 + this.#captureSeq}`,
      partnerBookingId: b.partnerBookingId,
      amount: req.amount,
      capturedTotal: captured + req.amount,
      invoiceTotal: inv.total,
      remaining: inv.total - captured - req.amount,
      status: "CAPTURED",
      capturedAt: this.now,
      paymentMethod: { ...(req.paymentMethod ?? b.payment.cardOnFile) },
      idempotencyKey: req.idempotencyKey ?? null,
    };
    this.#captures.push(c);
    return { ...c };
  }

  charges(): Capture[] {
    return this.#captures.map((c) => ({ ...c }));
  }

  // ---------- clock + camera ----------
  /** Moves the clock forward and returns the camera webhooks that became due, in time order. */
  advance(to: number): RingWebhook[] {
    if (!Number.isInteger(to)) throw new SandboxError(400, "bad_time", "to must be epoch milliseconds or an ISO time");
    if (to < this.now) throw new SandboxError(400, "clock_backwards", "the clock only moves forward; POST /sim/reset to start over");
    const from = this.now;
    const active = this.#activeBooking() !== undefined;
    const due: RingWebhook[] = [];
    this.scenario.doorbell.events.forEach((e, i) => {
      if (e.at <= from || e.at > to) return;
      if (e.requiresBooking && !active) return;
      const webhook = this.#webhookFor(e);
      this.#emitted.push({ webhook, scenarioIndex: i });
      due.push(webhook);
    });
    due.sort((a, b) => a.data.attributes.timestamp - b.data.attributes.timestamp);
    this.now = to;
    return due;
  }

  #webhookFor(e: Scenario["doorbell"]["events"][number]): RingWebhook {
    const deviceId = this.scenario.doorbell.deviceId;
    const envelope = { accountId: this.scenario.homeowner.ringAccountId, sentAt: e.at + 1000 };
    const w = e.type === "button_press"
      ? buttonPressWebhook({ ...envelope, requestId: "", deviceId, timestamp: e.at })
      : motionDetectedWebhook({ ...envelope, requestId: "", deviceId, timestamp: e.at, subType: e.subType!, timeZone: this.scenario.timeZone });
    w.meta.request_id = requestIdFor(`${this.scenario.id}:${w.data.id}`);
    return w;
  }

  emitted(): EmittedEvent[] {
    return this.#emitted.map((e) => ({ ...e }));
  }

  /** GET /v1/history/devices/{id}/events: newest first, event_types filter (composite "motion.human"), page[key] cursor. */
  history(deviceId: string, query: { eventTypes?: string; pageKey?: string }): RingHistoryPage {
    if (deviceId !== this.scenario.doorbell.deviceId) throw new SandboxError(404, "unknown_device", `no device ${deviceId}`);
    const filters = (query.eventTypes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const matches = (type: string, sub: string | null) =>
      filters.length === 0 || filters.some((f) => { const [t, s] = f.split("."); return t === type && (s === undefined || s === sub); });
    let events: RingHistoryEvent[] = this.#emitted
      .filter((e) => e.webhook.data.attributes.timestamp <= this.now)
      .map((e) => {
        const w = e.webhook;
        const ts = w.data.attributes.timestamp;
        const isDing = w.data.type === "button_press";
        return {
          sub: isDing ? null : (w.data.attributes as { sub_type: string }).sub_type,
          ev: historyEvent({ id: requestIdFor(`history:${w.data.id}`), deviceId, eventType: isDing ? "ding" : "motion", start: ts, end: ts + (isDing ? 20_000 : 30_000) }),
        };
      })
      .filter((x) => matches(x.ev.attributes.event_type, x.sub))
      .map((x) => x.ev)
      .sort((a, b) => b.attributes.start - a.attributes.start || (a.id < b.id ? -1 : 1));
    if (query.pageKey) {
      const key = Date.parse(query.pageKey);
      if (Number.isNaN(key)) throw new SandboxError(400, "bad_cursor", "page[key] must be an ISO timestamp");
      events = events.filter((e) => e.attributes.start < key);
    }
    const page = events.slice(0, HISTORY_PAGE_SIZE);
    const links: RingHistoryPage["links"] = {};
    if (events.length > HISTORY_PAGE_SIZE) {
      const cursor = new Date(page[page.length - 1].attributes.start).toISOString();
      const params = new URLSearchParams();
      if (filters.length) params.set("event_types", filters.join(","));
      params.set("page[key]", cursor);
      links.next = `/v1/history/devices/${deviceId}/events?${params.toString()}`;
    }
    return { data: page, links };
  }

  // ---------- helpers ----------
  bookings(): Booking[] {
    return this.#bookings.map((b) => this.#view(b));
  }

  #find(partnerBookingId: string | undefined): Booking {
    const b = this.#bookings.find((x) => x.partnerBookingId === partnerBookingId);
    if (!b) throw new SandboxError(404, "unknown_booking", `no booking ${partnerBookingId ?? "(missing partnerBookingId)"}`);
    return b;
  }

  #isActive(b: Booking): boolean {
    return b.stage === "CONFIRMATION" && b.status !== "CANCELLED";
  }

  #activeBooking(): Booking | undefined {
    return this.#bookings.find((b) => b.kind === "service" && this.#isActive(b));
  }

  /** Visit progress is derived from the clock: arrival -> IN_PROGRESS, departure -> COMPLETED. */
  #statusAt(b: Booking): BookingStatus {
    if (!this.#isActive(b) || b.kind === "warranty_return") return b.status;
    const visit = this.scenario.doorbell.events.filter((e) => e.requiresBooking && (e.type === "button_press" || e.subType === "human"));
    if (visit.length === 0) return "CONFIRMED";
    const arrival = Math.min(...visit.map((e) => e.at));
    const departure = Math.max(...visit.map((e) => e.at));
    const wasActiveForVisit = this.#emitted.some((e) => this.scenario.doorbell.events[e.scenarioIndex].requiresBooking);
    if (!wasActiveForVisit) return "CONFIRMED";
    if (this.now >= departure) return "COMPLETED";
    if (this.now >= arrival) return "IN_PROGRESS";
    return "CONFIRMED";
  }

  #view(b: Booking): Booking {
    const status = this.#statusAt(b);
    const consent = { ...b.scope.visitLoggingConsent };
    consent.byPro = b.visitLogging.proAgreed;
    consent.byHomeowner = b.visitLogging.homeownerAgreed;
    consent.granted = consent.byPro && consent.byHomeowner;
    consent.at = consent.granted ? b.confirmedAt : null;
    return structuredClone({ ...b, status, scope: { ...b.scope, visitLoggingConsent: consent } });
  }
}
