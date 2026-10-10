// TEMPORARY FAKE — delete when lane CORE lands src/core/{reconcile,registry,doorbell} and src/sandbox/server.ts.
// It exists only so lane APP can build and verify the MCP server, cards and host before CORE is merged.
// Everything here is fictional and returns the SPEC §1 demo numbers:
//   - logic fakes: lookupLicense (fixture verdicts), reconcile (SPEC §3.1 rules), visitWindow (SPEC §3.3), HMAC sign/verify
//   - startFakeSandbox(): marketplace /spi/*, camera history /ring/*, clock /sim/* on the SPEC §3.4 paths
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Charge, Evidence, LicenseCheck, LineResult, PaymentPlan, ScopeOfWork, VisitWindow } from "../core/types.ts";
import type { CameraEvent, SpiCharge, SpiProfessional } from "./services.ts";

// ---------- scenario (SPEC §1; times are Florida local = EDT, UTC-4) ----------
const T = (local: string) => Date.parse(`${local}-04:00`);
export const SCENARIO = {
  clockStart: T("2026-10-13T18:30:00"),
  bookingStart: T("2026-10-15T10:00:00"),
  bookingEnd: T("2026-10-15T12:00:00"),
  advanceTo: T("2026-10-15T14:15:00"),
  invoiceAt: T("2026-10-15T11:50:00"),
  deviceId: "front-door-1",
  accountId: "acct-sandbox-1",
  pros: [
    { professionalId: "P1", businessName: "Bright Current Electric", trade: "electrician", rating: 4.8, reviewCount: 212, costEstimate: 112000, licenseNumber: "EC99000101" },
    { professionalId: "P2", businessName: "Harbor Line Electrical", trade: "electrician", rating: 4.6, reviewCount: 98, costEstimate: 126000, licenseNumber: "EC99000102" },
    { professionalId: "P3", businessName: "Quick Volt Pros", trade: "electrician", rating: 4.9, reviewCount: 41, costEstimate: 89000, licenseNumber: "EC99000103" },
  ] satisfies SpiProfessional[],
  estimate: {
    P1: [
      ["Replace 12 standard outlets", 12, 36000],
      ["Install 2 GFCI outlets in master bath", 2, 19000],
      ["Replace 6 light switches", 6, 15000],
      ["Replace 3 bedroom smoke detectors", 3, 21000],
      ["Replace hallway smoke detector", 1, 7000],
      ["Restore master bath fan circuit", 1, 14000],
    ],
    P2: [
      ["Replace 12 standard outlets", 12, 40000],
      ["Install 2 GFCI outlets in master bath", 2, 21000],
      ["Replace 6 light switches", 6, 17000],
      ["Replace 3 bedroom smoke detectors", 3, 24000],
      ["Replace hallway smoke detector", 1, 8000],
      ["Restore master bath fan circuit", 1, 16000],
    ],
  } as Record<string, [string, number, number][]>,
  photos: [
    ["S1", "2026-10-15T10:05:00"], ["S2", "2026-10-15T10:20:00"], ["S3", "2026-10-15T10:45:00"],
    ["S4", "2026-10-15T11:05:00"], ["S6", "2026-10-15T11:35:00"],
  ] as [string, string][],
  camera: [
    ["button_press", null, "2026-10-15T10:02:00"],
    ["motion_detected", "human", "2026-10-15T10:02:20"],
    ["motion_detected", "human", "2026-10-15T10:31:00"],
    ["motion_detected", "human", "2026-10-15T11:12:00"],
    ["motion_detected", "human", "2026-10-15T11:40:00"],
  ] as [string, string | null, string][],
  registry: {
    EC99000101: { licenseType: "Certified Electrical Contractor", name: "BRIGHT CURRENT ELECTRIC LLC", status: "Current, Active", expires: "08/31/2028" },
    EC99000102: { licenseType: "Certified Electrical Contractor", name: "HARBOR LINE ELECTRICAL INC", status: "Current, Active", expires: "08/31/2028" },
  } as Record<string, { licenseType: string; name: string; status: string; expires: string }>,
};

