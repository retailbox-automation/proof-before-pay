import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDbprPage, parseDbprResults, decodeEntities } from "./parse.ts";
import { nameMatch, nameTokens } from "./names.ts";
import { loadRegistryFixtures, REGISTRY_FIXTURE_FILES } from "./fixtures.ts";
import { DBPR_URLS, BROWSER_UA, isActiveStatus, isExpired, lookupLicense, lookupLicenseWithDiagnostics, normalizeLicenseNumber } from "./lookup.ts";

const fixtures = loadRegistryFixtures();
const CHECK_TIME = Date.parse("2026-10-15T18:15:00Z");

// ---------- parse ----------
test("parse: found page -> one grouped record with DBA + Primary names, status, expiry, asOf", () => {
  const page = inspectDbprPage(fixtures.EC99000101.html);
  assert.equal(page.isResultsPage, true);
  assert.equal(page.declaredCount, 2);
  assert.equal(page.rowCount, 2);
  assert.equal(page.echoedNumber, "EC99000101");
  const { asOf, records } = parseDbprResults(fixtures.EC99000101.html);
  assert.equal(asOf, "10/09/2026 11:30 PM");
  assert.deepEqual(records, [
    {
      licenseNumber: "EC99000101",
      licenseType: "Certified Electrical Contractor",
      names: [
        { name: "BRIGHT CURRENT ELECTRIC, LLC", nameType: "DBA" },
        { name: "SAMPLE, ALEX J", nameType: "Primary" },
      ],
      status: "Current, Active",
      expires: "08/31/2028",
    },
  ]);
});

test("parse: second found page (derived fixture) -> HARBOR LINE ELECTRICAL INC, EC99000102", () => {
  const { records } = parseDbprResults(fixtures.EC99000102.html);
  assert.equal(records.length, 1);
  assert.equal(records[0].licenseNumber, "EC99000102");
  assert.equal(records[0].names[0].name, "HARBOR LINE ELECTRICAL INC");
  assert.equal(records[0].status, "Current, Active");
});

test("parse: not-found page -> results page, no records, no asOf, no declared count", () => {
  const page = inspectDbprPage(fixtures.EC99000103.html);
  assert.equal(page.isResultsPage, true);
  assert.equal(page.declaredCount, null);
  assert.equal(page.rowCount, 0);
  assert.deepEqual(parseDbprResults(fixtures.EC99000103.html), { asOf: null, records: [] });
});

test("parse: unrelated HTML is not a results page; entities decode", () => {
  assert.equal(inspectDbprPage("<html><body>Service Unavailable</body></html>").isResultsPage, false);
  assert.equal(decodeEntities("A &amp; B&nbsp;&#39;C&#x27;"), "A & B 'C'");
});

test("fixture map covers the three demo pros", () => {
  assert.deepEqual(Object.keys(REGISTRY_FIXTURE_FILES).sort(), ["EC99000101", "EC99000102", "EC99000103"]);
});

// ---------- names ----------
test("nameMatch: entity words and punctuation ignored; & -> AND; Jaccard >= 0.5 partial", () => {
  assert.deepEqual(nameTokens("Bright Current Electric, LLC"), ["BRIGHT", "CURRENT", "ELECTRIC"]);
  assert.deepEqual(nameTokens("Smith & Sons Services Co."), ["SMITH", "AND", "SONS"]);
  assert.equal(nameMatch("Bright Current Electric", ["BRIGHT CURRENT ELECTRIC, LLC", "SAMPLE, ALEX J"]), "match");
  assert.equal(nameMatch("Harbor Line Electrical", ["HARBOR LINE ELECTRICAL INC"]), "match");
  assert.equal(nameMatch("Smith and Sons", ["SMITH & SONS SERVICES CO"]), "match");
  assert.equal(nameMatch("Bright Current", ["BRIGHT CURRENT ELECTRIC, LLC"]), "partial"); // 2/3
  assert.equal(nameMatch("Bright Spark Electric", ["BRIGHT CURRENT ELECTRIC, LLC"]), "partial"); // 2/4 = 0.5
  assert.equal(nameMatch("Quick Volt Pros", ["BRIGHT CURRENT ELECTRIC, LLC"]), "mismatch");
  assert.equal(nameMatch("LLC", ["BRIGHT CURRENT ELECTRIC, LLC"]), "mismatch");
  assert.equal(nameMatch("Bright Current Electric", []), "mismatch");
});

