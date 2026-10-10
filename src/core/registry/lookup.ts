// Florida DBPR license lookup (SPEC 3.2). Modes:
//   fixture - recorded pages only (offline demo); a number without a fixture -> "unavailable", registry not queried
//   live    - the public search at www.myfloridalicense.com (3 HTTP calls, cookies kept, browser UA, 8 s per call)
//   auto    - fixture when the number has one, live otherwise
// Network error, timeout or an unexpected page -> verdict "unavailable" (never "verified").
// "not_found" needs a positive signal: the registry's own "no records found" text, or rows for other numbers only.
import type { LicenseCheck, LicenseRecord, Source, SourceMode } from "../types.ts";
import { inspectDbprPage } from "./parse.ts";
import { nameMatch } from "./names.ts";
import type { RegistryFixtures } from "./fixtures.ts";

export type RegistryMode = "fixture" | "live" | "auto";
export const DBPR_SERVICE = "Florida DBPR license search";
export const DBPR_ORIGIN = "https://www.myfloridalicense.com";
export const DBPR_URLS = {
  start: `${DBPR_ORIGIN}/wl11.asp?mode=0&SID=`,
  chooseType: `${DBPR_ORIGIN}/wl11.asp?mode=1&SID=&brd=&typ=`,
  search: `${DBPR_ORIGIN}/wl11.asp?mode=2&search=LicNbr&SID=&brd=&typ=`,
} as const;
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const DEFAULT_TIMEOUT_MS = 8_000;

export interface LookupOptions {
  mode: RegistryMode;
  fixtures: RegistryFixtures;
  fetchImpl?: typeof fetch;
  /** Check time (epoch ms) or a clock. Used for expiry and for asOf when the page prints none. */
  now?: number | (() => number);
  /** Per HTTP call. Default 8000. */
  timeoutMs?: number;
}

export interface LookupDiagnostics {
  check: LicenseCheck;
  /** Wall time of the lookup, for tool step chips. */
  ms: number;
  /** Why the verdict is "unavailable", when it is. */
  error: string | null;
}

/** "ec 9900-0101" -> "EC99000101"; null when it can't be a Florida license number. */
export function normalizeLicenseNumber(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z]{0,5}\d{2,12}$/.test(s) ? s : null;
}

/** "Current, Active" -> true; "Current, Inactive" / "Null and Void" -> false. */
export function isActiveStatus(status: string): boolean {
  return status.split(",").some((p) => p.trim().toLowerCase() === "active");
}

/** Expired once the expiration date has fully passed in Florida (05:00Z the next day covers EST and EDT). */
export function isExpired(expires: string | null, nowMs: number): boolean {
  if (!expires) return false;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(expires);
  if (!m) return false;
  const end = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]) + 1, 5);
  return nowMs >= end;
}

const NO_RECORDS = /no\s+records\s+found\s+matching\s+the\s+search\s+criteria/i;

export function evaluateDbprPage(number: string, claimedName: string, html: string, source: Omit<Source, "asOf">, nowMs: number): { check: LicenseCheck; error: string | null } {
  const page = inspectDbprPage(html);
  const checkedAt = new Date(nowMs).toISOString();
  const base = { query: number, claimedName };
  const unavailable = (error: string) => ({
    check: { ...base, found: false, records: [], active: false, nameMatch: "n/a" as const, verdict: "unavailable" as const, source: { ...source, asOf: page.asOf ?? checkedAt } },
    error,
  });
  if (!page.isResultsPage) return unavailable("unexpected page: no search results block");
  // Live answers must be about the number we asked for (the page echoes it in a hidden field).
  if (source.mode === "live" && page.echoedNumber !== null && normalizeLicenseNumber(page.echoedNumber) !== number) {
    return unavailable(`registry answered for ${page.echoedNumber}, not ${number}`);
  }
  if ((page.declaredCount ?? 0) > 0 && page.rowCount === 0) return unavailable(`page declares ${page.declaredCount} records but no rows were parsed`);
  if (page.rowCount === 0 && !NO_RECORDS.test(html)) return unavailable("empty results without the registry's no-records message");

  const records: LicenseRecord[] = page.records.filter((r) => normalizeLicenseNumber(r.licenseNumber) === number);
  const found = records.length > 0;
  const active = found && records.some((r) => isActiveStatus(r.status) && !isExpired(r.expires, nowMs));
  const nm = found ? nameMatch(claimedName, records.flatMap((r) => r.names.map((n) => n.name))) : "n/a";
  const verdict: LicenseCheck["verdict"] = !found ? "not_found" : !active ? "inactive" : nm === "mismatch" ? "name_mismatch" : "verified";
  return { check: { ...base, found, records, active, nameMatch: nm, verdict, source: { ...source, asOf: page.asOf ?? checkedAt } }, error: null };
}

