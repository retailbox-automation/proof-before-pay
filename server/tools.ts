// proofpay MCP server: tools + MCP Apps views. One factory for both protocol eras (2025-11-25 sessions,
// 2026-07-28 per-request), so the two can never drift apart.
//
// Every tool result carries:
//   content[0].text            Alexa's line (voice-first; readable without the card)
//   structuredContent          { speech, seconds, view, card, data }  (card = what the view renders)
//   _meta.steps                [{ service, op, mode, ms, summary }]   (the host draws one sub-chip per step)
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, LATEST_PROTOCOL_VERSION, type ServerContext } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { LicenseCheck, ScopeOfWork, SourceMode } from "../src/core/types.ts";
import type { CameraEvent, Services, Step } from "../src/app/services.ts";
import { checkVoiceCode, currentJob, loadUser, updateUser, type Job, type ProView, type UserState } from "./store.ts";
import { confirmCard, draftCard, paymentCard, prosCard, receiptCard, scopeCard, scopeCardFromJob, statusCard, type CardModel, type ViewName } from "./cards.ts";
import * as F from "./format.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VIEWS: ViewName[] = ["pros", "scope", "payment", "confirm", "status", "draft"];
export const viewUri = (v: ViewName) => `ui://proofpay/${v}.html`;
const REGISTRY = "Florida license registry";
const CAMERA = "Front door camera events";
const MARKET = "Marketplace";

export function userIdOf(ctx: ServerContext): string {
  const id = ctx.http?.authInfo?.extra?.userId;
  if (typeof id !== "string" || !id) throw new Error("account not linked");
  return id;
}

class Steps {
  readonly list: Step[] = [];
  add(s: Step) { this.list.push(s); }
  async run<T>(service: string, op: string, mode: SourceMode | ((r: T) => SourceMode), fn: () => Promise<T>, summary: (r: T) => string): Promise<T> {
    const t0 = performance.now();
    try {
      const r = await fn();
      this.list.push({ service, op, mode: typeof mode === "function" ? mode(r) : mode, ms: Math.round(performance.now() - t0), summary: summary(r) });
      return r;
    } catch (e) {
      this.list.push({ service, op, mode: typeof mode === "function" ? "sandbox" : mode, ms: Math.round(performance.now() - t0), summary: `failed: ${String((e as Error).message ?? e).slice(0, 120)}` });
      throw e;
    }
  }
  sync<T>(service: string, op: string, mode: SourceMode, fn: () => T, summary: (r: T) => string): T {
    const t0 = performance.now();
    const r = fn();
    this.list.push({ service, op, mode, ms: Math.round(performance.now() - t0), summary: summary(r) });
    return r;
  }
}

function reply(view: ViewName, speech: string, card: CardModel, data: Record<string, unknown>, steps: Steps, isError = false) {
  return {
    content: [{ type: "text" as const, text: speech }],
    structuredContent: { speech, seconds: F.seconds(speech), view, card, data },
    _meta: { steps: steps.list },
    ...(isError ? { isError: true } : {}),
  };
}

function plainError(view: ViewName, speech: string, steps: Steps) {
  return reply(view, speech, { view, layout: "card", title: "Proof Before Pay", rows: [{ state: "info", label: speech }] }, {}, steps, true);
}

const verdictSummary = (c: LicenseCheck) =>
  c.verdict === "verified" ? `found · ${c.records[0]?.status ?? "?"} · expires ${c.records[0]?.expires ?? "?"} · name ${c.nameMatch}`
  : c.verdict === "not_found" ? "0 records · not found"
  : c.verdict === "unavailable" ? "registry did not answer · NOT verified"
  : `${c.verdict.replace("_", " ")} · not verified`;

async function checkLicense(services: Services, steps: Steps, number: string, name: string, now: number, op = `license lookup ${number}`): Promise<LicenseCheck> {
  const t0 = performance.now();
  let c: LicenseCheck;
  try {
    c = await services.lookupLicense(number, name, now);
  } catch (e) {
    c = { query: number, found: false, records: [], active: false, claimedName: name, nameMatch: "n/a", verdict: "unavailable", source: { service: "Florida DBPR license search", mode: services.registryMode === "fixture" ? "fixture" : "live", asOf: new Date(now).toISOString(), ref: String(e) } };
  }
  steps.add({ service: REGISTRY, op, mode: c.source.mode, ms: Math.round(performance.now() - t0), summary: verdictSummary(c) });
  return c;
}

