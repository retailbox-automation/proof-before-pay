// The skill against a REAL proofpay MCP server (Streamable HTTP, 2025-11-25) + sandbox services on ephemeral
// ports: the SPEC demo flow through Alexa request envelopes -> speech + APL datasource.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { buildSkill, TEXT, resolvePro } from "../src/handler.ts";
import { createProofpay, type Proofpay, type ToolOutcome } from "../src/proofpay.ts";
import { aplDocument, DOCS, APL_VERSION } from "../src/apl.ts";
import { startStack, envelope, speech, apl, type Stack } from "./helpers.ts";

let stack: Stack;
let proofpay: Proofpay;
const calls: { tool: string; args: Record<string, unknown>; out: ToolOutcome }[] = [];
let skill: ReturnType<typeof buildSkill>;
const logs: string[] = [];
const S1 = "amzn1.echo-api.session.s1";
const S2 = "amzn1.echo-api.session.s2-new-session";

before(async () => {
  stack = await startStack();
  const real = createProofpay({ url: stack.mcp.url, token: `pbp-sandbox-skilltest-${Date.now().toString(36)}`, timeoutMs: 6000, log: (m) => logs.push(m) });
  proofpay = {
    async call(key, tool, args) { const out = await real.call(key, tool, args); calls.push({ tool, args, out }); return out; },
    endSession: (k) => real.endSession(k),
    close: () => real.close(),
  };
  skill = buildSkill({ proofpay, log: (m, x) => logs.push(`${m} ${JSON.stringify(x ?? {})}`) });
});

after(async () => {
  await proofpay.close();
  await stack.close();
});

// Session attributes travel in the response and come back in the next request, as on a device.
let attrs: Record<string, unknown> = {};
async function say(o: Parameters<typeof envelope>[0]): Promise<any> {
  const r = await skill.invoke(envelope({ sessionId: S1, attributes: attrs, ...o }));
  attrs = r.sessionAttributes ?? {};
  return r;
}
const last = () => calls[calls.length - 1];
const okText = () => { const o = last().out; assert.equal(o.kind, "ok", `tool ${last().tool} -> ${o.kind}`); return (o as Extract<ToolOutcome, { kind: "ok" }>).text; };

test("APL documents: version 2024.3, dark tokens, no logos or brand marks", () => {
  for (const name of DOCS) {
    const d = aplDocument(name);
    assert.equal(d.type, "APL");
    assert.equal(d.version, APL_VERSION);
    const c = d.resources[0].colors;
    assert.deepEqual([c.cardBg, c.innerBg, c.primary, c.green, c.amber], ["#14181E", "#1B2028", "#2D415E", "#3DDC97", "#F5B547"], name);
    const s = JSON.stringify(d);
    assert.ok(!/"Image"|"VectorGraphic"|https?:\/\/|logo/i.test(s), `${name}: no images, logos or remote assets`);
    assert.ok(!/\b(Amazon|Echo|Ring)\b/.test(s), `${name}: no brand names`);
  }
});

test("launch: welcome + card", async () => {
  const r = await say({ type: "LaunchRequest", isNew: true });
  assert.equal(speech(r), TEXT.welcome);
  assert.equal(r.response.shouldEndSession, false);
  assert.equal(apl(r).document.version, "2024.3");
});

test("beat 1 FindProsIntent -> find_pros: tool line spoken verbatim, pros list APL", async () => {
  const r = await say({ intent: "FindProsIntent", slots: { job: "replace outlets and smoke detectors in the master bath" } });
  assert.equal(last().tool, "find_pros");
  assert.deepEqual(last().args, { trade: "electrician", job_summary: "replace outlets and smoke detectors in the master bath" });
  const text = okText();
  assert.equal(speech(r), text);
  assert.match(text, /Quick Volt/);
  assert.match(text, /Bright Current is licensed, 4\.8 stars, 1,120 dollars/);
  const d = apl(r);
  assert.equal(d.token, "pbp-pros");
  assert.ok(d.document.mainTemplate, "pros document");
  const rows = d.datasources.card.rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, "Bright Current Electric");
  assert.equal(rows[0].state, "ok");
  assert.match(rows[0].detail, /EC99000101/);
  assert.equal(rows[0].source, "Florida license registry");
  assert.equal(rows[0].action, "Book");
  const struck = rows.find((x: any) => x.label === "Quick Volt Pros");
  assert.equal(struck.state, "struck");
  assert.match(struck.detail, /EC99000103 not found/);
  assert.equal((attrs.pending as any)?.kind, "offer_pro");
});

