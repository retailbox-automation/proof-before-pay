import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, descriptionTokens, jaccard } from "./reconcile.ts";
import type { Charge, Evidence, LicenseCheck, Photo, ScopeItem, ScopeOfWork } from "./types.ts";

// Demo numbers from SPEC 1 (Thursday 2026-10-15, America/New_York = UTC-4).
const T = (hhmm: string) => Date.parse(`2026-10-15T${hhmm}:00-04:00`);
const MIN = 60_000;

const ITEMS: ScopeItem[] = [
  { id: "S1", description: "Replace 12 standard outlets", quantity: 12, price: 36000, proof: ["photo"] },
  { id: "S2", description: "Install 2 GFCI outlets in master bath", quantity: 2, price: 19000, proof: ["photo"] },
  { id: "S3", description: "Replace 6 light switches", quantity: 6, price: 15000, proof: ["photo"] },
  { id: "S4", description: "Replace 3 bedroom smoke detectors", quantity: 3, price: 21000, proof: ["photo"] },
  { id: "S5", description: "Replace hallway smoke detector", quantity: 1, price: 7000, proof: ["photo"] },
  { id: "S6", description: "Restore master bath fan circuit", quantity: 1, price: 14000, proof: ["photo"] },
];

function scope(overrides: Partial<ScopeOfWork> = {}): ScopeOfWork {
  return {
    jobId: "J1",
    proId: "P1",
    items: ITEMS,
    permit: "not_needed",
    visitLoggingConsent: { granted: true, byPro: true, byHomeowner: true, at: T("09:00"), source: { service: "Booking confirmation", mode: "sandbox", ref: "PB-1001" } },
    ...overrides,
  };
}

function invoice(): Charge[] {
  return [
    ...ITEMS.map((i) => ({ chargeDescription: i.description, chargeCategory: "SERVICE" as const, amount: i.price, scopeItemId: i.id, quantity: i.quantity })),
    { chargeDescription: "Electrical inspection", chargeCategory: "SERVICE", amount: 30000 },
  ];
}

const license = (verdict: LicenseCheck["verdict"] = "verified"): LicenseCheck => ({
  query: "EC99000101",
  found: verdict !== "not_found" && verdict !== "unavailable",
  records: [],
  active: verdict === "verified" || verdict === "name_mismatch",
  claimedName: "Bright Current Electric",
  nameMatch: verdict === "name_mismatch" ? "mismatch" : verdict === "verified" ? "match" : "n/a",
  verdict,
  source: { service: "Florida DBPR license search", mode: "fixture", ref: "fixtures/registry/dbpr-found.sample.html", asOf: "10/09/2026 11:30 PM" },
});

const photo = (id: string, item: string | null, at: number): Photo => ({ photoId: id, scopeItemId: item, takenAt: at, source: { service: "Marketplace photos", mode: "sandbox", ref: id } });

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    license: license(),
    visit: { arrivedAt: T("10:02"), leftAt: T("11:40"), eventIds: ["dev_button_press_1", "dev_motion_2"], source: { service: "Front door camera (Ring Partner API format)", mode: "sandbox" } },
    photos: [
      photo("PH-S1", "S1", T("10:15")),
      photo("PH-S2", "S2", T("10:42")),
      photo("PH-S3", "S3", T("10:58")),
      photo("PH-S4", "S4", T("11:12")),
      photo("PH-S6", "S6", T("11:33")),
    ],
    ...overrides,
  };
}

test("demo case: pay 1,050 now, 370 waits, exactly 2 not-confirmed entries", () => {
  const plan = reconcile(scope(), invoice(), evidence());
  assert.equal(plan.invoiceTotal, 142000);
  assert.equal(plan.payNow, 105000);
  assert.equal(plan.waits, 37000);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.notConfirmed.length, 2);
  assert.equal(plan.engine, "reconcile-v1");
  assert.equal(plan.jobId, "J1");
  const kinds = plan.lines.map((l) => [l.line.chargeDescription, l.verdict.kind, l.payNow, l.waits]);
  assert.deepEqual(kinds, [
    ["Replace 12 standard outlets", "proven", 36000, 0],
    ["Install 2 GFCI outlets in master bath", "proven", 19000, 0],
    ["Replace 6 light switches", "proven", 15000, 0],
    ["Replace 3 bedroom smoke detectors", "proven", 21000, 0],
    ["Replace hallway smoke detector", "unproven", 0, 7000],
    ["Restore master bath fan circuit", "proven", 14000, 0],
    ["Electrical inspection", "not_in_scope", 0, 30000],
  ]);
  assert.match(plan.notConfirmed[0], /hallway smoke detector.*no photo/i);
  assert.match(plan.notConfirmed[1], /Electrical inspection.*\$300\.00.*not in the agreed scope/);
  // Sum invariant on every line.
  for (const l of plan.lines) assert.equal(l.payNow + l.waits, l.line.amount);
});

