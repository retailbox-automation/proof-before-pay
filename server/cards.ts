// Card models for the six MCP Apps views. The server decides WHAT the card says (so text, numbers and
// sources are testable on the server); the view only lays it out. Design guide: List / Card patterns,
// one title, 1-2 fields per row, one action per item, max 5 rows (+N more beyond 3 on the scope card).
// No brand names in card text: "front door camera", "marketplace", "Florida license registry".
// No tool names, API codes or internal ids on cards (SPEC §7.3); those live in the host's developer view.
// The payment card is the PRE-checkout card: its button asks Alexa+ to start checkout ("Pay for this order");
// Alexa+ owns the PIN, the payment method and the confirmation (SPEC §7.1).
import type { SourceMode } from "../src/core/types.ts";
import type { Job, ProView, UserState } from "./store.ts";
import { cardSlot, checkedAt, clock, shortDate, shortName, spokenItem, usd, visitSlot, weekdayShort } from "./format.ts";

export type ViewName = "pros" | "scope" | "payment" | "status" | "draft" | "warranty";
export type RowState = "ok" | "bad" | "struck" | "info" | "pending";
export type Row = { state: RowState; label: string; detail?: string; source?: string; mode?: SourceMode; kind?: string; action?: { label: string; message: string } };
export type Field = { label: string; value: string; source?: string; mode?: SourceMode; kind?: string };
export type CardModel = {
  view: ViewName;
  layout: "list" | "card";
  title: string;
  subtitle?: string;
  hero?: { text: string; kind: string };
  rows: Row[];
  more?: { label: string; rows: Row[] };
  fields?: Field[];
  stacks?: { kind: "proven" | "waits"; label: string; count: number; amount: string }[];
  breakdown?: { label: string; value: string; kind: "subtotal" | "fees" | "total" }[];
  note?: string;
  footer?: string;
  action?: { label: string; message: string };
};

const REGISTRY = "Florida license registry";
const regMode = (p: { license: { source: { mode: SourceMode } } }) => p.license.source.mode;

export function prosCard(trade: string, pros: ProView[]): CardModel {
  const rows: Row[] = pros.slice(0, 5).map((p) => {
    const lic = p.license;
    const rec = lic.records[0];
    if (p.eligible) {
      return {
        state: "ok" as const,
        kind: "pro",
        label: p.businessName,
        detail: `${p.rating} ★ (${p.reviewCount}) · est. ${usd(p.estimate)} · License ${lic.query} · active to ${rec?.expires ?? "?"}`,
        source: REGISTRY,
        mode: regMode(p),
        action: { label: "Book", message: `Book ${shortName(p.businessName)}.` },
      };
    }
    const when = lic.source.asOf ? ` (checked ${checkedAt(Date.parse(lic.source.asOf))})` : "";
    const why = lic.verdict === "not_found" ? `License ${lic.query} not found in ${REGISTRY}${when}`
      : lic.verdict === "inactive" ? `License ${lic.query} is not active in ${REGISTRY}${when}`
      : lic.verdict === "name_mismatch" ? `License ${lic.query} is registered to another name in ${REGISTRY}${when}`
      : `${REGISTRY} did not answer${when} · not verified`;
    return { state: "struck" as const, kind: "excluded", label: p.businessName, detail: why, source: REGISTRY, mode: regMode(p) };
  });
  return {
    view: "pros",
    layout: "list",
    title: `${trade === "electrician" ? "Electricians" : "Pros"} nearby`,
    subtitle: "Listings from the marketplace (sandbox) · every license checked",
    rows,
    footer: pros.length > 5 ? `+${pros.length - 5} more` : undefined,
  };
}

type ScopeLike = { title: string; proName: string; start: number; end: number; total: number; items: { id: string; description: string; price: number; proof: string[] }[]; proConsents: boolean; door: { from: number; to: number }; cancellation: string; status: "pending" | "booked" | "cancelled" };