function findJob(s: UserState, jobId: string): Job {
  const j = s.jobs.find((x) => x.jobId === jobId);
  if (!j) throw new Error(`job ${jobId} vanished`);
  return j;
}

function draftText(job: Job): string {
  const paid = job.payments.reduce((s, p) => s + p.amount, 0);
  const lines: string[] = [];
  const plan = job.plan;
  if (plan) {
    for (const l of plan.lines) {
      const v = l.verdict;
      if (v.kind === "unproven") {
        const it = job.scope.items.find((i) => i.id === v.scopeItemId);
        lines.push(`${it ? it.description : l.line.chargeDescription} (${F.usd(l.line.amount)}): please send a photo that shows it done.`);
      } else if (v.kind === "not_in_scope") lines.push(`${l.line.chargeDescription} (${F.usd(l.line.amount)}): this wasn't in our agreed scope. What did it cover?`);
      else if (v.kind === "over_scope") lines.push(`${l.line.chargeDescription}: ${F.usd(l.waits)} is above the agreed price. Can you explain the difference?`);
    }
  }
  const head = paid ? `Thanks for the work on ${F.weekday(job.start)}. I paid ${F.usd(paid)} for the items that have photos.` : `Thanks for the work on ${F.weekday(job.start)}. I checked the invoice against our agreed scope.`;
  const body = lines.length ? `${lines.length === 1 ? "One thing is" : `${F.cap(F.numberWord(lines.length))} things are`} still open:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "Everything on the invoice is covered.";
  return `Hi ${job.proName},\n\n${head}\n\n${body}\n\nThanks.`;
}

export type BuildOptions = { era: "legacy" | "modern"; services: Services };

export function buildMcpServer({ era, services }: BuildOptions): McpServer {
  const server = new McpServer(
    { name: "proofpay", title: "Proof Before Pay", version: "0.1.0" },
    {
      ...(era === "legacy" ? { supportedProtocolVersions: [LATEST_PROTOCOL_VERSION] } : {}),
      instructions:
        "Proof Before Pay helps a homeowner hire a licensed pro and pay only for work that is proven. " +
        "Flow: find_pros -> book_job (confirm=false reads the booking back, confirm=true books) -> review_invoice -> pay_proven (first without a code, then with the spoken 4-digit voice code) -> job_status / draft_note. " +
        "Every fact names its source. Payments are sandbox only. The draft note is never sent by this add-on.",
    },
  );
  const jobId = z.string().regex(/^J\d{1,4}$/).optional().describe("Job id such as J1; defaults to the current job");

  // ---------- find_pros ----------
  registerAppTool(server, "find_pros", {
    title: "Find licensed pros",
    description: "Find pros for a home job on the marketplace and check each license in the Florida license registry. Pros whose license is not verified are left out.",
    inputSchema: z.object({
      trade: z.enum(["electrician"]).describe("Trade needed"),
      job_summary: z.string().trim().min(3).max(200).describe("What needs doing, in the homeowner's words"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: viewUri("pros") } },
  }, async ({ trade, job_summary }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const user = loadUser(uid);
    const pros = await steps.run(MARKET, "ListProfessionals", "sandbox", () => services.listProfessionals({ projectDescription: job_summary, zipCode: user.profile.zipCode, trade }), (r) => `${r.length} ${trade}s nearby`);
    const views: ProView[] = [];
    for (const p of pros) {
      // one registry lookup at a time (be gentle with the state site)
      const lic = await checkLicense(services, steps, p.claimedLicense, p.businessName, clk.now);
      views.push({ proId: p.proId, businessName: p.businessName, rating: p.rating, reviewCount: p.reviewCount, estimate: p.costEstimate, license: lic, eligible: lic.verdict === "verified" && lic.active });
    }
    const ordered = [...views.filter((v) => v.eligible).sort((a, b) => b.rating - a.rating || a.estimate - b.estimate || a.proId.localeCompare(b.proId)), ...views.filter((v) => !v.eligible)];
    const recommended = ordered.find((v) => v.eligible);
    updateUser(uid, (s) => { s.lastSearch = { at: clk.now, summary: job_summary, trade, pros: ordered }; s.pendingBooking = null; });
    const speech = F.voiceFindPros(trade, views, recommended);
    return reply("pros", speech, prosCard(trade, ordered), { pros: ordered.map((v) => ({ proId: v.proId, businessName: v.businessName, rating: v.rating, reviewCount: v.reviewCount, estimate: v.estimate, eligible: v.eligible, license: { number: v.license.query, verdict: v.license.verdict, status: v.license.records[0]?.status ?? null, expires: v.license.records[0]?.expires ?? null, source: v.license.source } })), recommendedProId: recommended?.proId ?? null, checkedAt: new Date(clk.now).toISOString() }, steps);
  });

  // ---------- book_job ----------
  registerAppTool(server, "book_job", {
    title: "Book a pro",
    description: "Book one of the pros from the last search. confirm=false gets an estimate and reads the booking back for voice confirmation; confirm=true books it after the homeowner said yes.",
    inputSchema: z.object({
      pro_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).describe("proId from find_pros"),
      confirm: z.boolean().default(false).describe("true only after the homeowner confirmed the read-back"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: viewUri("scope") } },
  }, async ({ pro_id, confirm }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const user = loadUser(uid);
    const pro = user.lastSearch?.pros.find((p) => p.proId === pro_id);
    if (!pro) return plainError("scope", "I need to find pros first. Tell me what you need done.", steps);
    if (!pro.eligible) {
      const speech = `I won't book ${F.shortName(pro.businessName)}. According to Florida's license registry, their license ${pro.license.query} is ${pro.license.verdict === "not_found" ? "not on record" : "not verified"}.`;
      return reply("pros", speech, prosCard(user.lastSearch!.trade, user.lastSearch!.pros), { refused: true, proId: pro_id }, steps);
    }
    const pending = user.pendingBooking;
    if (confirm && pending && pending.quote.proId === pro_id) {
      const q = await steps.run(MARKET, "CreateBooking CONFIRMATION", "sandbox", () => services.createBooking({ stage: "CONFIRMATION", proId: pro_id, alexaBookingId: pending.quote.alexaBookingId, partnerBookingId: pending.quote.partnerBookingId, projectDescription: pending.summary }), (r) => `${r.status} · ${r.partnerBookingId}`);
      const job = updateUser(uid, (s) => {
        const id = `J${s.jobs.length + 1}`;
        const scope: ScopeOfWork = {
          jobId: id,
          proId: pro_id,
          items: q.lines.map((l, i) => ({ id: `S${i + 1}`, description: l.description, quantity: l.quantity, price: l.price, proof: ["photo"] })),
          permit: "not_needed",
          visitLoggingConsent: {
            granted: q.proConsentsToVisitLog, // homeowner consented by confirming the read-back that stated it
            byPro: q.proConsentsToVisitLog,
            byHomeowner: true,
            at: clk.now,
            source: { service: "Booking read-back confirmed by voice; pro consent on the marketplace estimate", mode: "sandbox", ref: q.alexaBookingId },
          },
        };
        const j: Job = {
          jobId: id, title: pending.title, summary: pending.summary, proId: pro_id, proName: pending.proName,
          alexaBookingId: q.alexaBookingId, partnerBookingId: q.partnerBookingId, status: q.status, bookedAt: clk.now, cancelledAt: null,
          start: q.start, end: q.end, total: q.total, policies: q.policies, paymentInstrument: q.paymentInstrument, scope,
          licenseAtBooking: pending.license, doorCode: { from: q.start - 30 * 60_000, to: q.end + 60 * 60_000, simulated: true },
          cameraEvents: [], plan: null, planAt: null, licenseAtReview: null, visitAtReview: null, paymentPrompt: null, payments: [], voiceCodeFailures: 0, drafts: [],
        };
        s.jobs.push(j);
        s.currentJobId = id;
        s.pendingBooking = null;
        return j;
      });
      steps.add({ service: "Door code", op: "time-boxed code", mode: "simulated", ms: 0, summary: `${F.weekdayShort(job.doorCode.from)} ${F.clock(job.doorCode.from)}–${F.clock(job.doorCode.to)} · simulated (no lock API)` });
      return reply("scope", F.VOICE_BOOKED, scopeCardFromJob(job, "booked"), { jobId: job.jobId, status: job.status, partnerBookingId: job.partnerBookingId, start: new Date(job.start).toISOString(), end: new Date(job.end).toISOString(), total: job.total, consent: job.scope.visitLoggingConsent }, steps);
    }
    // ESTIMATE + voice read-back (also when confirm=true arrives without a read-back: never book unread)
    const alexaBookingId = pending?.quote.proId === pro_id ? pending.quote.alexaBookingId : randomUUID();
    const summary = user.lastSearch!.summary;
    const q = await steps.run(MARKET, "CreateBooking ESTIMATE", "sandbox", () => services.createBooking({ stage: "ESTIMATE", proId: pro_id, alexaBookingId, projectDescription: summary }), (r) => `${r.lines.length} items · ${F.usd(r.total)} · ${F.cardSlot(r.start, r.end)}`);
    const title = F.jobTitle(summary, user.lastSearch!.trade);
    updateUser(uid, (s) => { s.pendingBooking = { quote: q, proName: pro.businessName, title, summary, license: pro.license, readBackAt: clk.now }; });
    const speech = F.voiceBookReadBack(pro.businessName, q.start, q.end, q.lines.length, q.total, q.proConsentsToVisitLog);
    const card = scopeCard({ title, proName: pro.businessName, start: q.start, end: q.end, total: q.total, items: q.lines.map((l, i) => ({ id: `S${i + 1}`, description: l.description, price: l.price, proof: ["photo"] })), proConsents: q.proConsentsToVisitLog, status: "pending" });
    return reply("scope", speech, card, { readBack: true, needsConfirmation: true, proId: pro_id, total: q.total, items: q.lines.length, policies: q.policies, start: new Date(q.start).toISOString(), end: new Date(q.end).toISOString() }, steps);
  });

  // ---------- cancel_booking ----------
  registerAppTool(server, "cancel_booking", {
    title: "Cancel a booking",
    description: "Cancel the current booking, also in a later conversation. confirm=false reads the booking and cancellation policy back; confirm=true cancels after the homeowner said yes.",
    inputSchema: z.object({ job_id: jobId, confirm: z.boolean().default(false) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: viewUri("scope") } },
  }, async ({ job_id, confirm }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const user = loadUser(uid);
    const job = currentJob(user, job_id);
    if (!job || job.status === "CANCELLED") return plainError("scope", "There's no active booking to cancel.", steps);
    if (job.payments.length) {
      return reply("scope", `You already paid part of this job, so I can't cancel the booking here. ${job.policies.find((p) => p.kind === "refund")?.text ?? ""}`.trim(), scopeCardFromJob(job, "booked"), { jobId: job.jobId, cancellable: false }, steps);
    }
    if (!confirm || user.pendingCancel?.jobId !== job.jobId) {
      updateUser(uid, (s) => { s.pendingCancel = { jobId: job.jobId, at: clk.now }; });
      const card = scopeCardFromJob(job, "booked");
      card.action = { label: "Yes, cancel it", message: "Yes." };
      return reply("scope", F.voiceCancelReadBack(job), card, { jobId: job.jobId, readBack: true, needsConfirmation: true, policies: job.policies }, steps);
    }
    const r = await steps.run(MARKET, "CancelBooking", "sandbox", () => services.cancelBooking(job.partnerBookingId, "Cancelled by the homeowner"), (x) => `${x.status} · ${job.partnerBookingId}`);
    const updated = updateUser(uid, (s) => { const j = findJob(s, job.jobId); j.status = r.status; j.cancelledAt = clk.now; s.pendingCancel = null; return j; });
    return reply("scope", F.VOICE_CANCELLED, scopeCardFromJob(updated, "cancelled"), { jobId: job.jobId, status: updated.status }, steps);
  });

  // ---------- review_invoice ----------
  registerAppTool(server, "review_invoice", {
    title: "Check the invoice",
    description: "Check the pro's invoice against the agreed scope with deterministic rules: license re-check, visit from front door camera arrive/leave events, and photos per item. Returns what can be paid now and what waits.",
    inputSchema: z.object({ job_id: jobId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: viewUri("payment") } },
  }, async ({ job_id }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const user = loadUser(uid);
    const job = currentJob(user, job_id);
    if (!job) return plainError("payment", "You don't have a booked job yet.", steps);
    if (job.status === "CANCELLED") return plainError("payment", "That booking was cancelled, so there's no invoice to check.", steps);
    const invoice = await steps.run(MARKET, "invoice", "sandbox", () => services.getInvoice(job.partnerBookingId), (r) => (r ? `${r.charges.length} lines · ${F.usd(r.charges.reduce((s, c) => s + c.amount, 0))}` : "no invoice yet"));
    if (!invoice) {
      const speech = `${F.shortName(job.proName)} hasn't sent an invoice yet. I'll check it against the scope when it arrives.`;
      return reply("status", speech, statusCard(job, []), { jobId: job.jobId, invoice: null }, steps);
    }
    let events: CameraEvent[] = job.cameraEvents;
    const consent = job.scope.visitLoggingConsent.granted;
    let visit = services.visitWindow(events, { start: job.start, end: job.end }, consent);
    if (events.length) {
      steps.add({ service: CAMERA, op: "stored webhook events", mode: visit.source.mode, ms: 0, summary: `${events.length} events · signature ✓ · ${visit.arrivedAt !== null ? `arrive ${F.clock(visit.arrivedAt)} · leave ${F.clock(visit.leftAt!)}` : "no arrival in window"} · timestamps only` });
    } else if (consent) {
      events = await steps.run(CAMERA, "history API (no webhooks stored)", "sandbox", () => services.cameraHistory(user.doorbell.deviceId, job.start - 60 * 60_000, job.end + 120 * 60_000), (r) => `${r.length} events · timestamps only`);
      visit = services.visitWindow(events, { start: job.start, end: job.end }, consent);
    } else {
      steps.add({ service: CAMERA, op: "no consent", mode: "sandbox", ms: 0, summary: "visit logging not agreed · no events read" });
    }
    const photos = await steps.run(MARKET, "job photos", "sandbox", () => services.getPhotos(job.partnerBookingId), (r) => `${r.length} photos · ${r.filter((p) => p.scopeItemId).length} tagged to items`);
    const license = await checkLicense(services, steps, job.licenseAtBooking.query, job.proName, clk.now, `license re-check ${job.licenseAtBooking.query}`);
    const plan = steps.sync("reconcile-v1", "deterministic rules, no model", "sandbox", () => services.reconcile(job.scope, invoice.charges, { license, visit, photos }), (p) => `pay ${F.usd(p.payNow)} · waits ${F.usd(p.waits)} · ${p.notConfirmed.length} not confirmed`);
    const updated = updateUser(uid, (s) => {
      const j = findJob(s, job.jobId);
      j.plan = plan; j.planAt = clk.now; j.licenseAtReview = license; j.visitAtReview = visit; j.paymentPrompt = null;
      if (!j.cameraEvents.length && events.length) j.cameraEvents = events.map((e) => ({ ...e, receivedAt: clk.now, signature: "verified" as const }));
      return j;
    });
    return reply("payment", F.voiceReview(updated, plan), paymentCard(updated), { jobId: job.jobId, plan, visit: { arrivedAt: visit.arrivedAt, leftAt: visit.leftAt, source: visit.source }, photos: photos.length }, steps);
  });

  // ---------- pay_proven ----------
  registerAppTool(server, "pay_proven", {
    title: "Pay the proven part",
    description: "Pay the pro only the proven amount from the last invoice check, with the card on file (sandbox). Without voice_code it shows the amount, payee and refund policy and asks for the 4-digit voice code; with the code it pays.",
    inputSchema: z.object({ job_id: jobId, voice_code: z.string().regex(/^\d{4}$/).optional().describe("The homeowner's spoken 4-digit voice code") }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: viewUri("confirm") } },
  }, async ({ job_id, voice_code }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const user = loadUser(uid);
    const job = currentJob(user, job_id);
    if (!job) return plainError("confirm", "You don't have a booked job yet.", steps);
    if (!job.plan) return plainError("confirm", "I need to check the invoice first. Say: he sent the invoice.", steps);
    if (job.payments.length) {
      const paid = job.payments.reduce((s, p) => s + p.amount, 0);
      return reply("confirm", `You already paid ${F.spokenAmount(paid)} dollars to ${F.shortName(job.proName)} for this job. Nothing more was charged.`, receiptCard(job, user), { jobId: job.jobId, alreadyPaid: true }, steps);
    }
    const amount = job.plan.payNow;
    if (amount <= 0) return reply("payment", "Nothing is proven yet, so there's nothing to pay.", paymentCard(job), { jobId: job.jobId, amount: 0 }, steps);
    if (job.voiceCodeFailures >= 3) return plainError("confirm", "That voice code didn't match three times, so payments are locked for this job. Nothing was paid.", steps);
    steps.add({ service: "Payment method", op: "card on file", mode: "sandbox", ms: 0, summary: `${user.paymentMethod.id} · pre-configured · no new payment methods` });
    if (!voice_code || !job.paymentPrompt || job.paymentPrompt.amount !== amount) {
      // Read the amount, payee and refund policy back before asking for the code (policy §16).
      updateUser(uid, (s) => { findJob(s, job.jobId).paymentPrompt = { amount, at: clk.now }; });
      return reply("confirm", F.voicePayPrompt(job.proName, amount), confirmCard(job, user, amount, null), { jobId: job.jobId, amount, payee: job.proName, needsVoiceCode: true, card: user.paymentMethod, policies: job.policies }, steps);
    }
    const ok = steps.sync("Voice code", "check", "sandbox", () => checkVoiceCode(user, voice_code), (r) => (r ? "match" : "no match · nothing paid"));
    if (!ok) {
      const left = updateUser(uid, (s) => { const j = findJob(s, job.jobId); j.voiceCodeFailures += 1; return 3 - j.voiceCodeFailures; });
      const speech = left > 0 ? "That code didn't match. Nothing was paid. Say your four-digit voice code again." : "That code didn't match three times, so payments are locked for this job. Nothing was paid.";
      return reply("confirm", speech, confirmCard(job, user, amount, "code didn't match · nothing paid"), { jobId: job.jobId, paid: false, attemptsLeft: left }, steps, true);
    }
    const cap = await steps.run("Marketplace payments", "partial capture", "sandbox", () => services.capture({ partnerBookingId: job.partnerBookingId, amount, idempotencyKey: `${uid}:${job.jobId}:${job.plan!.engine}:${amount}` }), (r) => `${r.status} ${F.usd(r.amount)} · ${r.captureId}`);
    const updated = updateUser(uid, (s) => {
      const j = findJob(s, job.jobId);
      j.payments.push({ captureId: cap.captureId, amount: cap.amount, at: clk.now, mode: "sandbox", status: cap.status });
      j.paymentPrompt = null; j.voiceCodeFailures = 0;
      return j;
    });
    return reply("confirm", F.voicePaid(cap.amount, job.plan.waits), receiptCard(updated, user), { jobId: job.jobId, paid: true, amount: cap.amount, captureId: cap.captureId, waits: job.plan.waits, mode: "sandbox" }, steps);
  });

  // ---------- job_status ----------
  registerAppTool(server, "job_status", {
    title: "What's left on a job",
    description: "Say what is still open on the current job (unproven items, charges outside the scope, unpaid amounts), from saved state. Works in any later conversation.",
    inputSchema: z.object({ job_id: jobId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: viewUri("status") } },
  }, async ({ job_id }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const user = steps.sync("Saved job state", "read", "sandbox", () => loadUser(uid), (s) => `${s.jobs.length} job(s) on your account`);
    const job = currentJob(user, job_id);
    if (!job) return plainError("status", "You don't have any jobs yet.", steps);
    const open = F.openItems(job);
    return reply("status", F.voiceStatus(job), statusCard(job, open), { jobId: job.jobId, status: job.status, open, paid: job.payments.reduce((s, p) => s + p.amount, 0), waits: job.plan?.waits ?? null }, steps);
  });

  // ---------- draft_note ----------
  registerAppTool(server, "draft_note", {
    title: "Draft a note to the pro",
    description: "Draft a plain note to the pro about what is still open. The homeowner sends it; this add-on never sends messages.",
    inputSchema: z.object({ job_id: jobId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: viewUri("draft") } },
  }, async ({ job_id }, ctx) => {
    const uid = userIdOf(ctx);
    const steps = new Steps();
    const clk = await services.now();
    const job = currentJob(loadUser(uid), job_id);
    if (!job) return plainError("draft", "You don't have any jobs yet.", steps);
    const text = steps.sync("Draft note", "compose (fixed template, no model)", "sandbox", () => draftText(job), () => "not sent · you send it");
    updateUser(uid, (s) => { findJob(s, job.jobId).drafts.push({ text, at: clk.now }); });
    return reply("draft", F.voiceDraft(job.proName), draftCard(job, text), { jobId: job.jobId, text, sent: false }, steps);
  });

  // ---------- MCP Apps views ----------
  for (const v of VIEWS) {
    const uri = viewUri(v);
    registerAppResource(server, `proofpay-${v}`, uri, { mimeType: RESOURCE_MIME_TYPE, description: `Proof Before Pay ${v} card (MCP App view)` }, async () => {
      const file = join(ROOT, "dist", "views", `${v}.html`);
      if (!existsSync(file)) throw new Error(`${file} missing - run "npm run build" first`);
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(file, "utf8") }] };
    });
  }
  return server;
}