// ---------- logic fakes ----------
const STOP = new Set(["LLC", "INC", "CORP", "CO", "COMPANY", "SERVICES", "SERVICE", "GROUP"]);
const norm = (s: string) => s.toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return A.size + B.size - inter ? inter / (A.size + B.size - inter) : 0;
}
export function nameMatch(claimed: string, names: string[]): LicenseCheck["nameMatch"] {
  const c = norm(claimed);
  let best: LicenseCheck["nameMatch"] = "mismatch";
  for (const n of names) {
    const t = norm(n);
    if (t.join(" ") === c.join(" ")) return "match";
    if (jaccard(c, t) >= 0.5) best = "partial";
  }
  return best;
}

export async function lookupLicense(licenseNumber: string, claimedName: string, opts: { mode: "fixture" | "live" | "auto"; now?: number }): Promise<LicenseCheck> {
  const asOf = new Date(opts.now ?? Date.now()).toISOString();
  const known = /^EC990001\d\d$/.test(licenseNumber);
  const source = { service: "Florida DBPR license search", mode: "fixture" as const, ref: "https://www.myfloridalicense.com/wl11.asp", asOf };
  if (opts.mode === "live" || (opts.mode === "auto" && !known)) {
    // The fake cannot reach the live registry; the real module does. Never "verified" without an answer.
    return { query: licenseNumber, found: false, records: [], active: false, claimedName, nameMatch: "n/a", verdict: "unavailable", source: { ...source, mode: "live" } };
  }
  const rec = SCENARIO.registry[licenseNumber];
  if (!rec) return { query: licenseNumber, found: false, records: [], active: false, claimedName, nameMatch: "n/a", verdict: "not_found", source };
  const records = [{ licenseNumber, licenseType: rec.licenseType, names: [{ name: rec.name, nameType: "Primary" }], status: rec.status, expires: rec.expires }];
  const nm = nameMatch(claimedName, [rec.name]);
  return { query: licenseNumber, found: true, records, active: /Active/.test(rec.status), claimedName, nameMatch: nm, verdict: nm === "mismatch" ? "name_mismatch" : "verified", source };
}

