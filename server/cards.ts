// Card models for the six MCP Apps views. The server decides WHAT the card says (so text, numbers and
// sources are testable on the server); the view only lays it out. Design guide: List / Card patterns,
// one title, 1-2 fields per row, one action per item, max 5 rows (+N more beyond 3 on the scope card).
// No brand names in card text: "front door camera", "marketplace", "Florida license registry".
import type { SourceMode } from "../src/core/types.ts";
import type { Job, ProView, UserState } from "./store.ts";
import { cardSlot, checkedAt, clock, clockAmPm, shortName, spokenItem, usd, usdShort, weekdayShort } from "./format.ts";

export type ViewName = "pros" | "scope" | "payment" | "confirm" | "status" | "draft";
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

type ScopeLike = { title: string; proName: string; start: number; end: number; total: number; items: { id: string; description: string; price: number; proof: string[] }[]; proConsents: boolean; door: { from: number; to: number }; status: "pending" | "booked" | "cancelled"; ref?: string };

export function scopeCard(s: ScopeLike): CardModel {
  const itemRow = (i: ScopeLike["items"][number]): Row => ({ state: "info", kind: "item", label: i.description, detail: `${usd(i.price)} · proof: ${i.proof.join(" + ")}` });
  const doorFrom = s.door.from, doorTo = s.door.to;
  const statusText = s.status === "pending" ? "not booked yet" : s.status === "booked" ? `booked · ${s.ref}` : "cancelled · nothing charged";
  return {
    view: "scope",
    layout: "card",
    title: `${s.title} · ${cardSlot(s.start, s.end)}`,
    subtitle: `${s.proName} · ${usd(s.total)} · ${statusText}`,
    rows: s.items.slice(0, 3).map(itemRow),
    more: s.items.length > 3 ? { label: `+${s.items.length - 3} more`, rows: s.items.slice(3).map(itemRow) } : undefined,
    fields: [
      { label: "Proof", value: "photo per item", kind: "proof" },
      { label: "Visit log", value: s.proConsents ? "pro agreed ✓ — arrive/leave only, no video kept" : "pro did not agree — no visit log", source: "front door camera", mode: "sandbox", kind: "consent" },
      { label: "Door code", value: `${weekdayShort(doorFrom)} ${clock(doorFrom)}–${clock(doorTo)} · simulated (no lock API)`, mode: "simulated", kind: "door" },
    ],
    action: s.status === "pending" ? { label: "Book it", message: "Yes." } : s.status === "booked" ? { label: "Cancel booking", message: "Cancel the booking." } : undefined,
  };
}

export function scopeCardFromJob(job: Job, status: "booked" | "cancelled"): CardModel {
  return scopeCard({ title: job.title, proName: job.proName, start: job.start, end: job.end, total: job.total, items: job.scope.items, proConsents: job.scope.visitLoggingConsent.byPro, door: job.doorCode, status, ref: job.partnerBookingId });
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
      bad.push({ state: "bad", kind: "not-confirmed", label: `Not confirmed: ${it ? spokenItem(it) : l.line.chargeDescription}`, detail: vd.reasons.join(", "), source: "marketplace photos", mode: "sandbox" });
    } else if (vd.kind === "not_in_scope") {
      bad.push({ state: "bad", kind: "not-confirmed", label: `Not in scope: "${l.line.chargeDescription}" ${usd(l.line.amount)}`, detail: "not in the agreed scope", source: "marketplace invoice", mode: "sandbox" });
    } else if (vd.kind === "over_scope") {
      bad.push({ state: "bad", kind: "not-confirmed", label: `Above scope: ${l.line.chargeDescription}`, detail: `${usd(l.waits)} over the agreed price`, source: "marketplace invoice", mode: "sandbox" });
    }
  }
  const room = 5 - rows.length;
  const shown = bad.length > room ? bad.slice(0, room - 1) : bad;
  rows.push(...shown);
  const hidden = bad.length - shown.length;
  return {
    view: "payment",
    layout: "card",
    title: `${job.title} · invoice ${usd(plan.invoiceTotal)}`,
    subtitle: `${job.proName} · checked by reconcile-v1 (fixed rules, no model)`,
    hero: { text: `Pay now ${usd(plan.payNow)} · Waits ${usd(plan.waits)}`, kind: "split" },
    rows,
    more: hidden > 0 ? { label: `+${hidden} more`, rows: bad.slice(shown.length) } : undefined,
    footer: "Sandbox · Pay proven items now, the rest after you confirm.",
    action: plan.payNow > 0 && !job.payments.length ? { label: `Pay ${usdShort(plan.payNow)}`, message: "Pay the proven part." } : undefined,
  };
}

