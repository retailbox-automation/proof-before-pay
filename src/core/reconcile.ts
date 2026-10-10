// reconcile-v1: deterministic invoice-vs-scope check (SPEC 3.1). No model, no clock, no I/O.
// Same input -> byte-identical output (JSON.stringify of the result is stable).
//
// Rules, in order:
//  1. Job-level blockers stop all payment (payNow 0 on every line):
//     license verdict != "verified"; visit-logging consent missing while an item needs "visit" proof;
//     consent granted and items need photos, but the camera logged no arrival (photos can't be tied to the visit).
//  2. Line -> scope item: by scopeItemId; else description match (normalized tokens, Jaccard >= 0.6,
//     best unique match); else not_in_scope. Lines with an explicit scopeItemId claim items first.
//  3. A second line for an already matched item -> over_scope (whole amount waits).
//  4. Amount above the scope price -> over_scope: the proven part pays up to the scope price, the excess waits.
//  5. Proof "photo": >= 1 photo tagged with the item id, taken inside [arrivedAt - slack, leftAt + slack]
//     when a visit window exists (consent granted and arrival logged). Proof "visit": arrivedAt and leftAt present.
//  6. notConfirmed: one plain sentence per blocker and per unproven / not_in_scope / over_scope line.
//
// Quantity on a charge is informational in v1 (money decisions use amounts only).

import type { Charge, Evidence, LineResult, LineVerdict, PaymentPlan, Photo, ScopeItem, ScopeOfWork } from "./types.ts";
import { formatMinutes, formatUsd } from "./money.ts";

export const RECONCILE_ENGINE = "reconcile-v1" as const;
export const DEFAULT_PHOTO_SLACK_MS = 15 * 60_000;
export const DESCRIPTION_MATCH_THRESHOLD = 0.6;

export interface ReconcileOptions {
  /** Grace period around the camera-logged visit for photo timestamps. Default 15 min. */
  photoSlackMs?: number;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "into", "per", "x",
]);

/** Lowercase, strip punctuation, drop stop words. Exported for tests and for the app's previews. */
export function descriptionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

type Assignment =
  | { kind: "item"; item: ScopeItem; via: "id" | "description"; score: number }
  | { kind: "none"; reason: string };

function matchByDescription(description: string, items: readonly ScopeItem[]): Assignment {
  const tokens = descriptionTokens(description);
  let best = -1;
  let winners: ScopeItem[] = [];
  for (const item of items) {
    const score = jaccard(tokens, descriptionTokens(item.description));
    if (score > best) { best = score; winners = [item]; }
    else if (score === best) winners.push(item);
  }
  if (best < DESCRIPTION_MATCH_THRESHOLD || winners.length === 0) {
    return { kind: "none", reason: "no scope item matches this line" };
  }
  if (winners.length > 1) {
    return { kind: "none", reason: `matches ${winners.map((w) => w.id).join(" and ")} equally, so it is not linked to either` };
  }
  return { kind: "item", item: winners[0], via: "description", score: Math.round(best * 1000) / 1000 };
}