test("beat 2 BookIntent -> book_job read-back, ConfirmIntent -> booked", async () => {
  let r = await say({ intent: "BookIntent", slots: { pro: "Bright Current" } });
  assert.equal(last().tool, "book_job");
  assert.deepEqual(last().args, { pro_id: "P1", confirm: false });
  assert.equal(speech(r), okText());
  assert.match(speech(r), /Bright Current, Thursday 10 to noon/);
  assert.match(speech(r), /1,120 dollars/);
  assert.equal(apl(r).token, "pbp-card");
  assert.match(apl(r).datasources.card.title, /Thu/);
  assert.equal(apl(r).datasources.card.rows.length, 3);
  assert.equal(apl(r).datasources.card.more, "+3 more");
  assert.equal((attrs.pending as any)?.kind, "book");

  r = await say({ intent: "ConfirmIntent" });
  assert.deepEqual(last().args, { pro_id: "P1", confirm: true });
  assert.match(speech(r), /^Booked\./);
  assert.equal(attrs.pending, null);
});

test("simulated time -> camera webhooks; beat 3 ReviewInvoiceIntent -> payment APL with two stacks and sources", async () => {
  const adv = await fetch(`${stack.sandbox.url}/sim/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "demo" }) });
  assert.equal(adv.status, 200);
  const r = await say({ intent: "ReviewInvoiceIntent" });
  assert.equal(last().tool, "review_invoice");
  assert.equal(speech(r), okText());
  assert.match(speech(r), /1,050/);
  assert.match(speech(r), /370/);
  const d = apl(r);
  assert.equal(d.token, "pbp-payment");
  const p = d.datasources.payment;
  assert.equal(p.payNow, 105000);
  assert.equal(p.waits, 37000);
  assert.equal(p.payNowText, "$1,050.00");
  assert.equal(p.waitsText, "$370.00");
  assert.equal(p.subtotalText, "$1,050.00");
  assert.equal(p.feesText, "$0.00");
  assert.equal(p.totalText, "$1,050.00");
  assert.equal(p.canPay, true);
  assert.equal(p.payLabel, "Pay $1,050");
  assert.deepEqual(p.proven.map((x: any) => x.source), ["Florida license registry", "front door camera", "marketplace photos"]);
  assert.match(p.proven[1].label, /^Visit 10:02–11:40$/);
  assert.equal(p.waiting.length, 2);
  assert.match(p.waiting[0].label, /hallway smoke detector/i);
  assert.match(p.waiting[1].label, /Electrical inspection/);
  assert.ok(p.waiting.every((x: any) => x.source), "every waiting row names its source");
  assert.equal((attrs.pending as any)?.kind, "checkout");
});

test("beat 4 PayProvenIntent: platform owns checkout; never pay_proven, never asks for a code", async () => {
  const before = calls.length;
  const r = await say({ intent: "PayProvenIntent" });
  const made = calls.slice(before);
  assert.deepEqual(made.map((c) => c.tool), ["prepare_checkout"]);
  assert.ok(!calls.some((c) => c.tool === "pay_proven"), "pay_proven is never called");
  const s = speech(r);
  assert.ok(s.endsWith(TEXT.platformCheckout), s);
  assert.doesNotMatch(s, /say your .*code/i);
  if (made[0].out.kind === "missing") {
    assert.equal(s, `${TEXT.notAvailable} ${TEXT.platformCheckout}`);
    assert.ok(logs.some((l) => l.startsWith("tool not available yet")), "missing tool is logged");
    assert.equal(apl(r).token, "pbp-card");
    assert.deepEqual(apl(r).datasources.card.rows[0], { state: "pending", mark: "…", label: TEXT.notAvailable, detail: "", source: "", action: "", actionMessage: "" });
  } else {
    assert.equal(made[0].out.kind, "ok");
    assert.equal(apl(r).token, "pbp-payment");
  }
});

test("touch: Pay button on the card goes the same way (no code)", async () => {
  const r = await say({ type: "Alexa.Presentation.APL.UserEvent", arguments: ["pay"] });
  assert.equal(last().tool, "prepare_checkout");
  assert.ok(speech(r).endsWith(TEXT.platformCheckout));
});

test("beat 5 new session: StatusIntent -> job_status from saved state, then yes -> draft_note", async () => {
  attrs = {};
  let r = await skill.invoke(envelope({ sessionId: S2, isNew: true, intent: "StatusIntent" }));
  attrs = r.sessionAttributes ?? {};
  assert.equal(last().tool, "job_status");
  assert.equal(speech(r), okText());
  assert.match(speech(r), /hallway smoke detector needs a photo/);
  assert.match(speech(r), /300-dollar inspection/);
  assert.equal(apl(r).token, "pbp-status");
  const rows = apl(r).datasources.card.rows;
  assert.ok(rows.some((x: any) => /hallway smoke detector/i.test(x.label) && x.state === "bad"));
  assert.equal(apl(r).datasources.card.action, "Draft a note");
  assert.equal((attrs.pending as any)?.kind, "draft");

  r = await skill.invoke(envelope({ sessionId: S2, attributes: attrs, intent: "ConfirmIntent" }));
  attrs = r.sessionAttributes ?? {};
  assert.equal(last().tool, "draft_note");
  assert.equal(apl(r).token, "pbp-card");
  assert.match(apl(r).datasources.card.note, /^Hi Bright Current Electric,/);
  assert.match(apl(r).datasources.card.noteHtml, /<br>/);
});

test("beat 6 WarrantyIntent -> warranty_callback (graceful when the server doesn't have it yet)", async () => {
  const r = await skill.invoke(envelope({ sessionId: S2, attributes: attrs, intent: "WarrantyIntent" }));
  assert.equal(last().tool, "warranty_callback");
  if (last().out.kind === "missing") {
    assert.equal(speech(r), TEXT.notAvailable);
    assert.equal(r.response.shouldEndSession, false);
  } else {
    assert.equal(last().out.kind, "ok");
    assert.equal(apl(r).token, "pbp-warranty");
  }
});

test("no screen: same speech, no APL directive", async () => {
  const r = await skill.invoke(envelope({ sessionId: S2, intent: "StatusIntent", apl: false }));
  assert.match(speech(r), /hallway smoke detector/);
  assert.equal(apl(r), undefined);
});

test("built-ins: help, fallback, no, stop, cancel, session ended; yes with nothing pending", async () => {
  assert.equal(speech(await skill.invoke(envelope({ intent: "AMAZON.HelpIntent" }))), TEXT.help);
  assert.equal(speech(await skill.invoke(envelope({ intent: "AMAZON.FallbackIntent" }))), TEXT.fallback);
  assert.equal(speech(await skill.invoke(envelope({ intent: "AMAZON.NoIntent", attributes: { pending: { kind: "draft" } } }))), TEXT.noThanks);
  assert.equal(speech(await skill.invoke(envelope({ intent: "ConfirmIntent", sessionId: "fresh" }))), TEXT.nothingToConfirm);
  for (const name of ["AMAZON.StopIntent", "AMAZON.CancelIntent"]) {
    const r = await skill.invoke(envelope({ intent: name }));
    assert.equal(speech(r), TEXT.goodbye);
    assert.equal(r.response.shouldEndSession, true);
  }
  const ended = await skill.invoke(envelope({ type: "SessionEndedRequest" }));
  assert.equal(ended.response.outputSpeech, undefined);
  assert.equal(speech(await skill.invoke(envelope({ intent: "BookIntent", slots: { pro: "Bright Current" }, sessionId: "fresh2" }))), TEXT.needSearch);
});

test("resolvePro maps spoken names to the last search", () => {
  const pros = [{ proId: "P1", businessName: "Bright Current Electric", eligible: true }, { proId: "P2", businessName: "Harbor Line Electrical", eligible: true }, { proId: "P3", businessName: "Quick Volt Pros", eligible: false }];
  assert.equal(resolvePro("bright current", pros)?.proId, "P1");
  assert.equal(resolvePro("Harbor Line Electrical", pros)?.proId, "P2");
  assert.equal(resolvePro("quick volt", pros)?.proId, "P3");
  assert.equal(resolvePro("someone else", pros), undefined);
});

test("6 s client deadline: a server that never answers -> timeout line well under Alexa's 8 s", async () => {
  const hang: Server = createServer(() => { /* never responds */ });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
  const a = hang.address();
  const port = typeof a === "object" && a ? a.port : 0;
  const pp = createProofpay({ url: `http://127.0.0.1:${port}/mcp`, token: "pbp-sandbox-hang", timeoutMs: 400, log: () => {} });
  const sk = buildSkill({ proofpay: pp, log: () => {} });
  const t0 = Date.now();
  const r = await sk.invoke(envelope({ intent: "StatusIntent", sessionId: "hang" }));
  const ms = Date.now() - t0;
  assert.equal(speech(r), TEXT.timeout);
  assert.ok(ms < 1500, `answered in ${ms} ms`);
  await pp.close();
  hang.closeAllConnections();
  await new Promise<void>((r2) => hang.close(() => r2()));
});

test("server down: error line, no crash", async () => {
  const pp = createProofpay({ url: "http://127.0.0.1:9/mcp", token: "pbp-sandbox-down", timeoutMs: 2000, log: () => {} });
  const sk = buildSkill({ proofpay: pp, log: () => {} });
  const r = await sk.invoke(envelope({ intent: "StatusIntent", sessionId: "down" }));
  assert.equal(speech(r), TEXT.error);
  await pp.close();
});
