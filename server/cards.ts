// Card models for the six MCP Apps views. The server decides WHAT the card says (so text, numbers and
// sources are testable on the server); the view only lays it out. Design guide: List / Card patterns,
// one title, 1-2 fields per row, one action per item, max 5 rows (+N more beyond 3 on the scope card).
// No brand names in card text: "front door camera", "marketplace", "Florida license registry".
// No tool names, API codes or internal ids on cards (SPEC §7.3); those live in the host's developer view.
// The payment card is the PRE-checkout card: its button asks Alexa+ to start checkout ("Pay for this order");
// Alexa+ owns the PIN, the payment method and the confirmation (SPEC §7.1).
import type { SourceMode } from "../src/core/types.ts";
import type { Job, ProView, UserState } from "./store.ts";
import { cap, cardSlot, clock, clockAmPm, dayDate, shortDate, shortName, spokenItem, usd, usdShort, weekdayShort, monthDay } from "./format.ts";

export type ViewName = "pros" | "scope" | "payment" | "status" | "draft" | "warranty";
export type RowState = "ok" | "bad" | "struck" | "info" | "pending";
/** One row. `mode` is kept in the data for the developer view; cards never render it (SPEC §7.3). */
export type Row = {
  state: RowState; label: string; detail?: string; source?: string; mode?: SourceMode; kind?: string;
  money?: string; // amount shown on the row (waiting items)
  icon?: "ok" | "warn" | "pending" | "info" | "todo" | "doc" | "calendar"; // defaults from state
  status?: string; // status word next to the row (pros: "Verified" / "Left out")
  meta?: { rating: string; reviews: string; estimate: string }; // pros: rating and estimate
  action?: { label: string; message: string };
};
/** A titled block of a card (scope: "Scope items" / "How payment is protected"). */
export type Section = { kind: string; heading?: string; rows: Row[]; more?: { label: string; rows: Row[] }; total?: string; action?: { label: string; message: string; style?: "text" }; note?: { text: string; kind: string } };
/** A money panel or tile: payment ("Pay now" / "Waits") and status ("Paid" / "Waiting"). */
export type Panel = {
  kind: "pay" | "wait" | "paid" | "waiting";
  state: RowState;
  label: string;
  amount: string;
  breakdown?: { label: string; value: string; kind: "subtotal" | "fees" | "total" }[];
  rows?: Row[];
  action?: { label: string; message: string };
  note?: string;
};
export type Field = { label: string; value: string; source?: string; mode?: SourceMode; kind?: string };
export type CardModel = {
  view: ViewName;
  layout: "list" | "card";
  title: string;
  subtitle?: string;
  tag?: string; // small pill next to the title: "sandbox", "In progress"
  panels?: Panel[];
  sections?: Section[];
  hero?: { text: string; kind: string };
  rows: Row[];
  more?: { label: string; rows: Row[] };
  fields?: Field[];
  stacks?: { kind: "proven" | "waits"; label: string; count: number; amount: string }[];
  breakdown?: { label: string; value: string; kind: "subtotal" | "fees" | "total" }[];
  note?: string;
  footer?: string;
  action?: { label: string; message: string; style?: "text" };
};

const REGISTRY = "Florida license registry";
const regMode = (p: { license: { source: { mode: SourceMode } } }) => p.license.source.mode;

export function prosCard(trade: string, pros: ProView[]): CardModel {
  const rows: Row[] = pros.slice(0, 5).map((p) => {
    const lic = p.license;
    const rec = lic.records[0];
    if (p.eligible) {
      return {
        state: "ok" as const, kind: "pro", label: p.businessName,
        meta: { rating: String(p.rating), reviews: `(${p.reviewCount})`, estimate: `${usdShort(p.estimate)} estimate` },
        status: "Verified",
        detail: `License ${lic.query} · active to ${rec?.expires ?? "?"}`,
        source: REGISTRY, mode: regMode(p),
        action: { label: "Choose", message: `Book ${shortName(p.businessName)}.` },
      };
    }
    const why = lic.verdict === "not_found" ? `License ${lic.query} not found`
      : lic.verdict === "inactive" ? `License ${lic.query} not active`
      : lic.verdict === "name_mismatch" ? `License ${lic.query} is under another name`
      : "Registry did not answer · not verified";
    return { state: "struck" as const, kind: "excluded", label: p.businessName, status: "Left out", detail: why, source: REGISTRY, mode: regMode(p) };
  });
  const asOf = pros.map((p) => p.license.source.asOf).find(Boolean);
  return {
    view: "pros",
    layout: "list",
    title: `${trade === "electrician" ? "Electricians" : "Pros"} near you · license checked`,
    rows,
    footer: `Source: ${REGISTRY}${asOf ? ` · registry as of ${monthDay(Date.parse(asOf))}, ${clockAmPm(Date.parse(asOf))}` : ""}${pros.length > 5 ? ` · +${pros.length - 5} more` : ""}`,
  };
}