function assertCents(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer number of cents, got ${value}`);
}

function licenseBlocker(evidence: Evidence): string | null {
  const lic = evidence.license;
  if (lic.verdict === "verified") return null;
  const where = lic.source.service;
  switch (lic.verdict) {
    case "not_found": return `License ${lic.query} was not found in ${where}, so nothing is paid yet.`;
    case "inactive": return `License ${lic.query} is not active in ${where}, so nothing is paid yet.`;
    case "name_mismatch": return `License ${lic.query} is registered to a different name in ${where}, so nothing is paid yet.`;
    case "unavailable": return `${where} could not confirm license ${lic.query} right now, so nothing is paid yet.`;
    default: return `License ${lic.query} is not verified, so nothing is paid yet.`;
  }
}

interface ProofContext {
  consentOk: boolean;
  window: { arrivedAt: number; leftAt: number | null; from: number; to: number } | null;
  photosByItem: Map<string, Photo[]>;
  visitLogged: boolean;
}

interface ProofResult { ok: boolean; reasons: string[]; failSentence: string | null }

function checkProof(item: ScopeItem, ctx: ProofContext): ProofResult {
  const reasons: string[] = [];
  let failSentence: string | null = null;
  const fail = (reason: string, sentence: string) => { reasons.push(reason); failSentence ??= sentence; };
  if (item.proof.length === 0) {
    fail("no proof rule is set for this item", "has no proof rule set");
  }
  for (const kind of item.proof) {
    if (kind === "photo") {
      const tagged = ctx.photosByItem.get(item.id) ?? [];
      if (tagged.length === 0) { fail("no photo tagged for this item", "has no photo yet"); continue; }
      if (!ctx.window) {
        reasons.push(`photo ${tagged[0].photoId} tagged for this item (no visit window, so the photo time is not checked)`);
        continue;
      }
      const w = ctx.window;
      const inside = tagged.find((p) => p.takenAt >= w.from && p.takenAt <= w.to);
      if (inside) {
        reasons.push(`photo ${inside.photoId} taken during the visit`);
        if (w.leftAt === null) reasons.push("departure not logged; photo checked against arrival only");
        continue;
      }
      const p = tagged[0];
      const offset = p.takenAt < w.from
        ? `${formatMinutes((w.arrivedAt - p.takenAt) / 60_000)} before the pro arrived`
        : `${formatMinutes((p.takenAt - (w.leftAt ?? w.arrivedAt)) / 60_000)} after the pro left`;
      fail(`photo ${p.photoId} was taken ${offset}, outside the visit window`, `has a photo taken ${offset}, outside the visit`);
    } else if (kind === "visit") {
      if (ctx.consentOk && ctx.visitLogged) reasons.push("visit logged by the front door camera");
      else fail("the front door camera has no full visit (arrival and departure)", "has no full visit logged by the front door camera");
    }
  }
  return { ok: failSentence === null, reasons, failSentence };
}

function quote(s: string): string {
  return `"${s.trim()}"`;
}

export function reconcile(scope: ScopeOfWork, invoice: Charge[], evidence: Evidence, opts?: ReconcileOptions): PaymentPlan {
  const slack = opts?.photoSlackMs ?? DEFAULT_PHOTO_SLACK_MS;
  if (!Number.isFinite(slack) || slack < 0) throw new RangeError(`photoSlackMs must be >= 0, got ${slack}`);
  for (const item of scope.items) assertCents(item.price, `scope item ${item.id} price`);
  invoice.forEach((line, i) => assertCents(line.amount, `invoice line ${i + 1} amount`));

  const consent = scope.visitLoggingConsent;
  const consentOk = consent.granted && consent.byPro && consent.byHomeowner;
  const needsVisit = scope.items.some((i) => i.proof.includes("visit"));
  const needsPhoto = scope.items.some((i) => i.proof.includes("photo"));
  const { arrivedAt, leftAt } = evidence.visit;

  // ---- rule 1: job-level blockers ----
  const blockers: string[] = [];
  const lic = licenseBlocker(evidence);
  if (lic) blockers.push(lic);
  if (needsVisit && !consentOk) {
    blockers.push("Visit logging was not agreed by both the pro and you, so visit-based items can't be confirmed.");
  }
  if (consentOk && needsPhoto && arrivedAt === null) {
    blockers.push("The front door camera logged no arrival for this job, so photos can't be tied to the visit.");
  }

  // ---- evidence context ----
  const photosByItem = new Map<string, Photo[]>();
  for (const p of evidence.photos) {
    if (p.scopeItemId === null) continue;
    const list = photosByItem.get(p.scopeItemId) ?? [];
    list.push(p);
    photosByItem.set(p.scopeItemId, list);
  }
  for (const list of photosByItem.values()) {
    list.sort((a, b) => a.takenAt - b.takenAt || (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0));
  }
  const window = consentOk && arrivedAt !== null
    ? { arrivedAt, leftAt, from: arrivedAt - slack, to: leftAt !== null ? leftAt + slack : Number.POSITIVE_INFINITY }
    : null;
  const ctx: ProofContext = { consentOk, window, photosByItem, visitLogged: arrivedAt !== null && leftAt !== null };

  // ---- rule 2: assign lines to scope items (explicit ids first, then descriptions; invoice order within each) ----
  const itemsById = new Map(scope.items.map((i) => [i.id, i] as const));
  const assignments: Assignment[] = invoice.map((line) => {
    if (line.scopeItemId !== undefined) {
      const item = itemsById.get(line.scopeItemId);
      return item
        ? { kind: "item", item, via: "id", score: 1 }
        : { kind: "none", reason: `links to scope item ${line.scopeItemId}, which is not in the agreed scope` };
    }
    return matchByDescription(line.chargeDescription, scope.items);
  });
  const order = [
    ...invoice.map((_, i) => i).filter((i) => invoice[i].scopeItemId !== undefined),
    ...invoice.map((_, i) => i).filter((i) => invoice[i].scopeItemId === undefined),
  ];
  const firstLineForItem = new Map<string, number>();
  const duplicateOf = new Map<number, number>();
  for (const i of order) {
    const a = assignments[i];
    if (a.kind !== "item") continue;
    const first = firstLineForItem.get(a.item.id);
    if (first === undefined) firstLineForItem.set(a.item.id, i);
    else duplicateOf.set(i, first);
  }

  // ---- rules 3-6: per-line verdicts ----
  const lines: LineResult[] = [];
  const lineSentences: string[] = [];
  invoice.forEach((charge, i) => {
    const a = assignments[i];
    const line: Charge = { ...charge };
    const desc = quote(charge.chargeDescription);
    let verdict: LineVerdict;
    let payNow = 0;
    let waits = charge.amount;
    let sentence: string | null = null;

    if (a.kind === "none") {
      verdict = { kind: "not_in_scope", reasons: [a.reason] };
      sentence = `${desc} (${formatUsd(charge.amount)}) was not in the agreed scope; it waits for your OK.`;
    } else if (duplicateOf.has(i)) {
      const first = duplicateOf.get(i)! + 1;
      verdict = { kind: "over_scope", scopeItemId: a.item.id, reasons: [`second charge for ${a.item.id} (first charged on line ${first})`] };
      sentence = `${desc} (${formatUsd(charge.amount)}) is a second charge for an item already billed; it waits for your OK.`;
    } else {
      const item = a.item;
      const proof = checkProof(item, ctx);
      const linkReason = a.via === "id" ? `linked to ${item.id} by the pro` : `matched to ${item.id} by description (score ${a.score})`;
      const over = charge.amount > item.price;
      const overReason = `billed ${formatUsd(charge.amount)}, above the agreed ${formatUsd(item.price)}`;
      if (!proof.ok) {
        verdict = { kind: "unproven", scopeItemId: item.id, reasons: [linkReason, ...proof.reasons, ...(over ? [overReason] : [])] };
        sentence = `${desc} ${proof.failSentence}; ${formatUsd(charge.amount)} waits.`;
      } else if (over) {
        const excess = charge.amount - item.price;
        verdict = { kind: "over_scope", scopeItemId: item.id, reasons: [linkReason, ...proof.reasons, overReason] };
        payNow = item.price;
        waits = excess;
        sentence = `${desc} is billed at ${formatUsd(charge.amount)}, ${formatUsd(excess)} above the agreed ${formatUsd(item.price)}; the extra ${formatUsd(excess)} waits for your OK.`;
      } else {
        verdict = { kind: "proven", scopeItemId: item.id, reasons: [linkReason, ...proof.reasons] };
        payNow = charge.amount;
        waits = 0;
      }
    }

    if (blockers.length > 0 && payNow > 0) {
      verdict = { ...verdict, reasons: [...verdict.reasons, "waits because a job-level check failed (see blockers)"] };
      waits += payNow;
      payNow = 0;
    }
    lines.push({ line, verdict, payNow, waits });
    if (sentence) lineSentences.push(sentence);
  });

  const invoiceTotal = invoice.reduce((s, l) => s + l.amount, 0);
  const payNow = lines.reduce((s, l) => s + l.payNow, 0);
  const waits = lines.reduce((s, l) => s + l.waits, 0);
  const notConfirmed = [...blockers, ...lineSentences];
  if (waits > 0 && notConfirmed.length === 0) {
    // Unreachable by construction; kept so a future rule change can never hide money silently.
    notConfirmed.push(`${formatUsd(waits)} waits for your OK.`);
  }
  return { jobId: scope.jobId, invoiceTotal, payNow, waits, lines, blockers, notConfirmed, engine: RECONCILE_ENGINE };
}
