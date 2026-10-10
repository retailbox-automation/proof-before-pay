// Formatting and Alexa's voice lines. Voice lines are built from data with fixed templates; for the
// SPEC §1 demo data they must produce the SPEC lines word for word (checked by npm run verify).
import type { PaymentPlan, ScopeItem } from "../src/core/types.ts";
import type { Job, ProView } from "./store.ts";

export const TZ = "America/New_York"; // Florida
export const WORDS_PER_SECOND = 2.5;

export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Spoken amount without the word "dollars": 105000 -> "1,050", 105025 -> "1,050.25". */
export const spokenAmount = (cents: number) => (cents % 100 === 0 ? (cents / 100).toLocaleString("en-US") : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }));
/** Whole dollars for button labels: "Pay $1,050". */
export const usdShort = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : usd(cents));

const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const numberWord = (n: number) => NUM[n] ?? String(n);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function seconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / WORDS_PER_SECOND) * 10) / 10;
}

const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
export const weekday = (t: number) => parts(t).weekday as string;
export const weekdayShort = (t: number) => weekday(t).slice(0, 3);
/** "10:02" / "1:00" (12-hour, no am/pm) */
export const clock = (t: number) => { const p = parts(t); return `${p.hour}:${p.minute}`; };
/** "2:15 PM" */
export const clockAmPm = (t: number) => { const p = parts(t); return `${p.hour}:${p.minute} ${p.dayPeriod}`; };
/** Spoken hour: 10:00 -> "10", 12:00 -> "noon", 13:30 -> "1:30" */
function spokenHour(t: number): string {
  const p = parts(t);
  if (p.hour === "12" && p.minute === "00" && p.dayPeriod === "PM") return "noon";
  return p.minute === "00" ? p.hour : `${p.hour}:${p.minute}`;
}
/** Card hour: 10:00 -> "10", 12:00 -> "12", 9:30 -> "9:30" */
const cardHour = (t: number) => { const p = parts(t); return p.minute === "00" ? p.hour : `${p.hour}:${p.minute}`; };
export const spokenSlot = (start: number, end: number) => `${weekday(start)} ${spokenHour(start)} to ${spokenHour(end)}`;
export const cardSlot = (start: number, end: number) => `${weekdayShort(start)} ${cardHour(start)}–${cardHour(end)}`;
export const checkedAt = (t: number) => `${weekdayShort(t)} ${clockAmPm(t)}`;

/** "Bright Current Electric" -> "Bright Current"; "Quick Volt Pros" -> "Quick Volt". */
export function shortName(business: string): string {
  const generic = /^(electric|electrical|electricians?|pros?|services?|llc|inc|co|company|group|contracting|contractors?)$/i;
  const w = business.split(/\s+/);
  while (w.length > 1 && generic.test(w[w.length - 1])) w.pop();
  return w.join(" ");
}

const ROOMS = ["master bath", "master bathroom", "guest bath", "bathroom", "kitchen", "garage", "laundry room", "living room", "bedroom", "hallway", "basement", "attic", "patio"];
export function jobTitle(summary: string, trade: string): string {
  const s = summary.toLowerCase();
  const room = ROOMS.find((r) => s.includes(r));
  const kind = trade === "electrician" ? "electrical" : trade;
  return room ? `${cap(room)} ${kind}` : `${cap(kind)} work`;
}