type ScopeLike = { title: string; proName: string; start: number; end: number; total: number; items: { id: string; description: string; price: number; proof: string[] }[]; proConsents: boolean; door: { from: number; to: number }; cancellation: string; status: "pending" | "booked" | "cancelled" };

export function scopeCard(s: ScopeLike): CardModel {
  const item = (i: ScopeLike["items"][number]): Row => ({ state: "info", icon: "todo", kind: "item", label: i.description, detail: i.proof.join(" + "), money: usd(i.price) });
  const doorFrom = s.door.from, doorTo = s.door.to;
  const pro = shortName(s.proName);
  const consentRow: Row = s.proConsents
    ? { state: "ok", kind: "consent", label: `Visit log: ${pro} agreed`, detail: "Arrive and leave times only, no video kept." }
    : { state: "bad", kind: "consent", label: `Visit log: ${pro} did not agree`, detail: "No visit log for this job." };
  const protect: Row[] = [
    { state: "info", icon: "todo", kind: "proof", label: "Pay only for proven items", detail: "Estimate, to be paid after the work is proven: a photo per item." },
    consentRow,
    { state: "info", icon: "todo", kind: "door", label: `Door code: ${weekdayShort(doorFrom)} ${clockAmPm(doorFrom)} – ${clockAmPm(doorTo)}`, detail: "Simulated (no lock API), no lock connected." },
  ];
  const action = s.status === "pending" ? { label: "Book it", message: "Yes." } : s.status === "booked" ? { label: "Cancel booking", message: "Cancel the booking.", style: "text" as const } : undefined;
  return {
    view: "scope",
    layout: "card",
    title: s.title,
    tag: s.status === "pending" ? "estimate · sandbox" : s.status === "booked" ? "sandbox booking" : "cancelled · nothing charged",
    subtitle: `${s.proName} · ${dayDate(s.start)} · ${clockAmPm(s.start)} – ${clockAmPm(s.end)}`,
    sections: [
      {
        kind: "items", heading: "Scope items", rows: s.items.slice(0, 3).map(item),
        more: s.items.length > 3 ? { label: `+${s.items.length - 3} more items`, rows: s.items.slice(3).map(item) } : undefined,
        total: `${s.items.length} items · ${usd(s.total)}`,
      },
      { kind: "protect", heading: "How payment is protected", rows: protect, action, note: { kind: "cancellation", text: `Cancellation: ${s.cancellation}` } },
    ],
    // Flat copies for clients that don't draw sections (e.g. the Alexa skill's APL card).
    rows: s.items.slice(0, 3).map(item),
    more: s.items.length > 3 ? { label: `+${s.items.length - 3} more items`, rows: s.items.slice(3).map(item) } : undefined,
    fields: [
      { label: "Proof", value: "photo per item", kind: "proof" },
      { label: "Visit log", value: consentRow.label, kind: "consent" },
      { label: "Door code", value: `${weekdayShort(doorFrom)} ${clock(doorFrom)}–${clock(doorTo)} · simulated (no lock API)`, kind: "door" },
      { label: "Cancel", value: s.cancellation, kind: "cancellation" },
    ],
    action,
  };
}

export function scopeCardFromJob(job: Job, status: "booked" | "cancelled"): CardModel {
  return scopeCard({ title: job.title, proName: job.proName, start: job.start, end: job.end, total: job.total, items: job.scope.items, proConsents: job.scope.visitLoggingConsent.byPro, door: job.doorCode, cancellation: cancellationOf(job), status });
}

export function cancellationOf(job: { policies: { kind: string; text: string }[] }): string {
  return job.policies.find((p) => p.kind === "cancellation")?.text ?? "no cancellation policy given";
}

