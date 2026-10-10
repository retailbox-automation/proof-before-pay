// Alexa request verification: synthetic chain minted with openssl (root -> leaf with SAN echo-api.amazon.com),
// a saved real Amazon chain (echo-api-cert-12.pem, valid 2023-03-16..2023-12-23) checked at a pinned clock, and
// the same checks through the HTTP endpoint.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCertUrl, createAlexaVerifier, validateChain, VerificationError } from "../src/verify.ts";
import { startSkillServer, type RunningSkillServer } from "../src/server.ts";
import type { Proofpay } from "../src/proofpay.ts";
import { envelope } from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CERT_URL = "https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem";
let dir = "";
let rootPem = "", leafPem = "", leafKey = "", otherKey = "", wrongSanPem = "";

function openssl(...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pbp-skill-certs-"));
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "2", "-subj", "/CN=PBP Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  for (const [name, san] of [["leaf", "DNS:echo-api.amazon.com"], ["wrong", "DNS:example.com"]]) {
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    writeFileSync(join(dir, `${name}.cnf`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
    openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "1", "-extfile", `${name}.cnf`);
  }
  openssl("genrsa", "-out", "other.key", "2048");
  rootPem = readFileSync(join(dir, "root.pem"), "utf8");
  leafPem = readFileSync(join(dir, "leaf.pem"), "utf8");
  leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
  otherKey = readFileSync(join(dir, "other.key"), "utf8");
  wrongSanPem = readFileSync(join(dir, "wrong.pem"), "utf8");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const sig = (body: string, key = leafKey) => cryptoSign("sha256", Buffer.from(body), key).toString("base64");
const body = (ageMs = 0) => JSON.stringify(envelope({ intent: "AMAZON.HelpIntent", timestamp: new Date(Date.now() - ageMs).toISOString() }));
const verifier = (chain = `${leafPem}\n${rootPem}`, roots = [rootPem]) => createAlexaVerifier({ fetchChain: async () => chain, trustedRoots: roots });
const headers = (b: string, key?: string) => ({ signaturecertchainurl: CERT_URL, "signature-256": sig(b, key) });
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof VerificationError && re.test((e as Error).message));

test("valid signed request passes", async () => {
  const b = body();
  await verifier()(b, headers(b));
  await verifier()(Buffer.from(b), headers(b)); // raw bytes
});

test("tampered body is rejected", async () => {
  const b = body();
  const tampered = b.replace("AMAZON.HelpIntent", "PayProvenIntent");
  assert.notEqual(tampered, b);
  await rejects(verifier()(tampered, headers(b)), /signature does not match/);
});

test("old timestamp is rejected (> 150 s), fresh one passes, future skew too", async () => {
  const old = body(151_000);
  await rejects(verifier()(old, headers(old)), /timestamp/);
  const recent = body(120_000);
  await verifier()(recent, headers(recent));
  const future = body(-200_000);
  await rejects(verifier()(future, headers(future)), /timestamp/);
});

test("signature by another key, wrong SAN, untrusted root, missing headers -> rejected", async () => {
  const b = body();
  await rejects(verifier()(b, headers(b, otherKey)), /signature does not match/);
  await rejects(verifier(`${wrongSanPem}\n${rootPem}`)(b, headers(b)), /SAN/);
  await rejects(verifier(`${leafPem}\n${rootPem}`, [])(b, headers(b)), /not issued by|no trusted root/);
  await rejects(verifier()(b, { "signature-256": sig(b) }), /SignatureCertChainUrl/);
  await rejects(verifier()(b, { signaturecertchainurl: CERT_URL }), /Signature-256/);
});

test("cert URL rules from Amazon's doc", () => {
  for (const ok of ["https://s3.amazonaws.com/echo.api/echo-api-cert.pem", "https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem", "https://s3.amazonaws.com/echo.api/../echo.api/echo-api-cert.pem", "https://S3.AMAZONAWS.COM/echo.api/x.pem"]) checkCertUrl(ok);
  for (const bad of ["http://s3.amazonaws.com/echo.api/echo-api-cert.pem", "https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem", "https://s3.amazonaws.com/invalid.path/echo-api-cert.pem", "https://s3.amazonaws.com:563/echo.api/echo-api-cert.pem", "https://s3.amazonaws.com/echo.api/%2e%2e/x.pem", "https://evil.example/echo.api/x.pem"]) {
    assert.throws(() => checkCertUrl(bad), VerificationError, bad);
  }
});

test("real Amazon chain (saved echo-api-cert-12.pem) validates against Node's root store inside its validity window", () => {
  const pem = readFileSync(join(HERE, "fixtures", "echo-api-cert-12.pem"), "utf8");
  const leaf = validateChain(pem, { now: Date.parse("2023-06-01T00:00:00Z"), trustedRoots: rootCertificates });
  assert.match(leaf.subject, /echo-api\.amazon\.com/);
  assert.throws(() => validateChain(pem, { now: Date.now(), trustedRoots: rootCertificates }), /expired/); // must-differ: same chain today
});

test("HTTP endpoint: signed request 200, tampered 400, old timestamp 400; SKIP_SIGNATURE_CHECK only when asked", async () => {
  const fake: Proofpay = { call: async (_k, tool) => ({ kind: "missing", tool, available: [] }), endSession: async () => {}, close: async () => {} };
  const s: RunningSkillServer = await startSkillServer({ port: 0, proofpay: fake, verifier: verifier(), quiet: true });
  const post = (b: string, h: Record<string, string>) => fetch(s.url, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: b });
  try {
    const b = body();
    const ok = await post(b, headers(b));
    assert.equal(ok.status, 200);
    const out = await ok.json();
    assert.match(out.response.outputSpeech.ssml, /You can say/);
    assert.equal((await post(b.replace("HelpIntent", "StopIntent"), headers(b))).status, 400);
    const old = body(10 * 60_000);
    assert.equal((await post(old, headers(old))).status, 400);
    assert.equal((await post(b, {})).status, 400);
    assert.equal((await fetch(s.url.replace("/alexa", "/healthz"))).status, 200);
  } finally { await s.close(); }
  const skip = await startSkillServer({ port: 0, proofpay: fake, skipSignatureCheck: true, quiet: true });
  try {
    const b = body();
    assert.equal((await fetch(skip.url, { method: "POST", body: b })).status, 200);
  } finally { await skip.close(); }
});

test("HTTP endpoint with ALEXA_SKILL_ID: a request for another skill is refused", async () => {
  const fake: Proofpay = { call: async (_k, tool) => ({ kind: "missing", tool, available: [] }), endSession: async () => {}, close: async () => {} };
  const s = await startSkillServer({ port: 0, proofpay: fake, skipSignatureCheck: true, skillId: "amzn1.ask.skill.ours", quiet: true });
  try {
    const mine = JSON.stringify(envelope({ intent: "AMAZON.HelpIntent", applicationId: "amzn1.ask.skill.ours" }));
    const theirs = JSON.stringify(envelope({ intent: "AMAZON.HelpIntent", applicationId: "amzn1.ask.skill.other" }));
    assert.equal((await fetch(s.url, { method: "POST", body: mine })).status, 200);
    assert.equal((await fetch(s.url, { method: "POST", body: theirs })).status, 400);
  } finally { await s.close(); }
});
