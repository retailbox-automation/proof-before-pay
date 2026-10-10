// Opt-in live check against the public Florida DBPR search. Run: LIVE=1 node --test src/core/registry/lookup.live.test.ts
// EC99000103 is the fictional "Quick Volt Pros" number; the registry must answer "no records".
// Nothing from the live response is written to disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupLicenseWithDiagnostics } from "./lookup.ts";
// The echo guard in evaluateDbprPage makes "not_found" mean: the registry searched EC99000103 and said "no records".

test("LIVE: EC99000103 is not in Florida DBPR", { skip: process.env.LIVE !== "1" && "set LIVE=1 to query the real registry" }, async (t) => {
  const r = await lookupLicenseWithDiagnostics("EC99000103", "Quick Volt Pros", { mode: "live", fixtures: {} });
  t.diagnostic(`LIVE RESULT: query=${r.check.query} verdict=${r.check.verdict} found=${r.check.found} records=${r.check.records.length} mode=${r.check.source.mode} asOf=${r.check.source.asOf} ms=${r.ms} error=${r.error ?? "none"}`);
  assert.equal(r.error, null);
  assert.equal(r.check.found, false);
  assert.equal(r.check.verdict, "not_found");
  assert.equal(r.check.source.mode, "live");
});
