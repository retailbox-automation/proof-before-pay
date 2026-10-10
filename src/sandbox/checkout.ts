// UCP-shaped checkout endpoints of the partner backend (sandbox). In the real product Alexa+ owns checkout: it calls
// these endpoints itself, handles the voice PIN and the payment instrument, and confirms the order. The add-on only
// prepares the session (POST /partner/checkout/prepare: a partner-side extension, not an Alexa SPI and not UCP) whose
// line items are the PROVEN items of one reconcile-v1 plan. Here the simulated "Alexa+ checkout" layer in our host
// plays the Alexa+ side.
//
//   POST /checkout-sessions               Create  (Idempotency-Key required) -> 201
//   GET  /checkout-sessions/{id}          Get
//   PUT  /checkout-sessions/{id}          Update  (full replace)
//   POST /checkout-sessions/{id}/complete Complete (Idempotency-Key required); body carries only the instrument
//   POST /checkout-sessions/{id}/cancel   Cancel
//   GET  /.well-known/ucp                 discovery profile
//
// Rules (Alexa+ checkout docs, implement-checkout-endpoints / checkout-integration, snapshot 2026-10-03):
// - 201 for Create, 200 for everything else that is a business outcome, including a decline (status "incomplete" +
//   message "payment_failed"); 4xx only for protocol errors (auth, idempotency conflict, malformed, tampered cart).
// - Idempotency-Key: same key + same body -> the stored response, verbatim; same key + different body -> 409. Kept 24 h.
// - The backend is the authority on price: line items must be exactly the prepared proven items; at Complete the
//   session total must equal the proven total of the plan it was prepared from (checked by plan hash).
// - Stored payment method handler "partner_card_on_file": the instrument must be one returned at Create for this user.
// - Completed sessions are immutable.
import { createHash } from "node:crypto";
import type { SandboxState } from "./state.ts";
import { SandboxError } from "./state.ts";

export const UCP_VERSION = "2026-04-08";
export const STORED_HANDLER = "com.amazon.payments.stored_payment_method";
export const STORED_HANDLER_ID = "partner_card_on_file";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SESSION_TTL_MS = 6 * 60 * 60_000;

type Total = { type: "subtotal" | "fee" | "total"; amount: number };
type Message = { type: "error" | "info"; code: string; content: string; severity?: "recoverable" | "unrecoverable"; path?: string };
type Instrument = { id: string; handler_id: string; type: "card"; display: { brand: string; last_digits: string; expiry_month: string; expiry_year: string } };
export type CheckoutSession = {
  id: string;
  status: "incomplete" | "ready_for_complete" | "completed" | "canceled";
  currency: "USD";
  line_items: { id: string; item: { id: string; title: string; price: number }; quantity: number; totals: Total[] }[];
  totals: Total[];
  buyer?: { first_name?: string; last_name?: string; email?: string };
  ucp: { version: string; capabilities: Record<string, { version: string }[]>; payment_handlers: Record<string, { id: string; version: string; available_instruments: { type: string }[] }[]> };
  payment: { instruments: Instrument[] };
  messages: Message[];
  links: { type: "refund_policy" | "terms_of_service"; title: string; url: string }[];
  expires_at: string;
  order?: { id: string; permalink_url: string };
  /** Partner-side fields (not UCP): which booking and which reconcile-v1 plan this session pays. */
  metadata: { partner_booking_id: string; plan_hash: string; seller: string; merchant_of_record: string; cancel_reason?: string };
};
type Entry = { userId: string; session: CheckoutSession; createdAt: number };
type Quote = { planHash: string; amount: number; itemIds: string[] };
export type Reply = { status: number; body: unknown };

const ucpBlock = () => ({
  version: UCP_VERSION,
  capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }] },
  payment_handlers: { [STORED_HANDLER]: [{ id: STORED_HANDLER_ID, version: UCP_VERSION, available_instruments: [{ type: "card" }] }] },
});