// ---------- lookup: fixture / auto ----------
test("lookup fixture: P1 verified with registry asOf and fixture ref; P3 not found; unknown -> unavailable", async () => {
  const p1 = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "fixture", fixtures, now: CHECK_TIME });
  assert.equal(p1.verdict, "verified");
  assert.equal(p1.found, true);
  assert.equal(p1.active, true);
  assert.equal(p1.nameMatch, "match");
  assert.deepEqual(p1.source, { service: "Florida DBPR license search", mode: "fixture", ref: "fixtures/registry/dbpr-found.sample.html", asOf: "10/09/2026 11:30 PM" });

  const p2 = await lookupLicense("ec 9900 0102", "Harbor Line Electrical", { mode: "fixture", fixtures, now: CHECK_TIME });
  assert.equal(p2.query, "EC99000102");
  assert.equal(p2.verdict, "verified");

  const p3 = await lookupLicense("EC99000103", "Quick Volt Pros", { mode: "fixture", fixtures, now: CHECK_TIME });
  assert.equal(p3.verdict, "not_found");
  assert.equal(p3.found, false);
  assert.equal(p3.nameMatch, "n/a");
  assert.equal(p3.source.asOf, "2026-10-15T18:15:00.000Z"); // no "current as of" on empty pages -> check time

  const unknown = await lookupLicenseWithDiagnostics("EC12345678", "Anyone", { mode: "fixture", fixtures, now: CHECK_TIME });
  assert.equal(unknown.check.verdict, "unavailable");
  assert.match(unknown.error ?? "", /no fixture/);
});

test("lookup: expired, inactive and wrong-name records are never verified", async () => {
  const late = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "fixture", fixtures, now: Date.parse("2028-09-01T05:00:00Z") });
  assert.equal(late.verdict, "inactive");
  const lastDay = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "fixture", fixtures, now: Date.parse("2028-08-31T20:00:00Z") });
  assert.equal(lastDay.verdict, "verified");
  const wrongName = await lookupLicense("EC99000101", "Quick Volt Pros", { mode: "fixture", fixtures, now: CHECK_TIME });
  assert.equal(wrongName.verdict, "name_mismatch");
  assert.equal(wrongName.nameMatch, "mismatch");
  const inactiveHtml = fixtures.EC99000101.html.replaceAll("Current, Active", "Current, Inactive");
  const inactive = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "fixture", fixtures: { EC99000101: { file: "x", html: inactiveHtml } }, now: CHECK_TIME });
  assert.equal(inactive.verdict, "inactive");
  assert.equal(isActiveStatus("Current, Active"), true);
  assert.equal(isActiveStatus("Current, Inactive"), false);
  assert.equal(isActiveStatus("Null and Void"), false);
  assert.equal(isExpired(null, CHECK_TIME), false);
  assert.equal(normalizeLicenseNumber("<script>"), null);
  await assert.rejects(lookupLicense("drop table", "x", { mode: "live", fixtures, fetchImpl: () => { throw new Error("must not fetch"); } }), RangeError);
});

// ---------- lookup: live flow with an injected fetch ----------
type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function fakeFetch(pages: Array<string | Response | Error>, calls: Call[], delayMs = 0): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const next = pages[i++];
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response(next ?? "", { status: 200, headers: i === 1 ? { "set-cookie": "ASPSESSIONIDQS=abc123; path=/" } : {} });
  }) as typeof fetch;
}

