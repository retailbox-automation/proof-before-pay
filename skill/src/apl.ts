// APL documents + datasources for the Echo Show. The proofpay server already decides WHAT a card says
// (structuredContent.card, the same model its MCP Apps views render); here we only map it onto APL.
// Customer surface only: no tool names, ids or mode badges (SPEC §7.3) - sources are named in plain words.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apl");
export const APL_VERSION = "2024.3";
export const DOCS = ["pros", "payment", "status", "warranty", "card"] as const;
export type DocName = (typeof DOCS)[number];

const cache = new Map<DocName, unknown>();
export function aplDocument(name: DocName): any {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(APL_DIR, `${name}.json`), "utf8")));
  return cache.get(name);
}

/** Which APL document shows a tool result. Unknown views (a tool added later) fall back to the generic card. */
export function docFor(view: string | undefined, tool: string): DocName {
  if (view === "pros") return "pros";
  if (view === "payment" || tool === "prepare_checkout") return "payment";
  if (view === "status") return "status";
  if (view === "warranty" || tool === "warranty_callback") return "warranty";
  return "card";
}

type Row = { state?: string; label?: string; detail?: string; source?: string; action?: { label: string; message: string } };
type Card = { title?: string; subtitle?: string; hero?: { text: string }; rows?: Row[]; more?: { label: string; rows: Row[] }; fields?: { label: string; value: string }[]; note?: string; footer?: string; action?: { label: string; message: string } };

const MARK: Record<string, string> = { ok: "✓", bad: "✗", struck: "✗", pending: "…", info: "•" };
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdShort = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : usd(cents));
const escapeMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function row(r: Row) {
  return {
    state: r.state ?? "info",
    mark: MARK[r.state ?? "info"] ?? "•",
    label: r.label ?? "",
    detail: r.detail ?? "",
    source: r.source ?? "",
    action: r.action?.label ?? "",
    actionMessage: r.action?.message ?? "",
  };
}

function cardData(card: Card) {
  return {
    title: card.title ?? "Proof Before Pay",
    subtitle: card.subtitle ?? "",
    hero: card.hero?.text ?? "",
    rows: (card.rows ?? []).map(row),
    more: card.more?.label ?? "",
    fields: (card.fields ?? []).map((f) => ({ label: f.label, value: f.value })),
    note: card.note ?? "",
    noteHtml: card.note ? escapeMarkup(card.note).replace(/\n/g, "<br>") : "",
    footer: card.footer ?? "",
    action: card.action?.label ?? "",
    actionMessage: card.action?.message ?? "",
  };
}

/** Pre-checkout stacks (SPEC §7.1): proven rows pay now, everything not confirmed waits. Price breakdown is for the proven part only. */
function paymentData(card: Card, data: any) {
  const plan = data?.plan ?? data?.summary ?? null;
  const all = [...(card.rows ?? []), ...(card.more?.rows ?? [])];
  const payNow = typeof plan?.payNow === "number" ? plan.payNow : typeof data?.total === "number" ? data.total : null;
  const waits = typeof plan?.waits === "number" ? plan.waits : typeof data?.waits === "number" ? data.waits : null;
  const canPay = payNow !== null && payNow > 0 && !!card.action;
  return {
    payNow,
    waits,
    payNowText: payNow === null ? "-" : usd(payNow),
    waitsText: waits === null ? "-" : usd(waits),
    proven: all.filter((r) => r.state === "ok").map(row),
    waiting: all.filter((r) => r.state === "bad" || r.state === "pending").map(row),
    subtotalText: payNow === null ? "-" : usd(payNow),
    feesText: usd(0),
    totalText: payNow === null ? "-" : usd(payNow),
    canPay,
    payLabel: canPay ? `Pay ${usdShort(payNow!)}` : "",
  };
}

/** The datasource for one tool result: { card, payment? }. Bound in the documents as ${payload.card...}. */
export function datasourceFor(doc: DocName, structured: any): Record<string, unknown> {
  const card: Card = structured?.card ?? { title: "Proof Before Pay", rows: [] };
  const ds: Record<string, unknown> = { card: cardData(card) };
  if (doc === "payment") ds.payment = paymentData(card, structured?.data);
  return ds;
}

/** A card for answers that don't come from the server (step not available yet, errors). */
export function messageCard(title: string, line: string, state: "info" | "pending" | "bad" = "info"): Record<string, unknown> {
  return datasourceFor("card", { card: { title, rows: [{ state, label: line }], footer: "Sandbox demo" } });
}
