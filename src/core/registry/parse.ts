// Parser for the Florida DBPR license search results page (www.myfloridalicense.com/wl11.asp, mode=2).
// Pure: HTML string in, records out. Rows with the same license number are grouped into one
// LicenseRecord whose `names` lists every name row (Primary, DBA, ...) in page order.
import type { LicenseRecord } from "../types.ts";

export interface DbprPage {
  /** True when the page carries the "Search Results" block (found or empty). False = unexpected page. */
  isResultsPage: boolean;
  /** N from "Search Results - N Records"; null when the page prints no number (empty result). */
  declaredCount: number | null;
  /** Name rows in the results table (one per name, before grouping). */
  rowCount: number;
  /** Text after "Data Contained In Search Results Is Current As Of", e.g. "10/09/2026 11:30 PM". */
  asOf: string | null;
  /** The license number the page says it searched for (hidden field hLicNbr), when present. */
  echoedNumber: string | null;
  records: LicenseRecord[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Split a cell on <br> first ("EC99000101<br/>Cert Electrical"), then clean each part. */
function cellParts(html: string): string[] {
  return html.split(/<br\s*\/?>/i).map(cellText).filter((p) => p.length > 0);
}

// A results row: <tr ...> then five cells, the first with colspan=1. The cell body may not cross </td>,
// so address rows (one colspan=6 cell holding a nested table) never match.
const CELL = String.raw`<td[^>]*>((?:(?!<\/td>)[\s\S])*)<\/td>\s*`;
const ROW = new RegExp(String.raw`<tr[^>]*>\s*<td[^>]*colspan=['"]?1['"]?[^>]*>((?:(?!<\/td>)[\s\S])*)<\/td>\s*` + CELL.repeat(4), "gi");

export function inspectDbprPage(html: string): DbprPage {
  const isResultsPage = /Search\s+Results/i.test(html) && /Status\/Expires/i.test(html);
  const declared = /Search\s+Results\s*-\s*(\d+)\s*Records/i.exec(html);
  const asOfMatch = /Current\s+As\s+Of\s+([^<]*?)\.?\s*</i.exec(html);
  const asOf = asOfMatch ? cellText(asOfMatch[1]) || null : null;
  const echo = /<input[^>]*NAME=["']?hLicNbr["']?[^>]*VALUE=["']([^"']*)["']/i.exec(html);
  const echoedNumber = echo && echo[1].trim() ? echo[1].trim() : null;

  const records: LicenseRecord[] = [];
  const byKey = new Map<string, LicenseRecord>();
  let rowCount = 0;
  for (const m of html.matchAll(ROW)) {
    const [typeCell, nameCell, nameTypeCell, numberCell, statusCell] = m.slice(1, 6);
    const licenseType = cellText(typeCell);
    if (licenseType === "License Type") continue; // header row
    const [licenseNumber = ""] = cellParts(numberCell);
    if (!licenseNumber) continue;
    const [status = "", expires = null] = cellParts(statusCell);
    const name = cellText(nameCell);
    const nameType = cellText(nameTypeCell);
    rowCount++;
    const key = [licenseNumber, licenseType, status, expires ?? ""].join("|");
    let rec = byKey.get(key);
    if (!rec) {
      rec = { licenseNumber, licenseType, names: [], status, expires: expires && /^\d{2}\/\d{2}\/\d{4}$/.test(expires) ? expires : null };
      byKey.set(key, rec);
      records.push(rec);
    }
    rec.names.push({ name, nameType });
  }
  return { isResultsPage, declaredCount: declared ? Number(declared[1]) : null, rowCount, asOf, echoedNumber, records };
}

/** SPEC 3.2 signature. */
export function parseDbprResults(html: string): { asOf: string | null; records: LicenseRecord[] } {
  const { asOf, records } = inspectDbprPage(html);
  return { asOf, records };
}
