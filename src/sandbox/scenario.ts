// Demo scenario for the sandbox services (fixtures/demo/scenario.json), validated with zod.
// Every epoch value in the file has a "...Local" twin with an explicit offset; load checks they agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { APP_ROOT } from "../core/registry/fixtures.ts";

const cents = z.number().int().nonnegative();
const epoch = z.number().int().positive();

export const scenarioSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  timeZone: z.string().min(1),
  clock: z.object({ start: epoch, startLocal: z.string(), demoAdvanceTo: epoch, demoAdvanceToLocal: z.string() }),
  homeowner: z.object({
    ringAccountId: z.string().min(1),
    cardOnFile: z.object({ label: z.string(), last2: z.string().regex(/^\d{2}$/), mode: z.literal("sandbox") }),
  }),
  professionals: z.array(z.object({
    proId: z.string().min(1),
    businessName: z.string().min(1),
    trade: z.string().min(1),
    rating: z.number().min(0).max(5),
    reviewCount: z.number().int().nonnegative(),
    claimedLicense: z.string().min(1),
    visitLoggingAgreed: z.boolean(),
    refundPolicy: z.string().min(1),
    prices: z.array(cents),
    costEstimate: cents,
  })).min(1),
  job: z.object({
    jobId: z.string().min(1),
    title: z.string(),
    trade: z.string(),
    serviceDescription: z.string(),
    timeSlot: z.object({ start: epoch, end: epoch, startLocal: z.string(), endLocal: z.string() }),
    permit: z.enum(["not_needed", "required"]),
    items: z.array(z.object({ id: z.string(), description: z.string(), quantity: z.number().int().positive(), proof: z.array(z.enum(["photo", "visit"])) })).min(1),
    doorCode: z.object({ validFrom: epoch, validTo: epoch, validFromLocal: z.string(), validToLocal: z.string(), simulated: z.literal(true), note: z.string() }),
  }),
  doorbell: z.object({
    deviceId: z.string().regex(/^[A-Za-z0-9-]+$/, "letters, digits and dashes (the webhook id joins parts with _)"),
    events: z.array(z.object({
      type: z.enum(["motion_detected", "button_press"]),
      subType: z.enum(["motion", "human", "vehicle", "package_delivery", "other_motion"]).optional(),
      at: epoch,
      atLocal: z.string(),
      requiresBooking: z.boolean(),
      note: z.string(),
    })),
  }),
  photos: z.array(z.object({ photoId: z.string(), scopeItemId: z.string().nullable(), takenAt: epoch, takenAtLocal: z.string() })),
  invoice: z.object({
    invoiceId: z.string(),
    issuedAt: epoch,
    issuedAtLocal: z.string(),
    lines: z.array(z.object({
      chargeDescription: z.string(),
      chargeCategory: z.enum(["SERVICE", "MATERIAL", "LABOR", "TAX", "FEE", "OTHER"]),
      scopeItemId: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      priceFrom: z.literal("scope").optional(), // amount = the booked pro's price for scopeItemId
      amount: cents.optional(),
    })),
  }),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const SCENARIOS: Readonly<Record<string, string>> = { demo: "fixtures/demo/scenario.json" };

/** Pairs of [epoch, local ISO string] that must denote the same instant. */
function timePairs(s: Scenario): Array<[string, number, string]> {
  return [
    ["clock.start", s.clock.start, s.clock.startLocal],
    ["clock.demoAdvanceTo", s.clock.demoAdvanceTo, s.clock.demoAdvanceToLocal],
    ["job.timeSlot.start", s.job.timeSlot.start, s.job.timeSlot.startLocal],
    ["job.timeSlot.end", s.job.timeSlot.end, s.job.timeSlot.endLocal],
    ["job.doorCode.validFrom", s.job.doorCode.validFrom, s.job.doorCode.validFromLocal],
    ["job.doorCode.validTo", s.job.doorCode.validTo, s.job.doorCode.validToLocal],
    ["invoice.issuedAt", s.invoice.issuedAt, s.invoice.issuedAtLocal],
    ...s.doorbell.events.map((e, i): [string, number, string] => [`doorbell.events[${i}]`, e.at, e.atLocal]),
    ...s.photos.map((p): [string, number, string] => [`photos.${p.photoId}`, p.takenAt, p.takenAtLocal]),
  ];
}

export function validateScenario(json: unknown): Scenario {
  const s = scenarioSchema.parse(json);
  for (const [where, at, local] of timePairs(s)) {
    if (Date.parse(local) !== at) throw new Error(`scenario ${s.id}: ${where} = ${at} but ${local} = ${Date.parse(local)}`);
  }
  const itemIds = new Set(s.job.items.map((i) => i.id));
  for (const p of s.professionals) {
    if (p.prices.length !== s.job.items.length) throw new Error(`scenario ${s.id}: ${p.proId} has ${p.prices.length} prices for ${s.job.items.length} items`);
    if (p.prices.reduce((a, b) => a + b, 0) !== p.costEstimate) throw new Error(`scenario ${s.id}: ${p.proId} costEstimate != sum of prices`);
  }
  for (const l of s.invoice.lines) {
    if (l.priceFrom === "scope" && (!l.scopeItemId || !itemIds.has(l.scopeItemId))) throw new Error(`scenario ${s.id}: invoice line "${l.chargeDescription}" takes its price from an unknown scope item`);
    if (l.priceFrom !== "scope" && l.amount === undefined) throw new Error(`scenario ${s.id}: invoice line "${l.chargeDescription}" has no amount`);
  }
  for (const p of s.photos) if (p.scopeItemId !== null && !itemIds.has(p.scopeItemId)) throw new Error(`scenario ${s.id}: photo ${p.photoId} tags unknown item ${p.scopeItemId}`);
  if (s.doorbell.events.some((e) => e.type === "motion_detected" && !e.subType)) throw new Error(`scenario ${s.id}: motion events need a subType`);
  return s;
}

export function loadScenario(name: string, root: string = APP_ROOT): Scenario {
  const file = SCENARIOS[name];
  if (!file) throw new Error(`unknown scenario "${name}" (known: ${Object.keys(SCENARIOS).join(", ")})`);
  return validateScenario(JSON.parse(readFileSync(join(root, file), "utf8")));
}