test("lookup live (injected fetch): 3 calls in order, form bodies, cookies kept, browser UA, result parsed", async () => {
  const calls: Call[] = [];
  const fetchImpl = fakeFetch(["<html>search form</html>", "<html>by number</html>", fixtures.EC99000101.html], calls);
  const r = await lookupLicenseWithDiagnostics("EC99000101", "Bright Current Electric", { mode: "live", fixtures: {}, fetchImpl, now: CHECK_TIME });
  assert.equal(r.error, null);
  assert.equal(r.check.verdict, "verified");
  assert.deepEqual(r.check.source, { service: "Florida DBPR license search", mode: "live", ref: DBPR_URLS.search, asOf: "10/09/2026 11:30 PM" });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["GET", "https://www.myfloridalicense.com/wl11.asp?mode=0&SID="],
    ["POST", "https://www.myfloridalicense.com/wl11.asp?mode=1&SID=&brd=&typ="],
    ["POST", "https://www.myfloridalicense.com/wl11.asp?mode=2&search=LicNbr&SID=&brd=&typ="],
  ]);
  assert.equal(calls[1].body, "hSearchType=&SearchType=LicNbr&SelectSearchType=Search");
  assert.equal(calls[2].body, "hSearchType=LicNbr&hDivision=ALL&LicNbr=EC99000101&Board=&LicenseType=&SpecQual=&RecsPerPage=10&Search1=Search");
  assert.ok(calls.every((c) => c.headers["User-Agent"] === BROWSER_UA));
  assert.equal(calls[0].headers.Cookie, undefined);
  assert.equal(calls[1].headers.Cookie, "ASPSESSIONIDQS=abc123");
  assert.equal(calls[2].headers.Cookie, "ASPSESSIONIDQS=abc123");
  assert.equal(calls[2].headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("lookup auto: fixture for known numbers (no network), live for others", async () => {
  const calls: Call[] = [];
  const notFoundFor = (n: string) => fixtures.EC99000103.html.replace(/NAME="hLicNbr" VALUE="[^"]*"/, `NAME="hLicNbr" VALUE="${n}"`);
  const fetchImpl = fakeFetch(["a", "b", notFoundFor("CGC1500001")], calls);
  const known = await lookupLicense("EC99000101", "Bright Current Electric", { mode: "auto", fixtures, fetchImpl, now: CHECK_TIME });
  assert.equal(known.source.mode, "fixture");
  assert.equal(calls.length, 0);
  const other = await lookupLicense("CGC1500001", "Some Builder", { mode: "auto", fixtures, fetchImpl, now: CHECK_TIME });
  assert.equal(other.source.mode, "live");
  assert.equal(other.verdict, "not_found");
  assert.equal(calls.length, 3);
});

test("lookup live failures -> unavailable, never verified", async () => {
  const cases: Array<[string, Array<string | Response | Error>]> = [
    ["network error", [new TypeError("fetch failed")]],
    ["HTTP 503", ["ok", new Response("busy", { status: 503 })]],
    ["unexpected page", ["a", "b", "<html><body>Please try again later</body></html>"]],
    ["rows declared but unparseable", ["a", "b", fixtures.EC99000101.html.replace(/<tr height='40'>/g, "<div>")]],
    ["live page echoes a different number", ["a", "b", fixtures.EC99000101.html.replace('NAME="hLicNbr" VALUE="EC99000101"', 'NAME="hLicNbr" VALUE="EC55555555"')]],
    ["empty table without the registry's no-records text", ["a", "b", fixtures.EC99000103.html.replace(/There were no records found matching the search criteria\./, "")]],
  ];
  for (const [name, pages] of cases) {
    const r = await lookupLicenseWithDiagnostics("EC99000101", "Bright Current Electric", { mode: "live", fixtures: {}, fetchImpl: fakeFetch(pages, []), now: CHECK_TIME });
    assert.equal(r.check.verdict, "unavailable", name);
    assert.equal(r.check.found, false, name);
    assert.ok(r.error, name);
    assert.equal(r.check.source.mode, "live", name);
  }
});

test("lookup live: per-call timeout -> unavailable", async () => {
  const hang = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const r = await lookupLicenseWithDiagnostics("EC99000101", "x", { mode: "live", fixtures: {}, fetchImpl: hang, timeoutMs: 50, now: CHECK_TIME });
  assert.equal(r.check.verdict, "unavailable");
  assert.match(r.error ?? "", /timeout|abort/i);
});

test("lookup live: one lookup at a time", async () => {
  const calls: Call[] = [];
  const pagesA = ["a", "b", fixtures.EC99000103.html];
  let n = 0;
  const log: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const id = n++;
    log.push(`start ${id}`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`end ${id}`);
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: {}, body: undefined });
    return new Response(pagesA[id % 3]);
  }) as typeof fetch;
  await Promise.all([
    lookupLicense("EC11111111", "x", { mode: "live", fixtures: {}, fetchImpl, now: CHECK_TIME }),
    lookupLicense("EC22222222", "y", { mode: "live", fixtures: {}, fetchImpl, now: CHECK_TIME }),
  ]);
  // Calls never overlap: every start is followed by its own end.
  for (let i = 0; i < log.length; i += 2) assert.deepEqual([log[i], log[i + 1]], [`start ${i / 2}`, `end ${i / 2}`]);
  assert.equal(calls.length, 6);
});