export function scopeCard(s: ScopeLike): CardModel {
  const itemRow = (i: ScopeLike["items"][number]): Row => ({ state: "info", kind: "item", label: i.description, detail: `${usd(i.price)} · proof: ${i.proof.join(" + ")}` });
  const doorFrom = s.door.from, doorTo = s.door.to;
  const statusText = s.status === "pending" ? "not booked yet" : s.status === "booked" ? "booked" : "cancelled · nothing charged";
  return {
    view: "scope",
    layout: "card",
    title: `${s.title} · ${cardSlot(s.start, s.end)}`,
    subtitle: `${s.proName} · estimate ${usd(s.total)}, to be paid after the work is proven · ${statusText}`,
    rows: s.items.slice(0, 3).map(itemRow),
    more: s.items.length > 3 ? { label: `+${s.items.length - 3} more`, rows: s.items.slice(3).map(itemRow) } : undefined,
    fields: [
      { label: "Proof", value: "photo per item", kind: "proof" },
      { label: "Visit log", value: s.proConsents ? "pro agreed ✓ — arrive/leave only, no video kept" : "pro did not agree — no visit log", source: "front door camera", mode: "sandbox", kind: "consent" },
      { label: "Door code", value: `${weekdayShort(doorFrom)} ${clock(doorFrom)}–${clock(doorTo)} · simulated (no lock API)`, mode: "simulated", kind: "door" },
      { label: "Cancel", value: s.cancellation, source: "pro's policy on the marketplace", mode: "sandbox", kind: "cancellation" },
    ],
    action: s.status === "pending" ? { label: "Book it", message: "Yes." } : s.status === "booked" ? { label: "Cancel booking", message: "Cancel the booking." } : undefined,
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
  const lic = job.licenseAtBooking;
  const rows: Row[] = [];
  const v = job.licenseAtReview ?? lic;
  rows.push(v.verdict === "verified"
    ? { state: "ok", kind: "evidence", label: "License verified", detail: `${v.query} · active to ${v.records[0]?.expires ?? "?"}`, source: REGISTRY, mode: v.source.mode }
    : { state: "bad", kind: "not-confirmed", label: "License not verified", detail: `${v.query} · ${v.verdict.replace("_", " ")}`, source: REGISTRY, mode: v.source.mode });
  const visit = visitOf(job);
  rows.push(visit.arrivedAt !== null && visit.leftAt !== null
    ? { state: "ok", kind: "evidence", label: `Visit ${clock(visit.arrivedAt)}–${clock(visit.leftAt)}`, detail: "arrive/leave only · signature ✓", source: "front door camera", mode: visit.mode }
    : { state: "bad", kind: "not-confirmed", label: "No visit logged", detail: "no arrive/leave events in the booking window", source: "front door camera", mode: visit.mode });
  const proven = plan.lines.filter((l) => l.verdict.kind === "proven").length;
  if (proven) rows.push({ state: "ok", kind: "evidence", label: `${proven} photo${proven === 1 ? "" : "s"} match items`, detail: "taken during the visit", source: "marketplace photos", mode: "sandbox" });
  const bad: Row[] = [];
  for (const l of plan.lines) {
    const vd = l.verdict;
    if (vd.kind === "unproven") {
      const it = job.scope.items.find((i) => i.id === vd.scopeItemId);
      // Plain words only: reconcile's reasons are for the developer view (they can carry scope ids).
      const why = vd.reasons.some((r) => /outside/i.test(r)) ? "photo taken outside the visit" : vd.reasons.some((r) => /no photo/i.test(r)) ? "no photo" : vd.reasons.some((r) => /visit/i.test(r)) ? "no logged visit" : "not proven";
      bad.push({ state: "bad", kind: "not-confirmed", label: `Not confirmed: ${it ? spokenItem(it) : l.line.chargeDescription}`, detail: why, source: "marketplace photos", mode: "sandbox" });
    } else if (vd.kind === "not_in_scope") {
      bad.push({ state: "bad", kind: "not-confirmed", label: `Not in scope: "${l.line.chargeDescription}" ${usd(l.line.amount)}`, detail: "not in the agreed scope", source: "marketplace invoice", mode: "sandbox" });
    } else if (vd.kind === "over_scope") {
      bad.push({ state: "bad", kind: "not-confirmed", label: `Above scope: ${l.line.chargeDescription}`, detail: `${usd(l.waits)} over the agreed price`, source: "marketplace invoice", mode: "sandbox" });
    }
  }
  const room = 5 - rows.length;
  const waitsCount = plan.lines.filter((l) => l.waits > 0).length;
  const provenCount = plan.lines.filter((l) => l.payNow > 0).length;
  const shown = bad.length > room ? bad.slice(0, room - 1) : bad;
  rows.push(...shown);
  const hidden = bad.length - shown.length;
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  return {
    view: "payment",
    layout: "card",
    title: `${job.title} · invoice ${usd(plan.invoiceTotal)}`,
    subtitle: `${job.proName} · checked with fixed rules, no model`,
    hero: { text: `Pay now ${usd(plan.payNow)} · Waits ${usd(plan.waits)}`, kind: "split" },
    stacks: [
      { kind: "proven", label: "Proven · pay now", count: provenCount, amount: usd(plan.payNow) },
      { kind: "waits", label: "Waits for you", count: waitsCount, amount: usd(plan.waits) },
    ],
    rows,
    more: hidden > 0 ? { label: `+${hidden} more`, rows: bad.slice(shown.length) } : undefined,
    breakdown: [
      { label: "Subtotal", value: usd(plan.payNow), kind: "subtotal" },
      { label: "Fees", value: usd(0), kind: "fees" },
      { label: "Total", value: usd(plan.payNow), kind: "total" },
    ],
    footer: paid ? `Sandbox · Paid ${usd(paid)} through Alexa+ checkout. The rest waits for you.` : "Sandbox · Pay proven items now, the rest after you confirm.",
    // Touch path to Alexa+ checkout: a ui/message with the purchase intent, never tools/call (SPEC §7.1).
    action: plan.payNow > 0 && !paid ? { label: `Pay ${usd(plan.payNow)}`, message: "Pay for this order" } : undefined,
  };
}

function visitOf(job: Job): { arrivedAt: number | null; leftAt: number | null; mode: SourceMode } {
  const v = job.visitAtReview;
  return { arrivedAt: v?.arrivedAt ?? null, leftAt: v?.leftAt ?? null, mode: v?.source.mode ?? "fixture" };
}

export function statusCard(job: Job, open: string[]): CardModel {
  const rows: Row[] = [];
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  if (job.status === "CANCELLED") rows.push({ state: "info", kind: "cancelled", label: "Booking cancelled", detail: "nothing charged" });
  else if (!job.plan) rows.push({ state: "pending", kind: "booked", label: `Booked ${cardSlot(job.start, job.end)}`, detail: "invoice not checked yet" });
  if (paid) rows.push({ state: "ok", kind: "paid", label: `Paid ${usd(paid)}`, detail: "proven items, through Alexa+ checkout", source: "Alexa+ checkout (simulated)", mode: "simulated" });
  if (job.plan) {
    for (const l of job.plan.lines) {
      const v = l.verdict;
      if (v.kind === "unproven") {
        const it = job.scope.items.find((i) => i.id === v.scopeItemId);
        rows.push({ state: "bad", kind: "open", label: `${it ? it.description : l.line.chargeDescription}`, detail: `needs a photo · ${usd(l.waits)} waits`, source: "marketplace photos", mode: "sandbox" });
      } else if (v.kind === "not_in_scope" || v.kind === "over_scope") {
        rows.push({ state: "bad", kind: "open", label: `${l.line.chargeDescription} ${usd(l.waits)}`, detail: "your decision · not in the agreed scope", source: "marketplace invoice", mode: "sandbox" });
      }
    }
  }
  return {
    view: "status",
    layout: "card",
    title: `${job.title} · ${shortName(job.proName)}`,
    subtitle: job.plan ? `Proven ${usd(job.plan.payNow)} · waits ${usd(job.plan.waits)}` : job.status === "CANCELLED" ? "cancelled" : `booked ${cardSlot(job.start, job.end)}`,
    rows: rows.slice(0, 5),
    footer: open.length ? `${open.length} open item${open.length === 1 ? "" : "s"} · saved on your account` : "Nothing open",
    action: open.length && job.status !== "CANCELLED" ? { label: "Draft a note", message: "Yes, draft it." } : undefined,
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
  const names = w.scopeItemIds.map((id) => job.scope.items.find((i) => i.id === id)).filter(Boolean).map((i) => spokenItem(i!));
  const v = job.visitAtReview;
  const rows: Row[] = [
    w.covered
      ? { state: "ok", kind: "coverage", label: `Covered: ${w.laborWarrantyDays}-day labor warranty`, detail: `to ${shortDate(w.warrantyEnds)} · from the ${shortDate(job.end).replace(/, \d{4}$/, "")} job`, source: "pro's terms on the marketplace", mode: "sandbox" }
      : { state: "bad", kind: "coverage", label: "Not covered", detail: w.reason, source: "pro's terms on the marketplace", mode: "sandbox" },
  ];
  if (w.covered) rows.push({ state: w.booked ? "ok" : "pending", kind: "return-visit", label: `Return visit ${visitSlot(w.returnVisit.start, w.returnVisit.end)}`, detail: `${usd(0)} · ${w.booked ? "booked" : "not booked yet"}`, source: "marketplace booking", mode: "sandbox" });
  rows.push({ state: "info", kind: "evidence", label: `Original scope: ${job.scope.items.length} items`, detail: names.length ? `this issue: ${names.join(", ")}` : "agreed at booking", source: "your saved job", mode: "sandbox" });
  rows.push({ state: "info", kind: "evidence", label: `${photos.length} photo${photos.length === 1 ? "" : "s"} from the visit`, detail: names.join(", ") || "none tagged to this issue", source: "marketplace photos", mode: "sandbox" });
  if (v?.arrivedAt != null && v.leftAt != null) rows.push({ state: "info", kind: "evidence", label: `Visit log ${shortDate(v.arrivedAt).replace(/, \d{4}$/, "")}, ${clock(v.arrivedAt)}–${clock(v.leftAt)}`, detail: "arrive/leave only", source: "front door camera", mode: v.source.mode });
  return {
    view: "warranty",
    layout: "card",
    title: `Labor warranty · ${job.title}`,
    subtitle: `${job.proName} · "${w.issue}"`,
    rows: rows.slice(0, 5),
    footer: w.covered ? "Sandbox · the scope, photos and visit log go with the request." : "Sandbox",
    action: w.covered && !w.booked ? { label: "Book return visit", message: "Yes, book it." } : undefined,
  };
}
