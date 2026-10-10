// Headless-browser checks (B*): the host page talks to the MCP server live and renders the MCP App card.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Row } from "./protocol.ts";

export async function runBrowserChecks(hostUrl: string, screenshotPath: string, log: (s: string) => void): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (id: string, check: string, expected: string, actual: string, pass: boolean) => {
    rows.push({ id, check, expected, actual, pass });
    log(`${pass ? "PASS" : "FAIL"} ${id} ${check} :: ${actual}`);
  };
  const user = `web-${Date.now()}`;
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 760 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.setDefaultTimeout(15_000);

    await page.goto(`${hostUrl}?user=${user}`);
    await page.waitForSelector("body[data-connected='1']");
    const s1 = await page.evaluate(() => (window as any).__spike);
    add("B1", "host page connects live (browser StreamableHTTPClientTransport)", `protocol "2025-11-25", session id, 3 tools`,
      `protocol=${s1.protocolVersion} session=${String(s1.sessionId).slice(0, 8)}... tools=${s1.tools.join(",")}`,
      s1.protocolVersion === "2025-11-25" && /^[0-9a-f-]{36}$/.test(s1.sessionId) && s1.tools.length === 3);

    // Type like a user: real key presses, Enter submits the form.
    await page.click("#utterance");
    await page.keyboard.type("remember buy milk");
    await page.keyboard.press("Enter");
    const saved = page.locator("#transcript p.assistant", { hasText: "Saved." });
    await saved.waitFor();
    add("B2", "utterance 'remember buy milk' -> remember tool", "assistant line 'Saved.'", (await saved.first().textContent()) ?? "", true);

    await page.click("#utterance");
    await page.keyboard.type("show my card");
    await page.keyboard.press("Enter");
    const outer = page.frameLocator("#card iframe");
    const inner = outer.frameLocator("iframe");
    const item = inner.locator("#notes li", { hasText: "buy milk" });
    await item.waitFor();
    const roundtrip = inner.locator("#status[data-roundtrip='ok']");
    await roundtrip.waitFor();
    add("B3", "utterance 'show my card' renders MCP App card in sandboxed iframe", `inner iframe contains "buy milk"`,
      `card items=${JSON.stringify(await inner.locator("#notes li").allTextContents())}`, true);
    add("B4", "View -> AppBridge -> MCP server tools/call (recall from inside the card)", "status 'roundtrip OK'",
      (await roundtrip.textContent()) ?? "", true);

    // Isolation evidence: the card lives on another origin and the host cannot reach into it.
    const iso = await page.evaluate(() => {
      const f = document.querySelector("#card iframe") as HTMLIFrameElement;
      let reachable = true;
      try { reachable = !!f.contentDocument; } catch { reachable = false; }
      return { src: f.src, sandbox: f.getAttribute("sandbox"), reachable, hostOrigin: location.origin };
    });
    add("B5", "card is cross-origin sandboxed (host cannot read it)", "iframe origin != host origin, contentDocument null",
      `host=${iso.hostOrigin} iframe=${new URL(iso.src).origin} sandbox="${iso.sandbox}" contentDocument=${iso.reachable ? "REACHABLE" : "null"}`,
      new URL(iso.src).origin !== iso.hostOrigin && !iso.reachable);

    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log(`screenshot -> ${screenshotPath}`);

    // New MCP session from the host, then the card again: state must survive.
    const sidBefore = s1.sessionId;
    await page.click("#new-session");
    await page.waitForSelector("body[data-connected='2']");
    await page.click("#utterance");
    await page.keyboard.type("show my card");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#card iframe[data-rendered='2']");
    const s2 = await page.evaluate(() => (window as any).__spike);
    const items2 = await page.frameLocator("#card iframe").frameLocator("iframe").locator("#notes li").allTextContents();
    add("B6", "host 'New session' (DELETE + re-initialize) then card again", "new session id, card still has 'buy milk'",
      `sid ${String(sidBefore).slice(0, 8)}... -> ${String(s2.sessionId).slice(0, 8)}... items=${JSON.stringify(items2)}`,
      s2.sessionId !== sidBefore && items2.includes("buy milk"));

    add("B7", "no console errors / page errors in host, sandbox or view", "0", `${consoleErrors.length}${consoleErrors.length ? ": " + consoleErrors.join(" || ") : ""}`, consoleErrors.length === 0);
  } catch (err) {
    add("B!", "browser flow aborted", "no exception", `${String(err).slice(0, 300)} | console: ${consoleErrors.join(" || ")}`, false);
  } finally {
    await browser.close();
  }
  return rows;
}
