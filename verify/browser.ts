// Headless-browser checks (B*): the host page plays every SPEC §1 beat against the live MCP server and
// sandbox; cards render in the cross-origin sandboxed iframe; one screenshot per beat.
import { chromium, type FrameLocator, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SPEC_LINES, type Row } from "./protocol.ts";

const BRAND = /\b(ring|amazon|alexa|echo|thumbtack|angi|homeadvisor|dbpr|myfloridalicense)\b/i;

export async function runBrowserChecks(opts: { hostUrl: string; simBase: string; screensDir: string }, log: (s: string) => void): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (id: string, check: string, expected: string, actual: string, pass: boolean) => {
    rows.push({ id, check, expected, actual, pass });
    log(`${pass ? "PASS" : "FAIL"} ${id} ${check} :: ${actual}`);
  };
  mkdirSync(opts.screensDir, { recursive: true });
  await fetch(`${opts.simBase}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scenario":"demo"}' });
  const user = `web-${Date.now().toString(36)}`;
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const cardTexts: string[] = [];
  const fits: string[] = [];
  const shots: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.setDefaultTimeout(20_000);
    const host = () => page.evaluate(() => (window as any).__host);
    const view = (): FrameLocator => page.frameLocator("#card iframe").frameLocator("iframe");
    const turns = async () => Number(await page.evaluate(() => document.body.dataset.turns ?? "0"));
    async function say(text: string): Promise<any> {
      const n = await turns();
      await page.click("#utterance");
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await page.waitForFunction((k) => Number(document.body.dataset.turns ?? "0") > k && document.body.dataset.busy === "0", n);
      return (await host()).turns.at(-1);
    }
    async function cardReady(viewName: string, renders: number): Promise<void> {
      await page.waitForSelector(`#card iframe[data-rendered='${renders}'][data-view='${viewName}']`);
      await view().locator(`#card[data-view='${viewName}']`).waitFor();
      cardTexts.push(`${viewName}: ${await view().locator("#card").innerText()}`);
      const f = await view().locator("body").evaluate((b) => ({ zoom: Number(b.dataset.zoom), overflow: document.documentElement.scrollHeight - innerHeight, vh: innerHeight }));
      fits.push(`${viewName}@${f.zoom}:${f.vh}px${f.overflow > 1 || f.vh > 590 ? `!overflow=${f.overflow}` : ""}`);
    }
    async function shot(n: number): Promise<void> {
      const p = join(opts.screensDir, `beat-${n}.png`);
      await page.locator("#device").screenshot({ path: p });
      shots.push(p);
    }
    const rowsOf = (state: string) => view().locator(`#rows .row[data-state='${state}']`);

    await page.goto(`${opts.hostUrl}?user=${user}&pace=fast`);
    await page.waitForSelector("body[data-connected='1']");
    const h0 = await host();
    add("B1", "host connects live (browser Streamable HTTP client, simulated account link)", `protocol "2025-11-25", session id, 7 tools`,
      `protocol=${h0.protocolVersion} session=${String(h0.sessionId).slice(0, 8)}… tools=${h0.tools.length}`, h0.protocolVersion === "2025-11-25" && /^[0-9a-f-]{36}$/.test(h0.sessionId) && h0.tools.length === 7);

    // ---- beat 1 ----
    const t1 = await say("Alexa, I need a licensed electrician to replace outlets and smoke detectors in the master bath.");
    await cardReady("pros", 1);
    const struck = rowsOf("struck");
    const struckText = (await struck.allInnerTexts()).join(" | ");
    const okRows = await rowsOf("ok").count();
    const p1 = (await rowsOf("ok").first().innerText()).replace(/\s+/g, " ");
    const badges = await view().locator("#rows .badge").allInnerTexts();
    await shot(1);
    add("B2", "beat 1: find_pros line + pros card (P3 struck 'not found', licenses with source + mode badge)", `SPEC line; 2 ok rows; 1 struck "not found"; FIXTURE badges`,
      `line ${t1.speech === SPEC_LINES.find ? "=" : "≠"} SPEC (${t1.seconds}s) | ok=${okRows} struck="${struckText.replace(/\s+/g, " ").slice(0, 80)}" | P1="${p1.slice(0, 70)}" | badges=${[...new Set(badges)].join(",")}`,
      t1.speech === SPEC_LINES.find && okRows === 2 && (await struck.count()) === 1 && /Quick Volt Pros/.test(struckText) && /not found/.test(struckText) && /License EC99000101/.test(p1) && badges.length >= 3 && badges.every((b) => b === "FIXTURE"));
    const chip1 = await page.locator(".chip[data-tool='tools/call proofpay.find_pros'] .step").count();
    const chipBadges = await page.locator(".chip[data-tool='tools/call proofpay.find_pros'] .step .badge").allInnerTexts();
    add("B3", "chips: one per tools/call with one sub-chip per step and a mode badge", "find_pros chip with 4 steps (SANDBOX + 3 FIXTURE)", `${chip1} steps: ${chipBadges.join(",")}`, chip1 === 4 && chipBadges[0] === "SANDBOX" && chipBadges.slice(1).every((b) => b === "FIXTURE"));

    // ---- beat 2 ----
    const t2a = await say("Book Bright Current.");
    await cardReady("scope", 2);
    const t2b = await say("Yes.");
    await cardReady("scope", 3);
    const title2 = await view().locator("#title").innerText();
    const items2 = await view().locator("#rows .row").count();
    const more2 = await view().locator("#more").innerText();
    const consent2 = await view().locator(".field[data-kind='consent']").innerText();
    const door2 = await view().locator(".field[data-kind='door']").innerText();
    const action2 = await view().locator("#action").innerText();
    await shot(2);
    add("B4", "beat 2: read-back, 'Yes', booked scope card (3 rows +3 more, consent row, simulated door code, Cancel)", "SPEC lines; Master bath electrical · Thu 10–12; +3 more; consent; simulated; Cancel booking",
      `${t2a.speech === SPEC_LINES.readBack ? "=" : "≠"}/${t2b.speech === SPEC_LINES.booked ? "=" : "≠"} SPEC | "${title2}" rows=${items2} "${more2}" | ${consent2.replace(/\s+/g, " ")} | ${door2.replace(/\s+/g, " ")} | [${action2}]`,
      t2a.speech === SPEC_LINES.readBack && t2b.speech === SPEC_LINES.booked && title2 === "Master bath electrical · Thu 10–12" && items2 === 3 && more2 === "+3 more" && /pro agreed ✓/.test(consent2) && /arrive\/leave only, no video kept/.test(consent2) && /simulated \(no lock API\)/.test(door2) && action2 === "Cancel booking");

    // ---- simulated time ----
    await page.click("#sim-time");
    await page.waitForSelector("#sim-badge[data-advanced='1']");
    const simChip = await page.locator(".chip[data-tool='sandbox clock → Thu 2:15 PM'] .step").allInnerTexts();
    const clock = await page.locator("#clock").innerText();
    add("B5", "simulated time button: clock jump, signed camera webhooks delivered, 'simulated time' badge", "Thu 2:15 PM, webhook sub-chips delivered, badge shown",
      `clock="${clock}" webhooks=${simChip.filter((s) => /delivered · HTTP 200/.test(s)).length}/${simChip.length - 1} | ${simChip.at(-1)}`,
      clock === "Thu 2:15 PM" && simChip.filter((s) => /delivered · HTTP 200/.test(s)).length >= 5 && /invoice posted/.test(simChip.at(-1) ?? ""));

    // ---- beat 3 ----
    const t3 = await say("He sent the invoice. Pay him.");
    await cardReady("payment", 4);
    const hero3 = await view().locator("#hero").innerText();
    const bad3 = await view().locator("#rows .row[data-state='bad']").allInnerTexts();
    const allRows3 = await view().locator("#rows .row").count();
    const withSrc3 = await view().locator("#rows .row .src .badge").count();
    const action3 = await view().locator("#action").innerText();
    const text3 = await view().locator("#card").innerText();
    await shot(3);
    add("B6", "beat 3: payment card numbers and evidence rows", `"Pay now $1,050.00 · Waits $370.00"; 2 not-confirmed rows; every row source+badge; "Pay $1,050"`,
      `${t3.speech === SPEC_LINES.review ? "=" : "≠"} SPEC | "${hero3}" | bad=${bad3.length}: ${bad3.map((b) => b.split("\n")[1]).join(" / ")} | rows=${allRows3} sourced=${withSrc3} | [${action3}]`,
      t3.speech === SPEC_LINES.review && hero3 === "Pay now $1,050.00 · Waits $370.00" && bad3.length === 2 && /hallway smoke detector/.test(bad3.join(" ")) && /Electrical inspection/.test(bad3.join(" ")) && withSrc3 === allRows3 && allRows3 <= 5 && action3 === "Pay $1,050");
    add("B7", "payment wording: never 'hold'; sandbox label present", "no 'hold'; 'Sandbox' footer", `hold=${/\bhold\b/i.test(text3)} sandbox=${/Sandbox/.test(text3)}`, !/\bhold\b/i.test(text3) && /Sandbox/.test(text3));

    // ---- beat 4: tap the card CTA (View -> ui/message -> host turn), then the voice code ----
    const n4 = await turns();
    await view().locator("#action").click();
    await page.waitForFunction((k) => Number(document.body.dataset.turns ?? "0") > k && document.body.dataset.busy === "0", n4);
    const t4a = (await host()).turns.at(-1);
    await cardReady("confirm", 5);
    const confirm4 = await view().locator("#card").innerText();
    const t4b = await say("four seven one nine");
    await cardReady("confirm", 6);
    const hero4 = await view().locator("#hero").innerText();
    const transcriptText = await page.locator("#transcript").innerText();
    const subUser = await page.locator("#sub-user").innerText();
    await shot(4);
    add("B8", "beat 4: card CTA tap reaches the host as the next turn; confirm card shows policy, card on file, voice code", "tap -> pay_proven; refund policy; •• 42 (sandbox); Voice code required",
      `source=${t4a.source} tool=${t4a.tool} ${t4a.speech === SPEC_LINES.payPrompt ? "=" : "≠"} SPEC | policy=${/refund/i.test(confirm4)} card=${/•• 42 \(sandbox\)/.test(confirm4)} code=${/Voice code required/.test(confirm4)}`,
      t4a.source === "tap" && t4a.tool === "pay_proven" && t4a.speech === SPEC_LINES.payPrompt && /refund/i.test(confirm4) && /•• 42 \(sandbox\)/.test(confirm4) && /Voice code required/.test(confirm4));
    add("B9", "voice code masked everywhere; receipt", `"Paid $1,050.00"; "••••" shown; digits never shown`,
      `${t4b.speech === SPEC_LINES.paid ? "=" : "≠"} SPEC | hero="${hero4}" | sub="${subUser}" | utterance="${t4b.utterance}" args=${JSON.stringify(t4b.args)} | digits in transcript=${/4719|four seven one nine/.test(transcriptText)}`,
      t4b.speech === SPEC_LINES.paid && hero4 === "Paid $1,050.00" && subUser === "You: ••••" && t4b.utterance === "••••" && t4b.args?.voice_code === "••••" && !/4719|four seven one nine/i.test(transcriptText));

    // ---- beat 5: New session, then status + draft from saved state ----
    const sidBefore = (await host()).sessionId;
    await page.click("#new-session");
    await page.waitForSelector("body[data-connected='2']");
    const sidAfter = (await host()).sessionId;
    const t5a = await say("What's left with the electrician?");
    await cardReady("status", 7);
    const status5 = (await view().locator("#rows .row[data-state='bad']").count());
    const t5b = await say("Yes, draft it.");
    await cardReady("draft", 8);
    const note5 = await view().locator("#note").innerText();
    const footer5 = await view().locator("#footer").innerText();
    await shot(5);
    add("B10", "beat 5: New session (new Mcp-Session-Id), status from saved state, draft note (homeowner sends)", "new sid; SPEC line; 2 open rows; note; 'never sends'",
      `sid ${String(sidBefore).slice(0, 8)}…->${String(sidAfter).slice(0, 8)}… | ${t5a.speech === SPEC_LINES.status ? "=" : "≠"} SPEC | open=${status5} | draft tool=${t5b.tool} | "${footer5}"`,
      sidAfter !== sidBefore && t5a.speech === SPEC_LINES.status && status5 === 2 && t5b.tool === "draft_note" && /hallway smoke detector/i.test(note5) && /never sends/.test(footer5));

    // ---- cross-cutting ----
    const iso = await page.evaluate(() => {
      const f = document.querySelector("#card iframe") as HTMLIFrameElement;
      let reachable = true;
      try { reachable = !!f.contentDocument; } catch { reachable = false; }
      return { src: f.src, sandbox: f.getAttribute("sandbox"), reachable, hostOrigin: location.origin };
    });
    add("B11", "cards are cross-origin sandboxed (host cannot read them)", "iframe origin != host origin, contentDocument null",
      `host=${iso.hostOrigin} iframe=${new URL(iso.src).origin} sandbox="${iso.sandbox}" contentDocument=${iso.reachable ? "REACHABLE" : "null"}`, new URL(iso.src).origin !== iso.hostOrigin && !iso.reachable);
    const allTurns = (await host()).turns as { speech: string; seconds: number }[];
    const longest = Math.max(...allTurns.map((t) => t.seconds));
    add("B12", "every Alexa line ≤ 20 s at 2.5 words/s, seconds shown with the subtitle", "max ≤ 20", `max ${longest}s over ${allTurns.length} turns; shown "${await page.locator("#sub-seconds").innerText()}"`, longest <= 20 && /\d+(\.\d)? s/.test(await page.locator("#sub-seconds").innerText()));
    const brandHits = cardTexts.filter((t) => BRAND.test(t)).map((t) => `${t.split(":")[0]}:${t.match(BRAND)?.[0]}`);
    add("B13", "no real brand names in any card text (8 cards)", "0 hits", brandHits.length ? brandHits.join(", ") : `0 hits in ${cardTexts.length} cards`, brandHits.length === 0 && cardTexts.length === 8);

    add("B16", "every card fits the display container (root zoom per device class, reduced only to fit)", "no vertical overflow inside the card frame; frame ≤ 590 px", fits.join(" "), fits.length === 8 && fits.every((x) => !x.includes("!")));

    // ---- Play demo (fixed pacing; fast mode for verify) ----
    await page.click("#play-demo");
    await page.waitForSelector("body[data-demo='done'], body[data-demo='failed']", { timeout: 120_000 });
    const hd = await host();
    const demoTurns = hd.turns.filter((t: any) => t.source === "demo");
    const demoMatch = [SPEC_LINES.find, SPEC_LINES.readBack, SPEC_LINES.booked, SPEC_LINES.review, SPEC_LINES.payPrompt, SPEC_LINES.paid, SPEC_LINES.status].every((l) => demoTurns.some((t: any) => t.speech === l));
    add("B14", "'Play demo' runs beats 1-5 end to end", "done, 8 tool turns, all SPEC lines, no errors",
      `${await page.evaluate(() => document.body.dataset.demo)} turns=${demoTurns.length} tools=${demoTurns.map((t: any) => t.tool).join(",")} specLines=${demoMatch} errors=${hd.errors.length}`,
      hd.demo.done && demoTurns.length === 8 && demoMatch && hd.errors.length === 0);
    add("B15", "no console errors / page errors in host, sandbox proxy or views", "0", `${consoleErrors.length}${consoleErrors.length ? ": " + consoleErrors.join(" || ") : ""}`, consoleErrors.length === 0);
    log(`screenshots -> ${shots.join(", ")}`);
  } catch (err) {
    add("B!", "browser flow aborted", "no exception", `${String(err).slice(0, 400)} | console: ${consoleErrors.join(" || ")}`, false);
  } finally {
    await browser.close();
  }
  return rows;
}

export type { Page };