export function paymentCard(job: Job): CardModel {
  const plan = job.plan!;
  const v = job.licenseAtReview ?? job.licenseAtBooking;
  const visit = visitOf(job);
  const ok: Row[] = [];
  const wait: Row[] = [];
  if (v.verdict === "verified") ok.push({ state: "ok", kind: "evidence", label: `License ${v.query} active`, source: REGISTRY, mode: v.source.mode });
  else wait.push({ state: "bad", kind: "not-confirmed", label: `License ${v.query} not verified`, money: usd(plan.invoiceTotal), source: REGISTRY, mode: v.source.mode });
  if (visit.arrivedAt !== null && visit.leftAt !== null) ok.push({ state: "ok", kind: "evidence", label: `Visit ${weekdayShort(visit.arrivedAt)} ${clock(visit.arrivedAt)} – ${clockAmPm(visit.leftAt)}`, source: "Front door camera", mode: visit.mode });
  else wait.push({ state: "bad", kind: "not-confirmed", label: "No visit logged at the front door", source: "Front door camera", mode: visit.mode });
  const proven = plan.lines.filter((l) => l.verdict.kind === "proven").length;
  if (proven) ok.push({ state: "ok", kind: "evidence", label: `${proven} of ${job.scope.items.length} items photographed during the visit`, source: "Marketplace photos", mode: "sandbox" });
  for (const l of plan.lines) {
    const vd = l.verdict;
    if (vd.kind === "unproven") {
      const it = job.scope.items.find((i) => i.id === vd.scopeItemId);
      // Plain words only: reconcile's reasons are for the developer view (they can carry scope ids).
      const why = vd.reasons.some((r) => /outside/i.test(r)) ? "photo taken outside the visit" : vd.reasons.some((r) => /no photo/i.test(r)) ? "no photo" : vd.reasons.some((r) => /visit/i.test(r)) ? "no logged visit" : "not proven";
      wait.push({ state: "bad", kind: "not-confirmed", label: `Not confirmed: ${it ? spokenItem(it) : l.line.chargeDescription}, ${why}`, money: usd(l.waits), source: "Marketplace photos", mode: "sandbox" });
    } else if (vd.kind === "not_in_scope") {
      wait.push({ state: "bad", kind: "not-confirmed", label: `Not in scope: ${l.line.chargeDescription}`, money: usd(l.waits), source: "Marketplace invoice", mode: "sandbox" });
    } else if (vd.kind === "over_scope") {
      wait.push({ state: "bad", kind: "not-confirmed", label: `Above scope: ${l.line.chargeDescription}`, money: usd(l.waits), source: "Marketplace invoice", mode: "sandbox" });
    }
  }
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  const shownWait = wait.length > 3 ? wait.slice(0, 2) : wait;
  return {
    view: "payment",
    layout: "card",
    title: `Invoice check · ${job.proName}`,
    tag: "sandbox",
    rows: [...ok, ...wait], // flat list for clients that don't draw panels
    panels: [
      {
        kind: "pay", state: "ok", label: paid ? "Paid" : "Pay now", amount: usd(paid || plan.payNow),
        breakdown: [
          { label: "Subtotal", value: usd(plan.payNow), kind: "subtotal" },
          { label: "Fees", value: usd(0), kind: "fees" },
          { label: "Total", value: usd(plan.payNow), kind: "total" },
        ],
        rows: ok.slice(0, 3),
        // Touch path to Alexa+ checkout: a ui/message with the purchase intent, never tools/call (SPEC §7.1).
        action: plan.payNow > 0 && !paid ? { label: `Pay ${usd(plan.payNow)}`, message: "Pay for this order" } : undefined,
        note: paid ? "Paid through Alexa+ checkout" : undefined,
      },
      { kind: "wait", state: plan.waits > 0 ? "pending" : "ok", label: "Waits", amount: usd(plan.waits), rows: shownWait },
    ],
    more: wait.length > shownWait.length ? { label: `+${wait.length - shownWait.length} more`, rows: wait.slice(shownWait.length) } : undefined,
    footer: "Checked line by line against the scope · fixed rules · Pay proven items now, the rest after you confirm.",
    action: plan.payNow > 0 && !paid ? { label: `Pay ${usd(plan.payNow)}`, message: "Pay for this order" } : undefined,
  };
}

