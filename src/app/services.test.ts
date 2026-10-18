// services: per-account sandbox tenants and the live-registry fallback to recorded pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServices, envFromProcess } from "./services.ts";

test("forUser: sandbox bases get /t/<user>; non-sandbox bases stay; off without SANDBOX_PER_USER", async () => {
  const seen: string[] = [];
  const srv = createServer((req, res) => { seen.push(req.url ?? ""); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"now":1,"professionals":[]}'); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const s = createServices(envFromProcess({ SANDBOX_BASE: base, SANDBOX_PER_USER: "1", RING_API_BASE: "https://camera.example/api" }));
    const u = s.forUser("demo-x1");
    assert.equal(s.forUser("demo-x1"), u, "cached per user");
    await u.now();
    await u.listProfessionals({ projectDescription: "x", zipCode: "32000", trade: "electrician" });
    assert.deepEqual(seen, ["/t/demo-x1/sim/clock", "/t/demo-x1/spi/ListProfessionals"]);
    const off = createServices(envFromProcess({ SANDBOX_BASE: base }));
    assert.equal(off.forUser("demo-x1"), off);
  } finally { srv.close(); }
});

test("registry: a live number falls back to its recorded page when the live registry fails, and says so", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("connect ETIMEDOUT"); }) as typeof fetch;
  try {
    const s = createServices(envFromProcess({ REGISTRY_MODE: "auto", REGISTRY_LIVE_NUMBERS: "EC99000103,EC99000101", REGISTRY_TIMEOUT_MS: "500" }));
    const c = await s.lookupLicense("EC99000101", "Bright Current Electric", Date.parse("2026-10-14T22:00:00Z"));
    assert.equal(c.verdict, "verified");
    assert.equal(c.source.mode, "fixture");
    assert.match(c.source.ref ?? "", /^live registry unavailable \(connect ETIMEDOUT\); recorded page fixtures\/registry\/dbpr-found\.sample\.html$/);
    // No recorded page -> stays "unavailable" (never verified on failure).
    const none = await s.lookupLicense("CGC1500001", "Some Builder", Date.now());
    assert.equal(none.verdict, "unavailable");
    assert.equal(none.source.mode, "live");
  } finally { globalThis.fetch = realFetch; }
});