// One live lookup at a time (be gentle with a public registry).
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function setCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

async function fetchLivePage(number: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  const jar = new Map<string, string>();
  let referer: string | undefined;
  const call = async (url: string, body?: string): Promise<string> => {
    const headers: Record<string, string> = { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (referer) headers.Referer = referer;
    if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", headers, body, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    for (const c of setCookies(res.headers)) {
      const pair = c.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    referer = url;
    return text;
  };
  await call(DBPR_URLS.start);
  await call(DBPR_URLS.chooseType, "hSearchType=&SearchType=LicNbr&SelectSearchType=Search");
  const form = new URLSearchParams({
    hSearchType: "LicNbr", hDivision: "ALL", LicNbr: number, Board: "", LicenseType: "", SpecQual: "", RecsPerPage: "10", Search1: "Search",
  });
  return call(DBPR_URLS.search, form.toString());
}

export async function lookupLicenseWithDiagnostics(numberInput: string, claimedName: string, opts: LookupOptions): Promise<LookupDiagnostics> {
  const number = normalizeLicenseNumber(numberInput);
  if (!number) throw new RangeError(`not a license number: ${JSON.stringify(numberInput)}`);
  const nowMs = typeof opts.now === "function" ? opts.now() : opts.now ?? Date.now();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const fixture = opts.fixtures[number];

  if (opts.mode === "fixture" || (opts.mode === "auto" && fixture)) {
    const mode: SourceMode = "fixture";
    if (!fixture) {
      const check: LicenseCheck = {
        query: number, claimedName, found: false, records: [], active: false, nameMatch: "n/a", verdict: "unavailable",
        source: { service: DBPR_SERVICE, mode, ref: "no fixture for this number; registry not queried", asOf: new Date(nowMs).toISOString() },
      };
      return { check, ms: elapsed(), error: "no fixture for this number (fixture mode)" };
    }
    const r = evaluateDbprPage(number, claimedName, fixture.html, { service: DBPR_SERVICE, mode, ref: fixture.file }, nowMs);
    return { ...r, ms: elapsed() };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = { service: DBPR_SERVICE, mode: "live" as const, ref: DBPR_URLS.search };
  try {
    const html = await serialized(() => fetchLivePage(number, fetchImpl, timeoutMs));
    const r = evaluateDbprPage(number, claimedName, html, source, nowMs);
    return { ...r, ms: elapsed() };
  } catch (err) {
    const check: LicenseCheck = {
      query: number, claimedName, found: false, records: [], active: false, nameMatch: "n/a", verdict: "unavailable",
      source: { ...source, asOf: new Date(nowMs).toISOString() },
    };
    return { check, ms: elapsed(), error: err instanceof Error ? err.message : String(err) };
  }
}

/** SPEC 3.2 signature. */
export async function lookupLicense(number: string, claimedName: string, opts: LookupOptions): Promise<LicenseCheck> {
  return (await lookupLicenseWithDiagnostics(number, claimedName, opts)).check;
}
