// Headless-browser checks (B*): the host page plays every beat (SPEC §1 + §7.5) against the live MCP server and
// sandbox; cards render in the cross-origin sandboxed iframe; the simulated Alexa+ checkout is drawn by the host;
// one screenshot per beat. Every request the page sends to the MCP server is recorded to prove that payment data and
// the voice code never reach the add-on.
import { chromium, type FrameLocator } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BEAT_1_4, SPEC_LINES, TOOL_OR_ID, type Row } from "./protocol.ts";

// Plain-text "Alexa+" / "Echo Show" are allowed (SPEC §7.4); third-party brand names are not.
const BRAND = /\b(ring|amazon|echo dot|thumbtack|angi|homeadvisor|dbpr|myfloridalicense)\b/i;

export async function runBrowserChecks(opts: { hostUrl: string; simBase: string; mcpUrl: string; screensDir: string }, log: (s: string) => void): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (id: string, check: string, expected: string, actual: string, pass: boolean) => {
    rows.push({ id, check, expected, actual, pass });
    log(`${pass ? "PASS" : "FAIL"} ${id} ${check} :: ${actual}`);
  };
  mkdirSync(opts.screensDir, { recursive: true });
  await fetch(`${opts.simBase}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scenario":"demo"}' });
  const charges = async () => ((await (await fetch(`${opts.simBase}/charges`)).json()) as { charges: { amount: number }[] }).charges;
  const user = `web-${Date.now().toString(36)}`;
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const cardTexts: string[] = [];
  const fits: string[] = [];
  const shots: string[] = [];
  const mcpBodies: { method: string; tool: string | null; body: string; t: number }[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1760, height: 1150 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.on("request", (r) => {
      if (!r.url().startsWith(opts.mcpUrl)) return;
      const body = r.postData() ?? "";
      let method = r.method(), tool: string | null = null;
      try { const j = JSON.parse(body); method = j.method ?? method; tool = j.params?.name ?? null; } catch { /* body-less */ }
      mcpBodies.push({ method, tool, body, t: Date.now() });
    });
    page.setDefaultTimeout(20_000);
    const host = () => page.evaluate(() => (window as any).__host);
    const view = (): FrameLocator => page.frameLocator("#card iframe").frameLocator("iframe");
    const turns = async () => Number(await page.evaluate(() => document.body.dataset.turns ?? "0"));
    const waitTurn = (k: number) => page.waitForFunction((n) => Number(document.body.dataset.turns ?? "0") > n && document.body.dataset.busy === "0", k);
    async function say(text: string): Promise<any> {
      const n = await turns();
      await page.click("#utterance");
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await waitTurn(n);
      return (await host()).turns.at(-1);
    }
    async function cardReady(viewName: string, renders: number): Promise<void> {
      await page.waitForSelector(`#card iframe[data-rendered='${renders}'][data-view='${viewName}']`);
      await view().locator(`#card[data-view='${viewName}']`).waitFor();
      cardTexts.push(`${viewName}: ${await view().locator("#card").innerText()}`);
      const f = await view().locator("body").evaluate((b) => ({ zoom: Number(b.dataset.zoom), overflow: document.documentElement.scrollHeight - innerHeight, vh: innerHeight, marks: document.querySelectorAll("img, svg").length }));
      fits.push(`${viewName}@${f.zoom}:${f.vh}px${f.overflow > 1 || f.vh > 590 ? `!overflow=${f.overflow}` : ""}${f.marks ? `!marks=${f.marks}` : ""}`);
    }
    async function shot(name: string): Promise<void> {
      const p = join(opts.screensDir, `${name}.png`);
      await page.locator("#device").screenshot({ path: p });
      shots.push(p);
    }
    const rowsOf = (state: string) => view().locator(`#rows .row[data-state='${state}']`);

    await page.goto(`${opts.hostUrl}?user=${user}&pace=fast`);
    await page.waitForSelector("body[data-connected='1']");
    const h0 = await host();
    add("B1", "host connects live (browser Streamable HTTP client, simulated account link)", `protocol "2025-11-25", session id, 8 tools`,
      `protocol=${h0.protocolVersion} session=${String(h0.sessionId).slice(0, 8)}… tools=${h0.tools.length}`, h0.protocolVersion === "2025-11-25" && /^[0-9a-f-]{36}$/.test(h0.sessionId) && h0.tools.length === 8);

    // ---- beat 1 ----
    const t1 = await say("Alexa, I need a licensed electrician to replace outlets and smoke detectors in the master bath.");
    await cardReady("pros", 1);
    const struckText = (await rowsOf("struck").allInnerTexts()).join(" | ");
    const okRows = await rowsOf("ok").count();
    const p1 = (await rowsOf("ok").first().innerText()).replace(/\s+/g, " ");
    const badges = await view().locator("#rows .badge").allInnerTexts();
    await shot("beat-1");
    add("B2", "beat 1: find_pros line + pros card (unlicensed pro struck 'not found'; license rows with source + badge)", `SPEC line; 2 ok rows; 1 struck "not found"; FIXTURE badges`,
      `line ${t1.speech === SPEC_LINES.find ? "=" : "≠"} SPEC (${t1.seconds}s) | ok=${okRows} struck="${struckText.replace(/\s+/g, " ").slice(0, 80)}" | P1="${p1.slice(0, 60)}" | badges=${[...new Set(badges)].join(",")}`,
      t1.speech === SPEC_LINES.find && okRows === 2 && (await rowsOf("struck").count()) === 1 && /Quick Volt Pros/.test(struckText) && /not found/.test(struckText) && /License EC99000101/.test(p1) && badges.length >= 3 && badges.every((b) => b === "FIXTURE"));
    const chipBadges = await page.locator("#devview .chip[data-tool='tools/call proofpay.find_pros'] .step .badge").allInnerTexts();
    const chipText = await page.locator("#devview .chip[data-tool='tools/call proofpay.find_pros']").innerText();
    add("B3", "developer view: one chip per tools/call, one sub-chip per step, mode badges, SPI pattern labelled", "4 steps (SANDBOX + 3 FIXTURE), 'Browse-and-Choose'",
      `${chipBadges.join(",")} | browse-and-choose=${/Browse-and-Choose/.test(chipText)}`, chipBadges.length === 4 && chipBadges[0] === "SANDBOX" && chipBadges.slice(1).every((b) => b === "FIXTURE") && /Browse-and-Choose/.test(chipText));

    // ---- beat 2 ----
    const t2a = await say("Book Bright Current.");
    await cardReady("scope", 2);
    const t2b = await say("Yes.");
    await cardReady("scope", 3);
    const title2 = await view().locator("#title").innerText();
    const sub2 = await view().locator("#subtitle").innerText();
    const items2 = await view().locator("#rows .row").count();
    const more2 = await view().locator("#more").innerText();
    const consent2 = await view().locator(".field[data-kind='consent']").innerText();
    const door2 = await view().locator(".field[data-kind='door']").innerText();
    const cancel2 = await view().locator(".field[data-kind='cancellation']").innerText();
    const action2 = await view().locator("#action").innerText();
    await shot("beat-2");
    add("B4", "beat 2: read-back, 'Yes', booked scope card (3 rows +3 more, consent, simulated door code, cancellation policy, Cancel)", "SPEC lines; to be paid after the work is proven; no booking id",
      `${t2a.speech === SPEC_LINES.readBack ? "=" : "≠"}/${t2b.speech === SPEC_LINES.booked ? "=" : "≠"} SPEC | "${title2}" | "${sub2}" | rows=${items2} "${more2}" | ${consent2.replace(/\s+/g, " ").slice(0, 60)} | ${door2.replace(/\s+/g, " ").slice(0, 50)} | ${cancel2.replace(/\s+/g, " ").slice(0, 50)} | [${action2}]`,
      t2a.speech === SPEC_LINES.readBack && t2b.speech === SPEC_LINES.booked && title2 === "Master bath electrical · Thu 10–12" && /to be paid after the work is proven/.test(sub2) && !/PB-\d/.test(sub2) && items2 === 3 && more2 === "+3 more" &&
      /pro agreed ✓/.test(consent2) && /simulated \(no lock API\)/.test(door2) && /Free cancellation up to 24 hours/.test(cancel2) && action2 === "Cancel booking");

    // ---- simulated time ----
    await page.click("#sim-time");
    await page.waitForSelector("#sim-badge[data-advanced='1']");
    const simChip = await page.locator("#devview .chip").first().locator(".step").allInnerTexts();
    const clock = await page.locator("#clock").innerText();
    add("B5", "simulated time: clock jump, signed camera webhooks delivered, 'simulated time' badge", "Thu, Oct 15, 2:15 PM; webhook sub-chips delivered",
      `clock="${clock}" webhooks=${simChip.filter((s) => /delivered · HTTP 200/.test(s)).length}/${simChip.length - 1} | ${simChip.at(-1)?.slice(0, 80)}`,
      clock === "Thu, Oct 15, 2:15 PM" && simChip.filter((s) => /delivered · HTTP 200/.test(s)).length >= 5 && /invoice posted/.test(simChip.at(-1) ?? ""));

    // ---- beat 3: the pre-checkout card ----
    const t3 = await say("He sent the invoice. Pay him.");
    await cardReady("payment", 4);
    const hero3 = await view().locator("#hero").innerText();
    const stacks3 = (await view().locator("#stacks .stack").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
    const bad3 = await view().locator("#rows .row[data-state='bad']").allInnerTexts();
    const allRows3 = await view().locator("#rows .row").count();
    const sourced3 = await view().locator("#rows .row .src .badge").count();
    const breakdown3 = (await view().locator("#breakdown .line").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
    const action3 = await view().locator("#action").innerText();
    const msg3 = await view().locator("#action").getAttribute("data-message");
    const text3 = await view().locator("#card").innerText();
    await shot("beat-3");
    add("B6", "beat 3: pre-checkout card: two stacks, evidence rows with sources, Subtotal/Fees/Total, 'Pay $1,050.00'", `"Pay now $1,050.00 · Waits $370.00"; 2 not-confirmed rows; $1,050.00 / $0.00 / $1,050.00`,
      `${t3.speech === SPEC_LINES.review ? "=" : "≠"} SPEC | "${hero3}" | ${stacks3.join(" / ")} | bad=${bad3.length} | rows=${allRows3} sourced=${sourced3} | ${breakdown3.join(", ")} | [${action3}]`,
      t3.speech === SPEC_LINES.review && hero3 === "Pay now $1,050.00 · Waits $370.00" && stacks3.length === 2 && /\$1,050\.00/.test(stacks3[0]) && /\$370\.00/.test(stacks3[1]) && bad3.length === 2 &&
      /hallway smoke detector/.test(bad3.join(" ")) && /Electrical inspection/.test(bad3.join(" ")) && sourced3 === allRows3 && allRows3 <= 5 &&
      breakdown3.join("|") === "Subtotal $1,050.00|Fees $0.00|Total $1,050.00" && action3 === "Pay $1,050.00");
    add("B7", "payment wording: never 'hold' or 'escrow'; sandbox label; the button sends ui/message 'Pay for this order'", "no hold/escrow; Sandbox; data-message", `hold=${/\bhold\b|escrow/i.test(text3)} sandbox=${/Sandbox/.test(text3)} message="${msg3}"`,
      !/\bhold\b|escrow/i.test(text3) && /Sandbox/.test(text3) && msg3 === "Pay for this order");

    // ---- beat 4: tap the card CTA -> Alexa+ checkout (simulated) drawn by the host ----
    const n4 = await turns();
    const mark4 = Date.now();
    const charges0 = (await charges()).length;
    await view().locator("#action").click();
    await waitTurn(n4);
    const t4a = (await host()).turns.at(-1);
    await page.waitForSelector("#checkout-layer[data-state='awaiting-code']");
    const layer = await page.evaluate(() => {
      const l = document.getElementById("checkout-layer")!;
      return {
        insideIframe: !!document.querySelector("#card iframe")?.contains(l), inDevice: !!document.getElementById("device")?.contains(l), visible: !l.hidden,
        head: document.getElementById("checkout-head")!.textContent, seller: document.getElementById("checkout-seller")!.textContent,
        items: [...document.querySelectorAll("#checkout-items li")].map((x) => x.textContent), totals: [...document.querySelectorAll("#checkout-totals > div")].map((x) => x.textContent),
        card: document.getElementById("checkout-card")!.textContent, refund: document.getElementById("checkout-refund")!.textContent,
        dimmed: document.getElementById("card")!.classList.contains("dimmed"),
      };
    });
    await shot("beat-4");
    add("B8", "beat 4: tap -> ui/message 'Pay for this order' -> host draws 'Alexa+ checkout · simulated' outside the add-on iframe, over the dimmed card",
      "tap turn; layer in the device, not in the iframe; 5 items; Subtotal/Fees/Total; Visa ending 4242 · sandbox; refund link title; SPEC prompt",
      `source=${t4a.source} ${t4a.speech === SPEC_LINES.checkoutPrompt ? "=" : "≠"} SPEC | "${layer.head}" | ${layer.items.length} items | ${layer.totals.join(", ")} | "${layer.card}" | "${layer.refund}" | dimmed=${layer.dimmed} iframe=${layer.insideIframe}`,
      t4a.source === "tap" && t4a.speech === SPEC_LINES.checkoutPrompt && layer.visible && layer.inDevice && !layer.insideIframe && layer.head === "Alexa+ checkout · simulated" && layer.items.length === 5 &&
      layer.totals.join("|") === "Subtotal$1,050.00|Fees$0.00|Total$1,050.00" && layer.card === "Visa ending 4242 · sandbox" && layer.refund === "Refund policy · Bright Current Electric" && layer.dimmed);
    const t4b = await say("four seven one nine");
    await page.waitForSelector("#checkout-layer[data-state='confirmed']");
    const status4 = await page.locator("#checkout-status").innerText();
    const subUser = await page.locator("#sub-user").innerText();
    const transcriptText = await page.locator("#transcript").innerText();
    const ch4 = await charges();
    await shot("beat-4-confirmed");
    add("B9", "voice code checked by the platform layer, masked everywhere; 'Order confirmed'; one charge of $1,050.00", `SPEC line; "You: ••••"; digits never shown; 1 new charge 105000`,
      `${t4b.speech === SPEC_LINES.checkoutDone ? "=" : "≠"} SPEC | "${status4}" | sub="${subUser}" | utterance="${t4b.utterance}" | digits shown=${/4719|four seven one nine/i.test(transcriptText)} | charges ${charges0}->${ch4.length} (${ch4.at(-1)?.amount})`,
      t4b.speech === SPEC_LINES.checkoutDone && status4 === "Order confirmed" && subUser === "You: ••••" && t4b.utterance === "••••" && !/4719|four seven one nine/i.test(transcriptText) && ch4.length === charges0 + 1 && ch4.at(-1)?.amount === 105000);
    const during = mcpBodies.filter((b) => b.t >= mark4 && b.method === "tools/call");
    const allBodies = mcpBodies.map((b) => b.body).join("\n");
    const payLeaks = mcpBodies.filter((b) => /4719|voice_code|voice code|"pin"|instrument|credential|payment_method|pm_visa|last_digits|4242/i.test(b.body));
    add("B10", "the add-on never receives the voice code or payment data; the only tools/call during checkout is prepare_checkout (no arguments)", "0 leaks; tools/call during checkout = [prepare_checkout {}]",
      `${mcpBodies.length} MCP requests recorded · leaks=${payLeaks.length} · during checkout: ${during.map((b) => `${b.tool} ${JSON.parse(b.body).params?.arguments ? JSON.stringify(JSON.parse(b.body).params.arguments) : ""}`).join(", ") || "none"}`,
      mcpBodies.length > 10 && payLeaks.length === 0 && during.length === 1 && during[0].tool === "prepare_checkout" && JSON.stringify(JSON.parse(during[0].body).params?.arguments ?? {}) === "{}" && !/4719/.test(allBodies));

    // ---- beat 5: New session, then status + draft from saved state ----
    const sidBefore = (await host()).sessionId;
    await page.click("#new-session");
    await page.waitForSelector("body[data-connected='2']");
    const sidAfter = (await host()).sessionId;
    const t5a = await say("What's left with the electrician?");
    await cardReady("status", 5);
    const paid5 = await view().locator("#rows .row[data-kind='paid']").innerText();
    const open5 = await view().locator("#rows .row[data-state='bad']").count();
    const t5b = await say("Yes, draft it.");
    await cardReady("draft", 6);
    const note5 = await view().locator("#note").innerText();
    const footer5 = await view().locator("#footer").innerText();
    await shot("beat-5");
    add("B11", "beat 5: New session, status from saved state (paid through Alexa+ checkout), draft note the homeowner sends", "new sid; SPEC line; Paid $1,050.00; 2 open; 'never sends'",
      `sid ${String(sidBefore).slice(0, 8)}…->${String(sidAfter).slice(0, 8)}… | ${t5a.speech === SPEC_LINES.status ? "=" : "≠"} SPEC | ${paid5.split("\n")[1]} | open=${open5} | "${footer5}"`,
      sidAfter !== sidBefore && t5a.speech === SPEC_LINES.status && /Paid \$1,050\.00/.test(paid5) && open5 === 2 && t5b.tool === "draft_note" && /hallway smoke detector/i.test(note5) && /never sends/.test(footer5));

    // ---- beat 6: a month later, warranty ----
    await page.click("#sim-warranty");
    await page.waitForFunction(() => /Nov 12/.test(document.getElementById("clock")?.textContent ?? ""));
    await page.click("#new-session");
    await page.waitForSelector("body[data-connected='3']");
    const t6a = await say("The master bath fan stopped working again.");
    await cardReady("warranty", 7);
    const w6 = (await view().locator("#rows .row").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
    const t6b = await say("Yes, book it.");
    await cardReady("warranty", 8);
    const w6b = (await view().locator("#rows .row").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
    await shot("beat-6");
    add("B12", "beat 6: warranty offer (SPEC line) and a $0.00 return visit; card shows coverage, visit, scope, 2 photos, visit log", "covered to Jan 13, 2027; Mon, Nov 16, 10:00 AM–12:00 PM $0.00; 2 photos; visit log",
      `${t6a.speech === SPEC_LINES.warranty ? "=" : "≠"} SPEC | ${w6.map((x) => x.slice(0, 48)).join(" / ")} | after yes: ${/booked/.test(w6b[1] ?? "") ? "booked" : "?"} | "${t6b.speech.slice(0, 60)}"`,
      t6a.speech === SPEC_LINES.warranty && w6.length === 5 && /Covered: 90-day labor warranty/.test(w6[0]) && /Jan 13, 2027/.test(w6[0]) && /Return visit Mon, Nov 16, 10:00 AM–12:00 PM/.test(w6[1]) && /\$0\.00/.test(w6[1]) &&
      /Original scope: 6 items/.test(w6[2]) && /2 photos/.test(w6[3]) && /Visit log Oct 15, 10:02–11:40/.test(w6[4]) && /booked/.test(w6b[1] ?? "") && t6b.tool === "warranty_callback" && (await charges()).length === ch4.length);

    // ---- cross-cutting: customer surface vs developer view ----
    const dev = await page.evaluate(() => {
      const device = document.getElementById("device")!;
      const devview = document.getElementById("devview")!;
      return {
        title: document.getElementById("devview-title")?.textContent, chipsInDev: devview.querySelectorAll(".chip").length, chipsInDevice: device.querySelectorAll(".chip, .badge").length,
        separate: !device.contains(devview) && !devview.contains(device), deviceText: device.innerText, sessionId: (window as any).__host.sessionId,
        frameLabel: document.getElementById("frame-label")?.textContent, marks: device.querySelectorAll("img, svg").length,
      };
    });
    const deviceLeak = dev.deviceText.match(TOOL_OR_ID)?.[0] ?? (dev.deviceText.includes(dev.sessionId) ? "session id" : null);
    add("B13", "developer view is separate: chips, steps, badges and session id only in 'Developer view — not shown to customers'", "title; chips in dev view; none in the device; no tool name/id/session id in the device text",
      `title="${dev.title}" chips dev=${dev.chipsInDev} device=${dev.chipsInDevice} separate=${dev.separate} leak=${deviceLeak ?? "none"}`,
      dev.title === "Developer view — not shown to customers" && dev.chipsInDev > 10 && dev.chipsInDevice === 0 && dev.separate && !deviceLeak);
    const turnsAll = (await host()).turns as { speech: string; seconds: number; tool: string | null }[];
    const lineLeaks = turnsAll.filter((t) => TOOL_OR_ID.test(t.speech)).map((t) => t.speech.match(TOOL_OR_ID)?.[0]);
    const cardLeaks = cardTexts.filter((t) => TOOL_OR_ID.test(t.split(": ").slice(1).join(": "))).map((t) => `${t.split(":")[0]}:${t.split(": ").slice(1).join(": ").match(TOOL_OR_ID)?.[0]}`);
    add("B14", "no tool name or id in any Alexa line or card text", "0 hits", `lines ${lineLeaks.length}${lineLeaks.length ? ` (${lineLeaks.join(",")})` : ""} · cards ${cardLeaks.length}${cardLeaks.length ? ` (${cardLeaks.join(",")})` : ""} over ${turnsAll.length} lines / ${cardTexts.length} cards`, lineLeaks.length === 0 && cardLeaks.length === 0);
    const b14 = turnsAll.filter((t) => BEAT_1_4.includes(t.speech));
    const budget = b14.reduce((a, t) => a + t.seconds, 0);
    add("B15", "beats 1-4 Alexa lines as played (SPEC §7.5 wording, incl. the two checkout lines) total ≤ 45 s at 2.5 words/s", "≤ 45 s over 6 lines",
      `${budget.toFixed(1)} s over ${b14.length} lines (${b14.map((t) => t.seconds).join(" + ")})`, b14.length === 6 && budget <= 45);
    add("B15b", "every Alexa line ≤ 20 s", "≤ 20 s", `longest ${Math.max(...turnsAll.map((t) => t.seconds))} s over ${turnsAll.length} lines`, Math.max(...turnsAll.map((t) => t.seconds)) <= 20);
    const brandHits = cardTexts.filter((t) => BRAND.test(t)).map((t) => `${t.split(":")[0]}:${t.match(BRAND)?.[0]}`).concat(BRAND.test(dev.deviceText) ? [`device:${dev.deviceText.match(BRAND)?.[0]}`] : []);
    add("B16", "no logos or marks; no third-party brand names on the customer surface; frame labelled", "0 img/svg, 0 brand hits, 'Echo Show 8 simulator (1280×800 frame)'",
      `marks device=${dev.marks} cards=${fits.filter((f) => f.includes("!marks")).length} · brand ${brandHits.length ? brandHits.join(",") : "0"} · label "${dev.frameLabel}"`,
      dev.marks === 0 && !fits.some((f) => f.includes("!marks")) && brandHits.length === 0 && dev.frameLabel === "Echo Show 8 simulator (1280×800 frame)");
    add("B17", "every card fits the display container", "no vertical overflow inside the card frame; frame ≤ 590 px", fits.join(" "), fits.length === 8 && fits.every((x) => !x.includes("!overflow")));
    const iso = await page.evaluate(() => {
      const f = document.querySelector("#card iframe") as HTMLIFrameElement;
      let reachable = true;
      try { reachable = !!f.contentDocument; } catch { reachable = false; }
      return { src: f.src, reachable, hostOrigin: location.origin };
    });
    add("B18", "cards are cross-origin sandboxed (host cannot read them)", "iframe origin != host origin, contentDocument null", `host=${iso.hostOrigin} iframe=${new URL(iso.src).origin} contentDocument=${iso.reachable ? "REACHABLE" : "null"}`, new URL(iso.src).origin !== iso.hostOrigin && !iso.reachable);

    // ---- Play demo (fixed pacing; fast mode for verify) ----
    await page.click("#play-demo");
    await page.waitForSelector("body[data-demo='done'], body[data-demo='failed']", { timeout: 180_000 });
    const hd = await host();
    const demoTurns = hd.turns.filter((t: any) => t.source === "demo");
    const want = [SPEC_LINES.find, SPEC_LINES.readBack, SPEC_LINES.booked, SPEC_LINES.review, SPEC_LINES.checkoutPrompt, SPEC_LINES.checkoutDone, SPEC_LINES.status, SPEC_LINES.warranty];
    const missing = want.filter((l) => !demoTurns.some((t: any) => t.speech === l));
    add("B19", "'Play demo' runs beats 1-6 end to end (voice path to checkout)", "done, 10 turns, all SPEC lines, no errors",
      `${await page.evaluate(() => document.body.dataset.demo)} turns=${demoTurns.length} [${demoTurns.map((t: any) => t.tool).join(",")}] missing=${missing.length} errors=${hd.errors.length}`,
      hd.demo.done && demoTurns.length === 10 && missing.length === 0 && hd.errors.length === 0);
    add("B20", "no console errors / page errors in host, sandbox proxy or views", "0", `${consoleErrors.length}${consoleErrors.length ? ": " + consoleErrors.join(" || ") : ""}`, consoleErrors.length === 0);
    log(`screenshots -> ${shots.join(", ")}`);
  } catch (err) {
    add("B!", "browser flow aborted", "no exception", `${String(err).slice(0, 400)} | console: ${consoleErrors.join(" || ")}`, false);
  } finally {
    await browser.close();
  }
  return rows;
}