export function signBody(raw: Buffer | string, key: string): string {
  return `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
}
export function verifySignature(raw: Buffer, header: string | undefined, key: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(raw, key));
  const got = Buffer.from(header.trim());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function visitWindow(events: CameraEvent[], booking: { start: number; end: number }, consentGranted: boolean): VisitWindow {
  const source = { service: "Front door camera events", mode: "fixture" as const };
  if (!consentGranted) return { arrivedAt: null, leftAt: null, eventIds: [], source: { ...source, ref: "no visit-logging consent" } };
  const lo = booking.start - 60 * 60_000, hi = booking.end + 120 * 60_000;
  const inSpan = events.filter((e) => e.at >= lo && e.at <= hi).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const isArrival = (e: CameraEvent) => e.kind === "button_press" || e.kind === "ding" || ((e.kind === "motion_detected" || e.kind === "motion") && e.subType === "human");
  const first = inSpan.find(isArrival);
  if (!first) return { arrivedAt: null, leftAt: null, eventIds: [], source };
  const humans = inSpan.filter((e) => e.at >= first.at && (e.kind === "motion_detected" || e.kind === "motion") && e.subType === "human");
  const last = humans.length ? humans[humans.length - 1] : first;
  return { arrivedAt: first.at, leftAt: last.at, eventIds: [...new Set([first.id, ...humans.map((h) => h.id)])], source };
}

const STOPWORDS = new Set(["a", "an", "the", "in", "of", "and", "to", "for", "on"]);
const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));

export function reconcile(scope: ScopeOfWork, invoice: Charge[], evidence: Evidence, opts: { photoSlackMs?: number } = {}): PaymentPlan {
  const slack = opts.photoSlackMs ?? 15 * 60_000;
  const blockers: string[] = [];
  if (evidence.license.verdict !== "verified") blockers.push(`License ${evidence.license.query} is not verified (${evidence.license.verdict.replace("_", " ")}).`);
  const needsVisit = scope.items.some((i) => i.proof.includes("visit"));
  if (needsVisit && !scope.visitLoggingConsent.granted) blockers.push("Visit logging was not agreed, so the visit cannot be confirmed.");
  const photoRules = scope.items.some((i) => i.proof.includes("photo"));
  if (photoRules && scope.visitLoggingConsent.granted && evidence.visit.arrivedAt === null) blockers.push("No visit was logged at the front door.");
  const win = evidence.visit.arrivedAt !== null && evidence.visit.leftAt !== null ? [evidence.visit.arrivedAt - slack, evidence.visit.leftAt + slack] : null;
  const matched = new Set<string>();
  const lines: LineResult[] = invoice.map((line) => {
    let item = line.scopeItemId ? scope.items.find((i) => i.id === line.scopeItemId) : undefined;
    if (!item && !line.scopeItemId) {
      const scored = scope.items.map((i) => ({ i, s: jaccard(toks(line.chargeDescription), toks(i.description)) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
      if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) item = scored[0].i;
    }
    if (!item) return { line, verdict: { kind: "not_in_scope", reasons: [`"${line.chargeDescription}" is not in the agreed scope`] }, payNow: 0, waits: line.amount };
    if (matched.has(item.id)) return { line, verdict: { kind: "over_scope", scopeItemId: item.id, reasons: [`second charge for ${item.id}`] }, payNow: 0, waits: line.amount };
    matched.add(item.id);
    const reasons: string[] = [];
    let proven = true;
    if (item.proof.includes("photo")) {
      const ph = evidence.photos.filter((p) => p.scopeItemId === item!.id);
      const inWin = win ? ph.filter((p) => p.takenAt >= win[0] && p.takenAt <= win[1]) : ph;
      if (!ph.length) { proven = false; reasons.push("no photo"); }
      else if (!inWin.length) { proven = false; reasons.push("photo taken outside the visit"); }
      else reasons.push(`${inWin.length} photo(s) during the visit`);
    }
    if (item.proof.includes("visit") && (evidence.visit.arrivedAt === null || evidence.visit.leftAt === null)) { proven = false; reasons.push("no logged visit"); }
    if (!proven) return { line, verdict: { kind: "unproven", scopeItemId: item.id, reasons }, payNow: 0, waits: line.amount };
    if (line.amount > item.price) return { line, verdict: { kind: "over_scope", scopeItemId: item.id, reasons: [...reasons, "amount above scope price"] }, payNow: item.price, waits: line.amount - item.price };
    return { line, verdict: { kind: "proven", scopeItemId: item.id, reasons }, payNow: line.amount, waits: 0 };
  });
  if (blockers.length) for (const l of lines) { l.waits += l.payNow; l.payNow = 0; }
  const notConfirmed = [
    ...blockers,
    ...lines.filter((l) => l.verdict.kind !== "proven" || l.waits > 0).map((l) => {
      const v = l.verdict;
      const name = v.kind === "not_in_scope" ? l.line.chargeDescription : scope.items.find((i) => i.id === v.scopeItemId)?.description ?? l.line.chargeDescription;
      return v.kind === "not_in_scope" ? `"${name}" was not in the agreed scope.` : v.kind === "over_scope" ? `${name}: charged above the agreed scope.` : v.kind === "unproven" ? `${name}: ${v.reasons.join(", ")}.` : `${name}: waits for a job-level check.`;
    }),
  ];
  const payNow = lines.reduce((s, l) => s + l.payNow, 0);
  const invoiceTotal = invoice.reduce((s, l) => s + l.amount, 0);
  return { jobId: scope.jobId, invoiceTotal, payNow, waits: invoiceTotal - payNow, lines, blockers, notConfirmed, engine: "reconcile-v1" };
}

// ---------- fake sandbox services (marketplace, camera, clock) ----------
type Booking = { alexaBookingId: string; partnerBookingId: string; proId: string; status: string; start: number; end: number };

export async function startFakeSandbox(opts: { port: number; webhookUrl: string; signingKey: string; quiet?: boolean }): Promise<{ url: string; close: () => Promise<void> }> {
  let now = SCENARIO.clockStart;
  let seq = 0;
  let bookings = new Map<string, Booking>();
  let emitted = new Set<string>();
  const captures = new Map<string, { captureId: string; amount: number; status: string; partnerBookingId: string }>();
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log("[fake-sandbox]", ...a); };
  const local = (iso: string) => T(iso);

  const estimateFor = (proId: string) => (SCENARIO.estimate[proId] ?? []).map(([d, q, a]) => ({ chargeDescription: d, chargeCategory: "SERVICE" as const, quantity: q, amount: a }));
  const cameraEvents = () => SCENARIO.camera.map(([kind, sub, iso]) => ({ kind, sub, at: local(iso), id: `${SCENARIO.deviceId}_${kind === "button_press" ? "button_press" : "motion"}_${local(iso) / 1000}` }));
  const activeBooking = () => [...bookings.values()].find((b) => b.status === "CONFIRMED");

  async function emitDue(): Promise<number> {
    let n = 0;
    if (!activeBooking()) return 0; // the camera only matters while a job is booked; nothing to emit otherwise
    for (const ev of cameraEvents()) {
      if (ev.at > now || emitted.has(ev.id)) continue;
      const body = JSON.stringify({
        data: { type: ev.kind, id: ev.id, attributes: { source: SCENARIO.deviceId, source_type: "devices", timestamp: ev.at, timestamp_readable: new Date(ev.at).toISOString(), ...(ev.sub ? { sub_type: ev.sub } : {}) } },
        meta: { version: "1.1", time: new Date(ev.at).toISOString(), request_id: randomUUID(), account_id: SCENARIO.accountId },
      });
      const res = await fetch(opts.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": signBody(body, opts.signingKey) }, body });
      if (res.ok) { emitted.add(ev.id); n++; } else log(`webhook ${ev.id} -> HTTP ${res.status}`);
    }
    return n;
  }

  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(JSON.stringify(body));
  };

  const http: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      if (req.method === "OPTIONS") { send(res, 204, {}); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (p === "/healthz") return send(res, 200, { ok: true, fake: true });
      if (p === "/sim/clock") return send(res, 200, { now, iso: new Date(now).toISOString(), simulated: true });
      if (p === "/sim/advance" && req.method === "POST") {
        const to = body.to ? Date.parse(body.to) : SCENARIO.advanceTo;
        if (Number.isNaN(to)) return send(res, 400, { error: "bad 'to'" });
        if (to > now) now = to;
        const n = await emitDue();
        return send(res, 200, { now, iso: new Date(now).toISOString(), emitted: n });
      }
      if (p === "/sim/reset" && req.method === "POST") {
        now = SCENARIO.clockStart; seq = 0; bookings = new Map(); emitted = new Set(); captures.clear();
        return send(res, 200, { ok: true, scenario: body.scenario ?? "demo", now });
      }
      if (p === "/spi/ListProfessionals" && req.method === "POST") return send(res, 200, { professionals: SCENARIO.pros });
      if (p === "/spi/CreateBooking" && req.method === "POST") {
        const pro = SCENARIO.pros.find((x) => x.professionalId === body.professionalId);
        if (!pro || !SCENARIO.estimate[pro.professionalId]) return send(res, 400, { error: "unknown or unbookable professional" });
        let b = body.partnerBookingId ? bookings.get(body.partnerBookingId) : [...bookings.values()].find((x) => x.alexaBookingId === body.alexaBookingId);
        if (!b) {
          b = { alexaBookingId: body.alexaBookingId, partnerBookingId: `PB-${String(++seq).padStart(4, "0")}`, proId: pro.professionalId, status: "PENDING", start: SCENARIO.bookingStart, end: SCENARIO.bookingEnd };
          bookings.set(b.partnerBookingId, b);
        }
        if (body.stage === "CONFIRMATION") b.status = "CONFIRMED";
        const charges = estimateFor(pro.professionalId);
        return send(res, 200, {
          stage: body.stage,
          booking: { alexaBookingId: b.alexaBookingId, partnerBookingId: b.partnerBookingId, status: b.status, professionalId: b.proId, appointment: { start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() } },
          purchaseDetails: {
            charges, total: charges.reduce((s, c) => s + c.amount, 0),
            policies: [
              { policyType: "CANCELLATION", text: "Free cancellation until 24 hours before the visit; $50 after that." },
              { policyType: "REFUND", text: `Refunds for work not done, within 30 days, under ${pro.businessName}'s policy.` },
            ],
            paymentInstruments: [{ paymentInstrumentType: "CARD", paymentInstrumentId: "•• 42", wallet: "sandbox" }],
          },
          visitLogging: { proConsent: true },
        });
      }
      if (p === "/spi/CancelBooking" && req.method === "POST") {
        const b = bookings.get(body.partnerBookingId);
        if (!b) return send(res, 404, { error: "no such booking" });
        b.status = "CANCELLED";
        return send(res, 200, { bookingStatus: "CANCELLED" });
      }
      let m: RegExpMatchArray | null;
      if ((m = p.match(/^\/spi\/GetBooking\/(.+)$/))) {
        const b = bookings.get(decodeURIComponent(m[1]));
        return b ? send(res, 200, { booking: b }) : send(res, 404, { error: "no such booking" });
      }
      if ((m = p.match(/^\/spi\/invoice\/(.+)$/))) {
        const b = bookings.get(decodeURIComponent(m[1]));
        if (!b || b.status !== "CONFIRMED" || now < SCENARIO.invoiceAt) return send(res, 404, { error: "no invoice yet" });
        const charges: SpiCharge[] = estimateFor(b.proId).map((c, i) => ({ ...c, scopeItemId: `S${i + 1}` }));
        charges.push({ chargeDescription: "Electrical inspection", chargeCategory: "SERVICE", amount: 30000, quantity: 1 });
        return send(res, 200, { charges, submittedAt: SCENARIO.invoiceAt });
      }
      if ((m = p.match(/^\/spi\/photos\/(.+)$/))) {
        const b = bookings.get(decodeURIComponent(m[1]));
        if (!b) return send(res, 404, { error: "no such booking" });
        const photos = SCENARIO.photos.map(([id, iso], i) => ({ photoId: `photo-${b.partnerBookingId}-${i + 1}`, scopeItemId: id, takenAt: local(iso) })).filter((x) => x.takenAt <= now);
        return send(res, 200, { photos });
      }
      if (p === "/spi/capture" && req.method === "POST") {
        const prior = captures.get(body.idempotencyKey);
        if (prior) return send(res, 200, prior);
        const b = bookings.get(body.partnerBookingId);
        if (!b || !Number.isInteger(body.amount) || body.amount <= 0) return send(res, 400, { error: "bad capture" });
        const c = { captureId: `CAP-${String(captures.size + 1).padStart(4, "0")}`, amount: body.amount, status: "CAPTURED", partnerBookingId: b.partnerBookingId };
        captures.set(body.idempotencyKey, c);
        return send(res, 200, c);
      }
      if ((m = p.match(/^\/ring\/v1\/history\/devices\/([^/]+)\/events$/))) {
        if (req.headers.authorization !== "Bearer sandbox") return send(res, 401, { error: "unauthorized" });
        const from = Number(url.searchParams.get("start") ?? 0), to = Math.min(Number(url.searchParams.get("end") ?? now), now);
        const data = cameraEvents().filter((e) => e.at >= from && e.at <= to).map((e) => ({
          type: "history-events", id: e.id, attributes: { event_type: e.kind === "button_press" ? "ding" : "motion", start: new Date(e.at).toISOString(), end: new Date(e.at + 20_000).toISOString() },
          relationships: { source: { data: { type: "devices", id: decodeURIComponent(m![1]) } } },
        }));
        return send(res, 200, { data, links: { next: null } });
      }
      send(res, 404, { error: `no route ${req.method} ${p}` });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(opts.port, "127.0.0.1", () => resolve()); });
  const port = (http.address() as { port: number }).port;
  log(`fake sandbox on http://127.0.0.1:${port} (webhooks -> ${opts.webhookUrl})`);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()); }) };
}

if (import.meta.main) {
  const port = Number(process.env.SANDBOX_PORT ?? 8791);
  const s = await startFakeSandbox({ port, webhookUrl: process.env.ADDON_WEBHOOK_URL ?? "http://127.0.0.1:8787/webhooks/doorbell", signingKey: process.env.RING_SIGNING_KEY ?? "sandbox-signing-key-not-secret" });
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