test("no license -> every line waits, blocker names the registry", () => {
  for (const verdict of ["not_found", "inactive", "name_mismatch", "unavailable"] as const) {
    const plan = reconcile(scope(), invoice(), evidence({ license: license(verdict) }));
    assert.equal(plan.payNow, 0, verdict);
    assert.equal(plan.waits, 142000, verdict);
    assert.equal(plan.blockers.length, 1, verdict);
    assert.match(plan.blockers[0], /Florida DBPR license search/);
    assert.equal(plan.notConfirmed[0], plan.blockers[0]);
    assert.ok(plan.lines.every((l) => l.payNow === 0), verdict);
    // Line verdicts are still computed so the card can show what would have been proven.
    assert.equal(plan.lines[0].verdict.kind, "proven");
    assert.ok(plan.lines[0].verdict.reasons.some((r) => r.includes("job-level")));
  }
});

test("consent missing: visit-proof item -> blocker; photo-only scope -> photos by tag, time not checked", () => {
  const noConsent = { granted: false, byPro: true, byHomeowner: false, at: null, source: { service: "Booking confirmation", mode: "sandbox" as const } };
  const noVisit = { arrivedAt: null, leftAt: null, eventIds: [], source: { service: "Front door camera (Ring Partner API format)", mode: "sandbox" as const, ref: "not used: visit logging consent missing" } };

  const withVisitItem = scope({ visitLoggingConsent: noConsent, items: ITEMS.map((i) => (i.id === "S6" ? { ...i, proof: ["photo", "visit"] } : i)) });
  const blocked = reconcile(withVisitItem, invoice(), evidence({ visit: noVisit }));
  assert.equal(blocked.payNow, 0);
  assert.equal(blocked.waits, 142000);
  assert.equal(blocked.blockers.length, 1);
  assert.match(blocked.blockers[0], /Visit logging was not agreed/);

  const photoOnly = reconcile(scope({ visitLoggingConsent: noConsent }), invoice(), evidence({ visit: noVisit }));
  assert.deepEqual(photoOnly.blockers, []);
  assert.equal(photoOnly.payNow, 105000);
  assert.ok(photoOnly.lines[0].verdict.reasons.some((r) => r.includes("photo time is not checked")));

  // Consent claimed but one side missing counts as no consent.
  const halfConsent = scope({ visitLoggingConsent: { ...noConsent, granted: true, byHomeowner: false } });
  const half = reconcile({ ...halfConsent, items: withVisitItem.items }, invoice(), evidence());
  assert.equal(half.payNow, 0);
});

test("consent granted but camera logged no arrival -> blocker", () => {
  const plan = reconcile(scope(), invoice(), evidence({ visit: { arrivedAt: null, leftAt: null, eventIds: [], source: { service: "Front door camera", mode: "sandbox" } } }));
  assert.equal(plan.payNow, 0);
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0], /no arrival/);
});