function visitOf(job: Job): { arrivedAt: number | null; leftAt: number | null; mode: SourceMode } {
  const v = job.visitAtReview;
  return { arrivedAt: v?.arrivedAt ?? null, leftAt: v?.leftAt ?? null, mode: v?.source.mode ?? "fixture" };
}

export function statusCard(job: Job, open: string[]): CardModel {
  void open;
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  const rows: Row[] = [];
  const panels: Panel[] = [];
  if (job.plan) {
    panels.push(paid
      ? { kind: "paid", state: "ok", label: "Paid", amount: usd(paid) }
      : { kind: "paid", state: "pending", label: "Proven, not paid yet", amount: usd(job.plan.payNow) });
    panels.push({ kind: "waiting", state: job.plan.waits > 0 ? "pending" : "ok", label: "Waiting", amount: usd(job.plan.waits) });
    for (const l of job.plan.lines) {
      const v = l.verdict;
      if (v.kind === "unproven") {
        const it = job.scope.items.find((i) => i.id === v.scopeItemId);
        rows.push({ state: "bad", kind: "open", label: cap(it ? spokenItem(it) : l.line.chargeDescription), detail: "Waiting for a photo", money: usd(l.waits), source: "Marketplace photos", mode: "sandbox" });
      } else if (v.kind === "not_in_scope" || v.kind === "over_scope") {
        rows.push({ state: "bad", kind: "open", label: l.line.chargeDescription, detail: v.kind === "not_in_scope" ? "Not in scope · your call" : "Above scope · your call", money: usd(l.waits), source: "Marketplace invoice", mode: "sandbox" });
      }
    }
  }
  const tag = job.status === "CANCELLED" ? "Cancelled" : !job.plan ? `Booked ${cardSlot(job.start, job.end)}` : rows.length ? "In progress" : "Done";
  return {
    view: "status",
    layout: "card",
    title: `${job.title} · ${job.proName}`,
    tag,
    panels,
    rows: rows.slice(0, 4),
    footer: job.status === "CANCELLED" ? "Nothing was charged." : !job.plan ? "The invoice is checked when it arrives." : undefined,
    action: rows.length && job.status !== "CANCELLED" ? { label: "Draft a note", message: "Yes, draft it." } : undefined,
  };
}

export function draftCard(job: Job, text: string): CardModel {
  return {
    view: "draft",
    layout: "card",
    title: `Draft note to ${job.proName}`,
    subtitle: "Plain text · nothing is sent",
    rows: [],
    note: text,
    footer: "You send it from your own messages. Proof Before Pay never sends it.",
  };
}

export function warrantyCard(job: Job): CardModel {
  const w = job.warranty!;
  const photos = (job.photosAtReview ?? []).filter((p) => p.scopeItemId && w.scopeItemIds.includes(p.scopeItemId));
  const first = job.scope.items.find((i) => i.id === w.scopeItemIds[0]);
  const v = job.visitAtReview;
  const visitDay = v?.arrivedAt != null ? shortDate(v.arrivedAt).replace(/, \d{4}$/, "") : null;
  const rows: Row[] = [
    w.covered
      ? { state: "ok", kind: "coverage", label: `Covered: ${first ? first.description : "work from this job"}`, detail: `${w.laborWarrantyDays}-day labor warranty to ${shortDate(w.warrantyEnds)}`, source: "Pro's terms on the marketplace" }
      : { state: "bad", kind: "coverage", label: "Not covered", detail: cap(w.reason), source: "Pro's terms on the marketplace" },
    { state: "info", icon: "doc", kind: "evidence", label: "Evidence attached", detail: `Scope, ${photos.length} photo${photos.length === 1 ? "" : "s"}${visitDay ? `, visit log ${visitDay}` : ""}` },
  ];
  const action = w.covered && !w.booked ? { label: "Book free visit", message: "Yes, book it." } : undefined;
  if (w.covered) {
    rows.push({
      state: w.booked ? "ok" : "info", icon: w.booked ? "ok" : "calendar", kind: "return-visit",
      label: `Return visit: ${dayDate(w.returnVisit.start)} · ${clockAmPm(w.returnVisit.start)} – ${clockAmPm(w.returnVisit.end)}`,
      detail: w.booked ? `${usd(0)} · booked` : usd(0),
      action,
    });
  }
  return {
    view: "warranty",
    layout: "card",
    title: "Warranty callback",
    tag: "sandbox booking",
    rows,
    action,
  };
}
