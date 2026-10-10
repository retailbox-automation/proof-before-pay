import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ROOT, classify, main, parseLedger, renderMarkdown, runBacktest, summaryJson, type Engagement } from "./backtest.ts";

const EXAMPLE = join(APP_ROOT, "data/backtest/engagements.example.json");
const example = () => parseLedger(JSON.parse(readFileSync(EXAMPLE, "utf8")));

test("example ledger: totals, per-gate counts and not-caught list", () => {
  const r = runBacktest(example());
  assert.deepEqual(r.totals, { engagements: 3, hired: 2, wentWrong: 3, wentWrongCaught: 2, wentWrongFullyCaught: 2, wentWrongNotCaught: 1 });
  const g = Object.fromEntries(r.gates.map((x) => [x.id, [x.engagementsCaught, x.alreadyCaughtPrehire, x.problemsCaught, x.ids]]));
  assert.deepEqual(g, {
    license: [1, 1, 1, ["E02"]],
    scope: [1, 0, 1, ["E01"]],
    visit: [0, 0, 0, []],
    proof: [1, 0, 2, ["E01"]], // paid_before_proof + refund_refused (paid before proof)
  });
  assert.equal(r.gates.find((x) => x.id === "proof")!.amountPaidUsdOnCaught, 1100);
  assert.deepEqual(r.notCaught.map((n) => [n.id, n.problem]), [["E03", "overpriced"], ["E03", "access_issue"]]);
  assert.match(r.notCaught[1].reason, /door code is simulated/);
});

test("gate rules exactly as specified", () => {
  const row = (problems: Engagement["problems"]): Engagement => ({ id: "E99", trade: "t", category: "c", hired: true, stage_reached: "s", outcome: "o", problems, went_wrong: true, caught_prehire: false, amount_quoted_usd: null, amount_paid_usd: null, month: "2025-01" });
  const gateOf = (p: Engagement["problems"][number], others: Engagement["problems"] = []) => classify(p, row([p, ...others])).gate;
  assert.equal(gateOf("no_license"), "license");
  assert.equal(gateOf("license_mismatch"), "license");
  for (const p of ["scope_creep_or_upsell", "invoice_line_not_in_scope", "billed_unverified_quantity"] as const) assert.equal(gateOf(p), "scope", p);
  for (const p of ["no_show", "late_or_missed_window"] as const) assert.equal(gateOf(p), "visit", p);
  for (const p of ["work_incomplete", "work_defective", "claimed_done_before_proof", "paid_before_proof"] as const) assert.equal(gateOf(p), "proof", p);
  assert.equal(gateOf("refund_refused", ["paid_before_proof"]), "proof");
  assert.equal(gateOf("refund_refused"), null);
  for (const p of ["access_issue", "overpriced", "slow_or_phone_only_comm", "missing_materials", "bbb_rating_f", "other"] as const) {
    const v = classify(p, row([p]));
    assert.equal(v.gate, null, p);
    assert.ok(v.reason.length > 10, p);
  }
});

test("schema: strict fields, known problem tags, unique ids, no personal data", () => {
  const good = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  assert.equal(parseLedger(good).length, 3);
  const mutate = (fn: (rows: Record<string, unknown>[]) => void) => { const rows = structuredClone(good); fn(rows); return () => parseLedger(rows); };
  assert.throws(mutate((r) => { r[0].note = "called him twice"; }), /note|unrecognized/i);
  assert.throws(mutate((r) => { r[0].problems = ["rude"]; }));
  assert.throws(mutate((r) => { r[1].id = "E01"; }), /duplicate id E01/);
  assert.throws(mutate((r) => { r[0].id = "job-1"; }));
  assert.throws(mutate((r) => { r[0].month = "2024-13"; }));
  assert.throws(mutate((r) => { r[0].outcome = "call back at 407-555-0134"; }), /phone number/);
  assert.throws(mutate((r) => { r[0].outcome = "wrote to someone@example.com"; }), /email/);
  assert.throws(mutate((r) => { r[0].outcome = "license EC13001234 lapsed"; }), /license number/);
  assert.throws(mutate((r) => { r[0].outcome = "job at 1234 Palm Tree Drive"; }), /street address/);
  assert.throws(() => parseLedger([]));
});

test("output is deterministic; markdown and JSON carry the same numbers", () => {
  const meta = { file: "data/backtest/engagements.example.json", sha256: "0".repeat(64), rows: 3 };
  const a = runBacktest(example());
  const b = runBacktest(example().reverse());
  assert.deepEqual(a, b);
  const md = renderMarkdown(a, meta);
  assert.equal(md, renderMarkdown(b, meta));
  assert.match(md, /\| 3 \| 2 \| 3 \| 2 \(67%\) \| 2 \(67%\) \| 1 \(33%\) \|/);
  assert.match(md, /\| E03 \| plumber \| `access_issue` \| the door code is simulated/);
  assert.match(md, /\$1,100\.00/);
  const json = JSON.parse(summaryJson(a, meta));
  assert.equal(json.engine, "backtest-v1");
  assert.equal(json.totals.wentWrongCaught, 2);
  assert.equal(json.rows, undefined);
});

test("CLI: writes MD + JSON, --check passes on a fresh run and fails after drift; missing input -> exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "pbp-backtest-"));
  try {
    mkdirSync(join(dir, "data/backtest"), { recursive: true });
    copyFileSync(EXAMPLE, join(dir, "data/backtest/in.json"));
    const args = ["--input", "data/backtest/in.json", "--md", "out/BACKTEST.md", "--json", "out/summary.json"];
    const lines: string[] = [];
    assert.equal(main(args, dir, (s) => lines.push(s)), 0);
    assert.match(readFileSync(join(dir, "out/BACKTEST.md"), "utf8"), /^# Backtest/);
    assert.equal(JSON.parse(readFileSync(join(dir, "out/summary.json"), "utf8")).input.rows, 3);
    assert.equal(main([...args, "--check"], dir, (s) => lines.push(s)), 0);
    // Input changes -> published numbers are stale.
    const rows = JSON.parse(readFileSync(join(dir, "data/backtest/in.json"), "utf8"));
    rows[2].problems = ["overpriced", "no_show"];
    writeFileSync(join(dir, "data/backtest/in.json"), JSON.stringify(rows));
    assert.equal(main([...args, "--check"], dir, (s) => lines.push(s)), 1);
    assert.ok(lines.some((l) => l.includes("MISMATCH")));
    assert.equal(main(["--input", "data/backtest/missing.json"], dir, (s) => lines.push(s)), 2);
    // Absolute paths are honored (not joined under the root).
    const abs = join(dir, "abs-out");
    assert.equal(main(["--input", join(dir, "data/backtest/in.json"), "--md", join(abs, "B.md"), "--json", join(abs, "b.json")], join(dir, "elsewhere"), (s) => lines.push(s)), 0);
    assert.match(readFileSync(join(abs, "B.md"), "utf8"), /\| E01 \| electrician/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