test("photo outside the visit window -> unproven with a timezone-free reason; slack is honored", () => {
  const ev = evidence();
  ev.photos = ev.photos.map((p) => (p.scopeItemId === "S3" ? { ...p, takenAt: T("13:15") } : p));
  const plan = reconcile(scope(), invoice(), ev);
  const s3 = plan.lines.find((l) => l.line.scopeItemId === "S3")!;
  assert.equal(s3.verdict.kind, "unproven");
  assert.ok(s3.verdict.reasons.some((r) => r.includes("95 min after the pro left")), s3.verdict.reasons.join(" | "));
  assert.equal(plan.payNow, 105000 - 15000);
  assert.equal(plan.notConfirmed.length, 3);

  // 14 min after leaving is inside the default 15 min slack; 16 min is not.
  const within = evidence();
  within.photos = within.photos.map((p) => (p.scopeItemId === "S3" ? { ...p, takenAt: T("11:40") + 14 * MIN } : p));
  assert.equal(reconcile(scope(), invoice(), within).payNow, 105000);
  const outside = evidence();
  outside.photos = outside.photos.map((p) => (p.scopeItemId === "S3" ? { ...p, takenAt: T("11:40") + 16 * MIN } : p));
  assert.equal(reconcile(scope(), invoice(), outside).payNow, 90000);
  assert.equal(reconcile(scope(), invoice(), outside, { photoSlackMs: 20 * MIN }).payNow, 105000);

  // Before arrival.
  const early = evidence();
  early.photos = early.photos.map((p) => (p.scopeItemId === "S1" ? { ...p, takenAt: T("09:00") } : p));
  const e = reconcile(scope(), invoice(), early).lines[0];
  assert.equal(e.verdict.kind, "unproven");
  assert.ok(e.verdict.reasons.some((r) => r.includes("62 min before the pro arrived")));
});

test("duplicate line for an already matched item -> over_scope, whole amount waits", () => {
  const inv = invoice();
  inv.splice(1, 0, { chargeDescription: "Replace 12 standard outlets", chargeCategory: "SERVICE", amount: 36000, scopeItemId: "S1" });
  const plan = reconcile(scope(), inv, evidence());
  assert.equal(plan.lines[0].verdict.kind, "proven");
  assert.equal(plan.lines[1].verdict.kind, "over_scope");
  assert.equal(plan.lines[1].payNow, 0);
  assert.equal(plan.lines[1].waits, 36000);
  assert.equal(plan.payNow, 105000);
  assert.equal(plan.waits, 37000 + 36000);
  assert.ok(plan.notConfirmed.some((s) => s.includes("second charge")));
});

test("explicit scopeItemId claims the item before a description match does", () => {
  const inv: Charge[] = [
    { chargeDescription: "Replace standard outlets (12)", chargeCategory: "LABOR", amount: 36000 },
    { chargeDescription: "Outlets", chargeCategory: "LABOR", amount: 36000, scopeItemId: "S1" },
  ];
  const plan = reconcile(scope(), inv, evidence());
  assert.equal(plan.lines[1].verdict.kind, "proven");
  assert.equal(plan.lines[0].verdict.kind, "over_scope");
  assert.ok(plan.lines[0].verdict.reasons[0].includes("line 2"));
});

test("over-price line pays up to the scope price, the excess waits", () => {
  const inv = invoice().map((l) => (l.scopeItemId === "S2" ? { ...l, amount: 25000 } : l));
  const plan = reconcile(scope(), inv, evidence());
  const s2 = plan.lines[1];
  assert.equal(s2.verdict.kind, "over_scope");
  assert.equal(s2.payNow, 19000);
  assert.equal(s2.waits, 6000);
  assert.equal(plan.payNow, 105000);
  assert.equal(plan.waits, 37000 + 6000);
  assert.ok(plan.notConfirmed.some((s) => s.includes("$60.00 above the agreed $190.00")));

  // Over price AND unproven -> unproven (nothing pays), both reasons kept.
  const inv2 = invoice().map((l) => (l.scopeItemId === "S5" ? { ...l, amount: 9000 } : l));
  const s5 = reconcile(scope(), inv2, evidence()).lines[4];
  assert.equal(s5.verdict.kind, "unproven");
  assert.equal(s5.payNow, 0);
  assert.equal(s5.waits, 9000);
  assert.ok(s5.verdict.reasons.some((r) => r.includes("above the agreed")));
});

