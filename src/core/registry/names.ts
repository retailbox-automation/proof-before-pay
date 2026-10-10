// Deterministic business-name comparison: marketplace name vs registry names (SPEC 3.2).
// Uppercase, "&" -> AND, strip punctuation, drop entity words; equal -> match; token Jaccard >= 0.5 -> partial.

export type NameMatch = "match" | "partial" | "mismatch";

const ENTITY_WORDS = new Set(["LLC", "INC", "CORP", "CO", "COMPANY", "SERVICES", "SERVICE", "GROUP"]);
export const PARTIAL_NAME_THRESHOLD = 0.5;

export function nameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ENTITY_WORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Best result over all registry names: match beats partial beats mismatch. */
export function nameMatch(claimed: string, names: readonly string[]): NameMatch {
  const c = nameTokens(claimed);
  if (c.length === 0) return "mismatch";
  let best: NameMatch = "mismatch";
  for (const n of names) {
    const t = nameTokens(n);
    if (t.length > 0 && t.join(" ") === c.join(" ")) return "match";
    if (jaccard(c, t) >= PARTIAL_NAME_THRESHOLD) best = "partial";
  }
  return best;
}