export function ucpProfile(baseUrl: string): unknown {
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION, spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout/` }] },
      services: { "dev.ucp.shopping": [{ version: UCP_VERSION, transport: "rest", endpoint: baseUrl }] },
      payment_handlers: ucpBlock().payment_handlers,
    },
    note: "Sandbox partner backend for Proof Before Pay. Not a real merchant; no real money moves.",
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
const bodyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export class CheckoutStore {
  #state: () => SandboxState;
  #sessions = new Map<string, Entry>();
  #quotes = new Map<string, Quote>(); // partnerBookingId -> latest prepared quote
  #idem = new Map<string, { hash: string; reply: Reply; at: number }>();
  #seq = 0;
  #orders = 0;

  constructor(state: () => SandboxState) {
    this.#state = state;
  }

  reset(): void {
    this.#sessions.clear(); this.#quotes.clear(); this.#idem.clear(); this.#seq = 0; this.#orders = 0;
  }

  /** Same key + same body -> stored reply; same key + other body -> 409. Only 2xx replies are stored. */
  idempotent(userId: string, op: string, key: string | undefined, raw: string, required: boolean, run: () => Reply): Reply {
    if (!key) {
      if (required) throw new SandboxError(400, "missing_idempotency_key", "Idempotency-Key header is required");
      return run();
    }
    const k = `${userId}|${op}|${key}`;
    const now = Date.now();
    const prior = this.#idem.get(k);
    if (prior && now - prior.at < IDEMPOTENCY_TTL_MS) {
      if (prior.hash === bodyHash(raw)) return prior.reply;
      return { status: 409, body: { code: "idempotency_conflict", content: "Key was used with a different request body" } };
    }
    const reply = run();
    if (reply.status >= 200 && reply.status < 300) this.#idem.set(k, { hash: bodyHash(raw), reply: structuredClone(reply), at: now });
    return reply;
  }

  // ---------- partner-side extension: called by the add-on (prepare_checkout) ----------
  prepare(userId: string, req: { partnerBookingId: string; scopeItemIds: string[]; amount: number; planHash: string }): CheckoutSession {
    const st = this.#state();
    const b = st.getBooking(req.partnerBookingId);
    if (b.kind !== "service" || b.stage !== "CONFIRMATION" || b.status === "CANCELLED") throw new SandboxError(409, "not_payable", "only a confirmed service booking can be paid");
    st.invoice(b.partnerBookingId); // throws 404 no_invoice until the pro has invoiced
    if (!/^[0-9a-f]{64}$/.test(req.planHash)) throw new SandboxError(400, "bad_plan_hash", "planHash must be a sha256 hex digest");
    const ids = [...new Set(req.scopeItemIds)];
    if (!ids.length || ids.length !== req.scopeItemIds.length) throw new SandboxError(400, "bad_items", "scopeItemIds must be a non-empty list without duplicates");
    const items = ids.map((id) => b.scope.items.find((i) => i.id === id));
    if (items.some((i) => !i)) throw new SandboxError(400, "unknown_items", "every scopeItemId must be an item of this booking's scope");
    const authoritative = items.reduce((s, i) => s + i!.price, 0);
    if (req.amount !== authoritative) throw new SandboxError(409, "amount_mismatch", `amount ${req.amount} != proven items total ${authoritative}`);
    const forBooking = [...this.#sessions.values()].filter((e) => e.userId === userId && e.session.metadata.partner_booking_id === b.partnerBookingId);
    if (forBooking.some((e) => e.session.status === "completed" && e.session.metadata.plan_hash === req.planHash)) {
      throw new SandboxError(409, "already_completed", "this plan has already been paid");
    }
    this.#quotes.set(b.partnerBookingId, { planHash: req.planHash, amount: authoritative, itemIds: ids });
    const open = forBooking.find((e) => (e.session.status === "incomplete" || e.session.status === "ready_for_complete") && e.session.metadata.plan_hash === req.planHash && sameSet(e.session.line_items.map((l) => l.item.id), ids.map((id) => `${b.partnerBookingId}:${id}`)));
    for (const e of forBooking) {
      if (e !== open && (e.session.status === "incomplete" || e.session.status === "ready_for_complete")) {
        e.session.status = "canceled";
        e.session.metadata.cancel_reason = "quote_changed";
        e.session.messages = [{ type: "error", code: "quote_changed", content: "The proven items changed; this checkout was replaced.", severity: "unrecoverable" }];
      }
    }
    if (open) return structuredClone(open.session);
    const card = st.scenario.homeowner.cards;
    const id = `cs_${1000 + ++this.#seq}`;
    const lineItems = items.map((i, n) => ({
      id: `li_${n + 1}`,
      item: { id: `${b.partnerBookingId}:${i!.id}`, title: i!.description, price: i!.price },
      quantity: 1,
      totals: [{ type: "subtotal" as const, amount: i!.price }, { type: "total" as const, amount: i!.price }],
    }));
    const session: CheckoutSession = {
      id,
      status: "incomplete",
      currency: "USD",
      line_items: lineItems,
      totals: [{ type: "subtotal", amount: authoritative }, { type: "fee", amount: 0 }, { type: "total", amount: authoritative }],
      ucp: ucpBlock(),
      payment: { instruments: card.map((c) => ({ id: c.id, handler_id: STORED_HANDLER_ID, type: "card" as const, display: { brand: c.brand, last_digits: c.last_digits, expiry_month: c.expiry_month, expiry_year: c.expiry_year } })) },
      messages: [{ type: "error", code: "missing", path: "$.buyer", content: "Buyer details are required", severity: "recoverable" }],
      links: [
        { type: "refund_policy", title: `Refund policy · ${b.businessName}`, url: `https://marketplace.sandbox.example/pros/${b.proId}/policies#refund` },
        { type: "terms_of_service", title: "Marketplace terms (sandbox)", url: "https://marketplace.sandbox.example/terms" },
      ],
      expires_at: new Date(st.now + SESSION_TTL_MS).toISOString(),
      metadata: { partner_booking_id: b.partnerBookingId, plan_hash: req.planHash, seller: b.businessName, merchant_of_record: `${b.businessName} (via the marketplace)` },
    };
    this.#sessions.set(id, { userId, session, createdAt: st.now });
    return structuredClone(session);
  }

  // ---------- UCP endpoints: called by Alexa+ (here: the simulated checkout layer) ----------
  #own(userId: string, id: string): Entry {
    const e = this.#sessions.get(id);
    if (!e || e.userId !== userId) throw new SandboxError(404, "not_found", `no checkout session ${id}`);
    return e;
  }

  #checkLines(e: Entry, lines: unknown): void {
    if (!Array.isArray(lines) || !lines.length) throw new SandboxError(400, "bad_request", "line_items[] is required");
    const want = new Map(e.session.line_items.map((l) => [l.item.id, l.item.price]));
    const got = lines as { item?: { id?: unknown; price?: unknown }; quantity?: unknown }[];
    const ok = got.length === want.size && got.every((l) => typeof l.item?.id === "string" && want.has(l.item.id) && (l.quantity === undefined || l.quantity === 1) && (l.item.price === undefined || l.item.price === want.get(l.item.id)));
    if (!ok || new Set(got.map((l) => l.item?.id)).size !== got.length) {
      throw new SandboxError(409, "quote_mismatch", "line items must be exactly the proven items prepared for this booking, at their prepared prices");
    }
  }

  #applyBuyer(e: Entry, buyer: unknown): void {
    if (buyer && typeof buyer === "object") {
      const b = buyer as Record<string, unknown>;
      e.session.buyer = { first_name: String(b.first_name ?? ""), last_name: String(b.last_name ?? ""), email: b.email ? String(b.email) : undefined };
    }
    const ready = !!e.session.buyer?.first_name;
    e.session.status = ready ? "ready_for_complete" : "incomplete";
    e.session.messages = ready ? [] : [{ type: "error", code: "missing", path: "$.buyer", content: "Buyer details are required", severity: "recoverable" }];
  }

  create(userId: string, body: { line_items?: unknown; buyer?: unknown }): Reply {
    const lines = body.line_items;
    if (!Array.isArray(lines) || !lines.length) throw new SandboxError(400, "bad_request", "line_items[] is required");
    const ids = (lines as { item?: { id?: unknown } }[]).map((l) => String(l.item?.id ?? ""));
    const open = [...this.#sessions.values()].filter((e) => e.userId === userId && (e.session.status === "incomplete" || e.session.status === "ready_for_complete"));
    if (!open.length) throw new SandboxError(409, "no_prepared_checkout", "nothing is ready to pay; the add-on prepares the proven items first");
    const match = open.find((e) => sameSet(e.session.line_items.map((l) => l.item.id), ids));
    if (!match) throw new SandboxError(409, "quote_mismatch", "line items must be exactly the proven items prepared for this booking, at their prepared prices");
    this.#checkLines(match, lines);
    this.#applyBuyer(match, body.buyer);
    return { status: 201, body: structuredClone(match.session) };
  }

  get(userId: string, id: string): Reply {
    return { status: 200, body: structuredClone(this.#own(userId, id).session) };
  }

  update(userId: string, id: string, body: { line_items?: unknown; buyer?: unknown }): Reply {
    const e = this.#own(userId, id);
    if (e.session.status === "completed" || e.session.status === "canceled") throw new SandboxError(409, "session_closed", `session is ${e.session.status}`);
    this.#checkLines(e, body.line_items);
    this.#applyBuyer(e, body.buyer);
    return { status: 200, body: structuredClone(e.session) };
  }

  cancel(userId: string, id: string): Reply {
    const e = this.#own(userId, id);
    if (e.session.status === "completed") throw new SandboxError(409, "already_completed", "completed sessions are immutable");
    e.session.status = "canceled";
    e.session.metadata.cancel_reason = "canceled_by_buyer";
    return { status: 200, body: structuredClone(e.session) };
  }

  complete(userId: string, id: string, body: { payment?: { instruments?: unknown } }): Reply {
    const e = this.#own(userId, id);
    const s = e.session;
    if (s.status === "completed") throw new SandboxError(409, "already_completed", "completed sessions are immutable");
    if (s.status === "canceled") throw new SandboxError(409, s.metadata.cancel_reason === "quote_changed" ? "quote_changed" : "session_closed", "this checkout was canceled");
    if (!s.buyer?.first_name) throw new SandboxError(409, "not_ready", "session is not ready_for_complete");
    const inst = body.payment?.instruments;
    if (!Array.isArray(inst) || inst.length !== 1) throw new SandboxError(400, "bad_request", "payment.instruments must hold exactly one instrument");
    const i = inst[0] as { handler_id?: string; credential?: { type?: string; payment_method_id?: string } };
    if (i.handler_id !== STORED_HANDLER_ID || i.credential?.type !== "payment_method_reference" || typeof i.credential.payment_method_id !== "string") {
      throw new SandboxError(400, "bad_request", `instrument must use handler ${STORED_HANDLER_ID} with a payment_method_reference`);
    }
    // Amount guard: the session must still pay exactly the proven total of the plan it was prepared from.
    const st = this.#state();
    const quote = this.#quotes.get(s.metadata.partner_booking_id);
    const total = s.totals.find((t) => t.type === "total")!.amount;
    if (!quote || quote.planHash !== s.metadata.plan_hash || quote.amount !== total || !sameSet(quote.itemIds.map((x) => `${s.metadata.partner_booking_id}:${x}`), s.line_items.map((l) => l.item.id))) {
      throw new SandboxError(409, "amount_mismatch", "session total does not match the proven total of the current plan");
    }
    const pmId = i.credential.payment_method_id;
    const offered = s.payment.instruments.some((x) => x.id === pmId);
    const card = st.scenario.homeowner.cards.find((c) => c.id === pmId);
    const fail = (content: string): Reply => {
      s.status = "incomplete";
      s.messages = [{ type: "error", code: "payment_failed", content, severity: "recoverable" }];
      return { status: 200, body: { id: s.id, status: s.status, messages: structuredClone(s.messages) } };
    };
    if (!offered || !card) return fail("That payment method is not on file for this account.");
    if (card.behavior === "decline") return fail("Payment was declined. Please try a different payment method.");
    st.capture({ partnerBookingId: s.metadata.partner_booking_id, amount: total, idempotencyKey: s.id, paymentMethod: { id: card.id, brand: card.brand, last_digits: card.last_digits, mode: card.mode } });
    s.status = "completed";
    s.messages = [];
    const orderId = `ORD-${1000 + ++this.#orders}`;
    s.order = { id: orderId, permalink_url: `https://marketplace.sandbox.example/orders/${orderId}` };
    return { status: 200, body: structuredClone(s) };
  }
}