/** "Replace hallway smoke detector" -> "hallway smoke detector"; "Install 2 GFCI outlets..." -> "GFCI outlets in master bath". */
export function spokenItem(item: Pick<ScopeItem, "description">): string {
  return item.description.replace(/^(replace|install|restore|repair|add|remove|fix|swap)\s+/i, "").replace(/^\d+\s+/, "").trim();
}
/** "Electrical inspection" -> "inspection" (trade adjective dropped). */
export function spokenLine(description: string): string {
  const w = description.toLowerCase().split(/\s+/).filter((x) => !/^(electrical|electric)$/.test(x));
  return w.join(" ") || description.toLowerCase();
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const tradePlural = (trade: string) => (trade === "electrician" ? "electricians" : `${trade}s`);

// ---------- voice lines ----------
export function voiceFindPros(trade: string, pros: ProView[], recommended: ProView | undefined): string {
  const out = [`I found ${numberWord(pros.length)} ${tradePlural(trade)} nearby.`];
  const excluded = pros.filter((p) => !p.eligible);
  for (const p of excluded.slice(0, 2)) {
    const n = shortName(p.businessName);
    const v = p.license.verdict;
    out.push(
      v === "not_found" ? `${n}'s license number isn't in Florida's registry, so I left them out.`
      : v === "inactive" ? `${n}'s license isn't active in Florida's registry, so I left them out.`
      : v === "name_mismatch" ? `${n}'s license is registered to a different name in Florida's registry, so I left them out.`
      : `I couldn't reach Florida's registry to check ${n}, so I left them out for now.`,
    );
  }
  if (excluded.length > 2) out.push(`I left out ${numberWord(excluded.length - 2)} more for license reasons.`);
  if (recommended) out.push(`${shortName(recommended.businessName)} is licensed, ${recommended.rating} stars, ${spokenAmount(recommended.estimate)} dollars. Want them?`);
  else out.push("None of them has a license I could confirm, so I won't book any of them.");
  return out.join(" ");
}

export function voiceBookReadBack(proName: string, start: number, end: number, itemCount: number, total: number, proConsents: boolean): string {
  const consent = proConsents
    ? "They agreed your front door camera logs when they arrive and leave."
    : "They did not agree to visit logging, so items can't be checked against a visit.";
  return `${shortName(proName)}, ${spokenSlot(start, end)}, ${numberWord(itemCount)} items for ${spokenAmount(total)} dollars. You pay only for items proven by a photo. ${consent} Should I book it?`;
}
export const VOICE_BOOKED = "Booked. The confirmation is on your home card.";

export function voiceCancelReadBack(job: Job): string {
  const pol = job.policies.find((p) => p.kind === "cancellation")?.text ?? "No cancellation policy was given.";
  return `Your booking with ${shortName(job.proName)} is ${spokenSlot(job.start, job.end)}, ${spokenAmount(job.total)} dollars. ${pol} Should I cancel it?`;
}
export const VOICE_CANCELLED = "Cancelled. Nothing was charged. The confirmation is on your home card.";

export function voiceReview(job: Job, plan: PaymentPlan): string {
  if (plan.blockers.length) return `I can't pay anything yet. ${plan.blockers[0]} ${spokenAmount(plan.waits)} waits for your OK.`;
  const items = job.scope.items;
  const provenIds = new Set(plan.lines.filter((l) => l.verdict.kind === "proven").map((l) => (l.verdict as { scopeItemId: string }).scopeItemId));
  const issues: string[] = [];
  for (const l of plan.lines) {
    const v = l.verdict;
    if (v.kind === "unproven") {
      const it = items.find((i) => i.id === v.scopeItemId);
      const name = it ? spokenItem(it) : l.line.chargeDescription;
      issues.push(v.reasons.some((r) => /outside/.test(r)) ? `the ${name} photo was taken outside the visit` : v.reasons.some((r) => /no photo/.test(r)) ? `the ${name} has no photo yet` : `the ${name} isn't proven yet`);
    } else if (v.kind === "not_in_scope") issues.push(`a ${spokenAmount(l.line.amount)}-dollar ${spokenLine(l.line.chargeDescription)} line wasn't in the scope`);
    else if (v.kind === "over_scope") issues.push(`${spokenAmount(l.waits)} dollars on the ${spokenLine(l.line.chargeDescription)} line is above the scope`);
  }
  const head = provenIds.size === items.length
    ? `All ${numberWord(items.length)} items are proven by photos taken during the visit.`
    : `${cap(numberWord(provenIds.size))} of ${numberWord(items.length)} items are proven by photos taken during the visit.`;
  const mid = issues.length ? ` ${cap(joinAnd(issues))}.` : "";
  const tail = plan.waits > 0 ? ` I can pay ${spokenAmount(plan.payNow)} now. ${spokenAmount(plan.waits)} waits for your OK.` : ` I can pay ${spokenAmount(plan.payNow)} now.`;
  return `${head}${mid}${tail}`;
}

export function voicePayPrompt(proName: string, amount: number): string {
  const n = shortName(proName);
  return `${spokenAmount(amount)} dollars to ${n} with your card on file. Refunds follow ${n}'s policy on the card. Say your four-digit voice code.`;
}
export function voicePaid(amount: number, waits: number): string {
  const rest = waits > 0 ? ` The other ${spokenAmount(waits)} stays unpaid until you say so.` : "";
  return `Paid ${spokenAmount(amount)} dollars, sandbox. The receipt is on your home card.${rest}`;
}

export function openItems(job: Job): string[] {
  const plan = job.plan;
  if (!plan) return [];
  const out: string[] = [];
  for (const l of plan.lines) {
    const v = l.verdict;
    if (v.kind === "unproven") {
      const it = job.scope.items.find((i) => i.id === v.scopeItemId);
      out.push(`the ${it ? spokenItem(it) : l.line.chargeDescription} needs a photo`);
    } else if (v.kind === "not_in_scope") out.push(`you haven't decided on the ${spokenAmount(l.line.amount)}-dollar ${spokenLine(l.line.chargeDescription)} line`);
    else if (v.kind === "over_scope") out.push(`you haven't decided on ${spokenAmount(l.waits)} dollars above the scope on the ${spokenLine(l.line.chargeDescription)} line`);
  }
  for (const b of plan.blockers) out.push(b.replace(/\.$/, "").toLowerCase());
  return out;
}

export function voiceStatus(job: Job): string {
  const n = shortName(job.proName);
  if (job.status === "CANCELLED") return `Your booking with ${n} was cancelled. Nothing was charged.`;
  if (!job.plan) return `${n} is booked for ${spokenSlot(job.start, job.end)}. I'll check the invoice against the scope when it arrives.`;
  const open = openItems(job);
  if (!open.length) return `Nothing is open with ${n}. Every item is proven${job.payments.length ? " and paid" : ""}.`;
  const lead = open.length === 1 ? "One thing" : `${cap(numberWord(open.length))} things`;
  return `${lead}: ${joinAnd(open)}. Want a draft note to ${n}?`;
}

export function voiceDraft(proName: string): string {
  return `Here's a draft note to ${shortName(proName)} on your screen. You send it yourself; I don't send messages.`;
}
