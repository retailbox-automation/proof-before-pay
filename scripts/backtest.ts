// Backtest (SPEC 3.5): which real contractor failures would the four gates have caught?
// Input: data/backtest/engagements.anon.json, an anonymized ledger (no names, phones, addresses, license numbers).
// Output: docs/BACKTEST.md + docs/backtest-summary.json. Deterministic, no model.
//
//   node scripts/backtest.ts [--input <file>] [--md <file>] [--json <file>] [--check]
//   --check  recompute and compare with the published files; exit 1 when they differ (used by npm run verify)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULTS = {
  input: "data/backtest/engagements.anon.json",
  md: "docs/BACKTEST.md",
  json: "docs/backtest-summary.json",
} as const;

export const PROBLEMS = [
  "no_license", "license_mismatch", "bbb_rating_f", "scope_creep_or_upsell", "invoice_line_not_in_scope", "overpriced",
  "no_show", "late_or_missed_window", "work_incomplete", "work_defective", "refund_refused", "slow_or_phone_only_comm",
  "missing_materials", "access_issue", "billed_unverified_quantity", "claimed_done_before_proof", "paid_before_proof", "other",
] as const;
export type Problem = (typeof PROBLEMS)[number];

// ---------- input schema ----------
// Strict: unknown fields are rejected, so free-text notes (a common place for names and phones) can't slip in.
const text = z.string().trim().min(1).max(80);
export const engagementSchema = z.strictObject({
  id: z.string().regex(/^E\d{2,}$/, "ids look like E01, E02, ..."),
  trade: text,
  category: text,
  hired: z.boolean(),
  stage_reached: text,
  outcome: text,
  problems: z.array(z.enum(PROBLEMS)),
  went_wrong: z.boolean(),
  caught_prehire: z.boolean(),
  amount_quoted_usd: z.number().nonnegative().nullable(),
  amount_paid_usd: z.number().nonnegative().nullable(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  vendor: z.string().regex(/^V\d{3}$/, "anonymized vendor key, e.g. V007").optional(), // same key = same company
  since_closing: z.boolean().optional(), // first contact after the house closed
});
export type Engagement = z.infer<typeof engagementSchema>;

const PII_PATTERNS: Array<[string, RegExp]> = [
  ["email address", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ["phone number", /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/],
  ["license number", /\b[A-Z]{2,4}\d{5,}\b/i],
  ["street address", /\b\d{2,6}\s+[A-Za-z]+(?:\s+[A-Za-z]+)*\s+(?:st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|court)\b/i],
];

export function parseLedger(json: unknown): Engagement[] {
  const rows = z.array(engagementSchema).min(1).parse(json);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate id ${r.id}`);
    seen.add(r.id);
    for (const field of ["trade", "category", "stage_reached", "outcome"] as const) {
      for (const [what, re] of PII_PATTERNS) {
        if (re.test(r[field])) throw new Error(`${r.id}.${field} looks like it contains a ${what}; the ledger must be anonymized`);
      }
    }
    if (new Set(r.problems).size !== r.problems.length) throw new Error(`${r.id}: duplicate problem tags`);
  }
  return rows;
}

// ---------- gates ----------
export type GateId = "license" | "scope" | "visit" | "proof";
export const GATES: ReadonlyArray<{ id: GateId; title: string; how: string; catches: readonly Problem[] }> = [
  { id: "license", title: "License gate", how: "drops pros whose license is not active in the state registry under their business name", catches: ["no_license", "license_mismatch"] },
  { id: "scope", title: "Scope gate", how: "writes the scope item by item; invoice lines outside it, above it, or with unverified quantities wait", catches: ["scope_creep_or_upsell", "invoice_line_not_in_scope", "billed_unverified_quantity"] },
  { id: "visit", title: "Visit gate", how: "the front door camera logs arrival and departure against the booking window (pro's consent)", catches: ["no_show", "late_or_missed_window"] },
  { id: "proof", title: "Proof-before-payment gate", how: "pays only items proven by a photo taken during the visit; the rest waits for the homeowner", catches: ["work_incomplete", "work_defective", "claimed_done_before_proof", "paid_before_proof"] },
];

export const NOT_CAUGHT_REASONS: Readonly<Partial<Record<Problem, string>>> = {
  overpriced: "price level is the homeowner's call; the gates check license, scope, visit and proof, not market price",
  slow_or_phone_only_comm: "communication speed and channel are outside the gates",
  missing_materials: "a materials shortage is not visible to the gates (an unfinished item it causes is caught as work_incomplete)",
  bbb_rating_f: "reputation ratings are not a gate in v1; only the license registry is checked",
  other: "not classified; reviewed by hand",
  access_issue: "the door code is simulated (the Ring Partner API has no lock control), so access problems are not solved",
  refund_refused: "a refund dispute after a proven payment is outside the gates",
};

export interface Verdict { problem: Problem; gate: GateId | null; reason: string }

/** Which gate catches one problem on one engagement. */
export function classify(problem: Problem, row: Engagement): Verdict {
  if (problem === "refund_refused") {
    return row.problems.includes("paid_before_proof")
      ? { problem, gate: "proof", reason: "paid before proof; with the gate nothing unproven is paid, so no refund is needed" }
      : { problem, gate: null, reason: NOT_CAUGHT_REASONS.refund_refused! };
  }
  const gate = GATES.find((g) => g.catches.includes(problem));
  if (gate) return { problem, gate: gate.id, reason: gate.how };
  return { problem, gate: null, reason: NOT_CAUGHT_REASONS[problem] ?? "no gate covers this problem" };
}

// ---------- run ----------
export interface BacktestResult {
  totals: { engagements: number; hired: number; wentWrong: number; wentWrongCaught: number; wentWrongFullyCaught: number; wentWrongNotCaught: number };
  window: null | { companiesSinceClosing: number | null; engagementsSinceClosing: number; hiredSinceClosing: number; wentWrongSinceClosing: number; wentWrongCaughtSinceClosing: number };
  prehire: { licenseCaught: number; ids: string[] };
  gates: Array<{ id: GateId; title: string; catches: readonly Problem[]; engagementsCaught: number; alreadyCaughtPrehire: number; problemsCaught: number; amountPaidUsdOnCaught: number; ids: string[] }>;
  notCaught: Array<{ id: string; trade: string; problem: Problem; reason: string }>;
  problemCounts: Array<{ problem: Problem; count: number; gate: GateId | null }>;
  rows: Array<{ id: string; trade: string; month: string; wentWrong: boolean; caughtPrehire: boolean; verdicts: Verdict[] }>;
}

const byId = (a: { id: string }, b: { id: string }) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function runBacktest(input: Engagement[]): BacktestResult {
  const rows = [...input].sort(byId).map((r) => ({ row: r, verdicts: r.problems.map((p) => classify(p, r)) }));
  const wrong = rows.filter((x) => x.row.went_wrong);
  const caughtAny = (v: Verdict[]) => v.some((x) => x.gate !== null);
  const caughtAll = (v: Verdict[]) => v.length > 0 && v.every((x) => x.gate !== null);
  const gates = GATES.map((g) => {
    const hit = wrong.filter((x) => x.verdicts.some((v) => v.gate === g.id));
    return {
      id: g.id,
      title: g.title,
      catches: g.catches,
      engagementsCaught: hit.length,
      alreadyCaughtPrehire: hit.filter((x) => x.row.caught_prehire).length,
      problemsCaught: hit.reduce((s, x) => s + x.verdicts.filter((v) => v.gate === g.id).length, 0),
      amountPaidUsdOnCaught: round2(hit.reduce((s, x) => s + (x.row.amount_paid_usd ?? 0), 0)),
      ids: hit.map((x) => x.row.id),
    };
  });
  const counts = new Map<Problem, number>();
  for (const x of wrong) for (const v of x.verdicts) counts.set(v.problem, (counts.get(v.problem) ?? 0) + 1);
  const hasWindow = input.some((r) => r.since_closing !== undefined);
  const since = rows.filter((x) => x.row.since_closing === true);
  const vendors = since.map((x) => x.row.vendor).filter((v): v is string => !!v);
  const licensePre = rows.filter((x) => !x.row.hired && x.row.caught_prehire && x.row.problems.some((p) => p === "no_license" || p === "license_mismatch"));
  return {
    window: hasWindow ? {
      companiesSinceClosing: vendors.length === since.length && since.length > 0 ? new Set(vendors).size : null,
      engagementsSinceClosing: since.length,
      hiredSinceClosing: since.filter((x) => x.row.hired).length,
      wentWrongSinceClosing: since.filter((x) => x.row.went_wrong).length,
      wentWrongCaughtSinceClosing: since.filter((x) => x.row.went_wrong && caughtAny(x.verdicts)).length,
    } : null,
    prehire: { licenseCaught: licensePre.length, ids: licensePre.map((x) => x.row.id) },
    totals: {
      engagements: rows.length,
      hired: rows.filter((x) => x.row.hired).length,
      wentWrong: wrong.length,
      wentWrongCaught: wrong.filter((x) => caughtAny(x.verdicts)).length,
      wentWrongFullyCaught: wrong.filter((x) => caughtAll(x.verdicts)).length,
      wentWrongNotCaught: wrong.filter((x) => !caughtAny(x.verdicts)).length,
    },
    gates,
    notCaught: wrong.flatMap((x) => x.verdicts.filter((v) => v.gate === null).map((v) => ({ id: x.row.id, trade: x.row.trade, problem: v.problem, reason: v.reason }))),
    problemCounts: PROBLEMS.filter((p) => counts.has(p)).map((p) => ({ problem: p, count: counts.get(p)!, gate: wrong.flatMap((x) => x.verdicts).find((v) => v.problem === p)!.gate })),
    rows: rows.map((x) => ({ id: x.row.id, trade: x.row.trade, month: x.row.month, wentWrong: x.row.went_wrong, caughtPrehire: x.row.caught_prehire, verdicts: x.verdicts })),
  };
}

// ---------- output ----------
export interface InputMeta { file: string; sha256: string; rows: number }

export function summaryJson(result: BacktestResult, meta: InputMeta): string {
  const { rows: _rows, ...summary } = result;
  return JSON.stringify({ engine: "backtest-v1", input: meta, ...summary }, null, 2) + "\n";
}

const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`);
const usd = (n: number) => {
  const [whole, frac] = n.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

export function renderMarkdown(result: BacktestResult, meta: InputMeta): string {
  const t = result.totals;
  const out: string[] = [];
  out.push("# Backtest: Proof Before Pay gates vs real contractor history");
  out.push("");
  out.push(`Generated by \`scripts/backtest.ts\` (deterministic rules, no model). Do not edit by hand; \`npm run verify\` fails when these numbers drift from the input.`);
  out.push(`Input: \`${meta.file}\` (${meta.rows} anonymized engagements, sha256 \`${meta.sha256.slice(0, 16)}…\`). No names, phones, addresses or license numbers.`);
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push("| Engagements | Hired | Went wrong | Went wrong, caught by at least one gate | Went wrong, every problem caught | Went wrong, nothing caught |");
  out.push("|---:|---:|---:|---:|---:|---:|");
  out.push(`| ${t.engagements} | ${t.hired} | ${t.wentWrong} | ${t.wentWrongCaught} (${pct(t.wentWrongCaught, t.wentWrong)}) | ${t.wentWrongFullyCaught} (${pct(t.wentWrongFullyCaught, t.wentWrong)}) | ${t.wentWrongNotCaught} (${pct(t.wentWrongNotCaught, t.wentWrong)}) |`);
  out.push("");
  if (result.window) {
    const w = result.window;
    out.push("## Since the house closed");
    out.push("");
    out.push("| Companies in touch (reached out to or heard from) | Engagements (company × job) | Jobs booked or paid | Went wrong | Went wrong, caught by at least one gate |");
    out.push("|---:|---:|---:|---:|---:|");
    out.push(`| ${w.companiesSinceClosing ?? "n/a"} | ${w.engagementsSinceClosing} | ${w.hiredSinceClosing} | ${w.wentWrongSinceClosing} | ${w.wentWrongCaughtSinceClosing} (${pct(w.wentWrongCaughtSinceClosing, w.wentWrongSinceClosing)}) |`);
    out.push("");
  }
  out.push("## Before hiring");
  out.push("");
  out.push(`The homeowner already ruled out ${result.prehire.licenseCaught} pro(s) because no active license was found in the state registry (${result.prehire.ids.join(", ") || "none"}). The license gate does this check automatically for every pro it offers.`);
  out.push("");
  out.push("## Per gate");
  out.push("");
  out.push("| Gate | What it does | Problem tags it catches | Went-wrong engagements caught | Of them, already caught by the homeowner before hiring | Paid on those engagements (upper bound of what would have waited) |");
  out.push("|---|---|---|---:|---:|---:|");
  for (const g of result.gates) {
    const def = GATES.find((x) => x.id === g.id)!;
    const tags = g.catches.map((c) => `\`${c}\``).join(", ") + (g.id === "proof" ? ", `refund_refused` when paid before proof" : "");
    out.push(`| ${g.title} | ${def.how} | ${tags} | ${g.engagementsCaught} | ${g.alreadyCaughtPrehire} | ${usd(g.amountPaidUsdOnCaught)} |`);
  }
  for (const g of result.gates) {
    out.push("");
    out.push(`### ${g.title}`);
    out.push("");
    if (g.ids.length === 0) { out.push("No went-wrong engagement in the ledger is caught by this gate."); continue; }
    out.push("| Engagement | Trade | Month | Problems this gate catches |");
    out.push("|---|---|---|---|");
    for (const id of g.ids) {
      const r = result.rows.find((x) => x.id === id)!;
      out.push(`| ${r.id} | ${r.trade} | ${r.month} | ${r.verdicts.filter((v) => v.gate === g.id).map((v) => `\`${v.problem}\``).join(", ")} |`);
    }
  }
  out.push("");
  out.push("## Not caught");
  out.push("");
  if (result.notCaught.length === 0) out.push("Every problem on a went-wrong engagement is caught by some gate.");
  else {
    out.push("| Engagement | Trade | Problem | Why no gate catches it |");
    out.push("|---|---|---|---|");
    for (const n of result.notCaught) out.push(`| ${n.id} | ${n.trade} | \`${n.problem}\` | ${n.reason} |`);
  }
  out.push("");
  out.push("## Problem tags on went-wrong engagements");
  out.push("");
  out.push("| Problem | Count | Caught by |");
  out.push("|---|---:|---|");
  const sorted = [...result.problemCounts].sort((a, b) => b.count - a.count || PROBLEMS.indexOf(a.problem) - PROBLEMS.indexOf(b.problem));
  for (const p of sorted) out.push(`| \`${p.problem}\` | ${p.count} | ${p.gate ? GATES.find((g) => g.id === p.gate)!.title : "not caught"} |`);
  out.push("");
  return out.join("\n");
}

// ---------- CLI ----------
function argValue(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** Returns the process exit code. */
export function main(argv: string[], root: string = APP_ROOT, log: (s: string) => void = console.log): number {
  const inputPath = resolve(root, argValue(argv, "--input", DEFAULTS.input));
  const mdPath = resolve(root, argValue(argv, "--md", DEFAULTS.md));
  const jsonPath = resolve(root, argValue(argv, "--json", DEFAULTS.json));
  if (!existsSync(inputPath)) {
    log(`backtest: input ${relative(root, inputPath)} not found (the anonymized ledger is supplied separately; see data/backtest/engagements.example.json for the format)`);
    return 2;
  }
  const raw = readFileSync(inputPath);
  const rows = parseLedger(JSON.parse(raw.toString("utf8")));
  const meta: InputMeta = { file: relative(root, inputPath).split("\\").join("/"), sha256: createHash("sha256").update(raw).digest("hex"), rows: rows.length };
  const result = runBacktest(rows);
  const md = renderMarkdown(result, meta);
  const json = summaryJson(result, meta);
  const t = result.totals;
  log(`backtest: ${t.engagements} engagements, ${t.wentWrong} went wrong, ${t.wentWrongCaught} caught by at least one gate, ${t.wentWrongNotCaught} not caught`);
  if (argv.includes("--check")) {
    const same = existsSync(mdPath) && existsSync(jsonPath) && readFileSync(mdPath, "utf8") === md && readFileSync(jsonPath, "utf8") === json;
    log(same ? "backtest --check: published numbers match the input" : `backtest --check: MISMATCH between ${relative(root, mdPath)} / ${relative(root, jsonPath)} and a fresh run`);
    return same ? 0 : 1;
  }
  mkdirSync(dirname(mdPath), { recursive: true });
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, json);
  log(`backtest: wrote ${relative(root, mdPath)} and ${relative(root, jsonPath)}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