test("description-only matching: token Jaccard >= 0.6, best unique match, ties and misses stay out", () => {
  assert.deepEqual(descriptionTokens("Install 2 GFCI outlets, in the Master Bath!"), ["install", "2", "gfci", "outlets", "master", "bath"]);
  assert.equal(jaccard(["a", "b"], ["a", "b", "c"]), 2 / 3);
  const inv: Charge[] = [
    { chargeDescription: "Install two GFCI outlets in master bath", chargeCategory: "LABOR", amount: 19000 }, // 5/7 = 0.71 -> S2
    { chargeDescription: "Replace 6 light switches.", chargeCategory: "LABOR", amount: 15000 }, // exact -> S3
    { chargeDescription: "Smoke detector", chargeCategory: "MATERIAL", amount: 2000 }, // below threshold everywhere
    { chargeDescription: "Trip charge", chargeCategory: "FEE", amount: 4900 },
  ];
  const plan = reconcile(scope(), inv, evidence());
  assert.equal(plan.lines[0].verdict.kind, "proven");
  assert.equal(plan.lines[0].verdict.kind === "proven" && plan.lines[0].verdict.scopeItemId, "S2");
  assert.ok(plan.lines[0].verdict.reasons[0].startsWith("matched to S2 by description"));
  assert.equal(plan.lines[1].verdict.kind === "proven" && plan.lines[1].verdict.scopeItemId, "S3");
  assert.equal(plan.lines[2].verdict.kind, "not_in_scope");
  assert.equal(plan.lines[3].verdict.kind, "not_in_scope");
  assert.equal(plan.payNow, 34000);

  // Tie between two equally good items -> not linked.
  const twins: ScopeItem[] = [
    { id: "A", description: "Paint north wall", quantity: 1, price: 100, proof: ["photo"] },
    { id: "B", description: "Paint south wall", quantity: 1, price: 100, proof: ["photo"] },
  ];
  const tie = reconcile(scope({ items: twins }), [{ chargeDescription: "Paint wall", chargeCategory: "LABOR", amount: 100 }], evidence({ photos: [] }));
  assert.equal(tie.lines[0].verdict.kind, "not_in_scope");
  assert.match(tie.lines[0].verdict.reasons[0], /A and B equally/);

  // Unknown explicit id -> not in scope.
  const unknown = reconcile(scope(), [{ chargeDescription: "Replace 6 light switches", chargeCategory: "LABOR", amount: 15000, scopeItemId: "S9" }], evidence());
  assert.equal(unknown.lines[0].verdict.kind, "not_in_scope");
});

test("visit proof: needs arrival and departure", () => {
  const items: ScopeItem[] = [{ id: "V1", description: "Diagnose fan circuit on site", quantity: 1, price: 9000, proof: ["visit"] }];
  const inv: Charge[] = [{ chargeDescription: "Diagnose fan circuit on site", chargeCategory: "LABOR", amount: 9000, scopeItemId: "V1" }];
  assert.equal(reconcile(scope({ items }), inv, evidence()).payNow, 9000);
  const noLeave = evidence({ visit: { arrivedAt: T("10:02"), leftAt: null, eventIds: [], source: { service: "Front door camera", mode: "sandbox" } } });
  const plan = reconcile(scope({ items }), inv, noLeave);
  assert.equal(plan.payNow, 0);
  assert.equal(plan.lines[0].verdict.kind, "unproven");
});

test("empty invoice: nothing to pay, nothing waits", () => {
  const plan = reconcile(scope(), [], evidence());
  assert.equal(plan.invoiceTotal, 0);
  assert.equal(plan.payNow, 0);
  assert.equal(plan.waits, 0);
  assert.deepEqual(plan.lines, []);
  assert.deepEqual(plan.notConfirmed, []);
});

test("determinism: same input twice -> deep-equal and byte-identical JSON; inputs not mutated", () => {
  const s = scope();
  const inv = invoice();
  const ev = evidence();
  ev.photos.reverse(); // input order must not matter
  const before = JSON.stringify([s, inv, ev]);
  const a = reconcile(s, inv, ev);
  const b = reconcile(s, inv, ev);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify([s, inv, ev]), before);
  assert.equal(a.payNow, 105000);
});

test("invalid money is rejected loudly", () => {
  assert.throws(() => reconcile(scope(), [{ chargeDescription: "x", chargeCategory: "OTHER", amount: 10.5 }], evidence()), RangeError);
  assert.throws(() => reconcile(scope(), [{ chargeDescription: "x", chargeCategory: "OTHER", amount: -100 }], evidence()), RangeError);
});