function visitOf(job: Job): { arrivedAt: number | null; leftAt: number | null; mode: SourceMode } {
  const v = job.visitAtReview;
  return { arrivedAt: v?.arrivedAt ?? null, leftAt: v?.leftAt ?? null, mode: v?.source.mode ?? "fixture" };
}

export function confirmCard(job: Job, user: UserState, amount: number, prompt: string | null): CardModel {
  const refund = job.policies.find((p) => p.kind === "refund")?.text ?? "No refund policy given.";
  const cancel = job.policies.find((p) => p.kind === "cancellation")?.text ?? "";
  return {
    view: "confirm",
    layout: "card",
    title: "Confirm payment",
    subtitle: `${job.title} · proven items only`,
    hero: { text: usd(amount), kind: "amount" },
    rows: [
      { state: "info", kind: "payee", label: `To ${job.proName}`, detail: `waits ${usd(job.plan ? job.plan.waits : 0)} for your OK` },
      { state: "info", kind: "card", label: `Card on file ${user.paymentMethod.id} (sandbox)`, detail: "no new payment methods" },
      { state: "info", kind: "policy", label: "Refunds and cancellation", detail: `${refund}${cancel ? ` ${cancel}` : ""}` },
      { state: "pending", kind: "voice-code", label: "Voice code required", detail: prompt ?? "say your four-digit voice code" },
    ],
    footer: "Sandbox · no real money moves.",
  };
}

export function receiptCard(job: Job, user: UserState): CardModel {
  const p = job.payments[job.payments.length - 1];
  const waits = job.plan ? job.plan.waits : 0;
  const refund = job.policies.find((x) => x.kind === "refund")?.text ?? "";
  return {
    view: "confirm",
    layout: "card",
    title: "Receipt",
    subtitle: `${job.title} · ${job.proName}`,
    hero: { text: `Paid ${usd(p.amount)}`, kind: "paid" },
    rows: [
      { state: "ok", kind: "receipt", label: `Receipt ${p.captureId}`, detail: `${weekdayShort(p.at)} ${clockAmPm(p.at)} · partial capture`, source: "marketplace payments", mode: "sandbox" },
      { state: "info", kind: "card", label: `Card on file ${user.paymentMethod.id} (sandbox)` },
      ...(waits > 0 ? [{ state: "pending" as const, kind: "waits", label: `Unpaid ${usd(waits)}`, detail: "waits until you say so" }] : []),
      { state: "info", kind: "refund", label: "To cancel or get a refund", detail: `contact ${job.proName}. ${refund}` },
    ],
    footer: "Sandbox · no real money moved.",
  };
}

export function statusCard(job: Job, open: string[]): CardModel {
  const rows: Row[] = [];
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  if (job.status === "CANCELLED") rows.push({ state: "info", kind: "cancelled", label: "Booking cancelled", detail: "nothing charged" });
  else if (!job.plan) rows.push({ state: "pending", kind: "booked", label: `Booked ${cardSlot(job.start, job.end)}`, detail: "invoice not checked yet" });
  if (paid) rows.push({ state: "ok", kind: "paid", label: `Paid ${usd(paid)}`, detail: `receipt ${job.payments[job.payments.length - 1].captureId}`, source: "marketplace payments", mode: "sandbox" });
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
    subtitle: job.plan ? `Pay now was ${usd(job.plan.payNow)} · waits ${usd(job.plan.waits)}` : job.status === "CANCELLED" ? "cancelled" : `booking ${job.partnerBookingId}`,
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
