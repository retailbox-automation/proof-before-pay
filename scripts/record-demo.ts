// Records the scripted demo ("Play demo") as a silent screen capture for the video edit.
// Needs `npm run demo` running. Output: docs/video/proof-before-pay-silent.webm (+ .mp4 if ffmpeg exists)
// and a subtitle file with Alexa's lines and their on-screen times.
//   node scripts/record-demo.ts [--host http://127.0.0.1:5178/]
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "..", "..", "docs", "video");
const host = process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] : "http://127.0.0.1:5178/";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: OUT, size: { width: 1920, height: 1200 } } });
const page = await context.newPage();
const t0 = Date.now();
const cues: { at: number; text: string }[] = [];
await page.exposeFunction("__cue", (text: string) => cues.push({ at: Date.now() - t0, text }));
await page.goto(host, { waitUntil: "load" });
await page.waitForSelector("body[data-connected]", { timeout: 30_000 });
// Watch the subtitle bar: every new Alexa line becomes a subtitle cue.
await page.evaluate(() => {
  const target = document.querySelector("#subtitles") ?? document.body;
  let last = "";
  new MutationObserver(() => {
    const el = document.querySelector("#sub-alexa");
    const text = (el?.textContent ?? "").trim();
    if (text && text !== last) { last = text; (window as unknown as { __cue: (t: string) => void }).__cue(text); }
  }).observe(target, { subtree: true, childList: true, characterData: true });
});
await page.waitForTimeout(1500);
await page.click("#play-demo");
await page.waitForFunction(() => ["done", "failed"].includes(document.body.dataset.demo ?? ""), undefined, { timeout: 10 * 60_000, polling: 500 });
const status = await page.evaluate(() => document.body.dataset.demo);
await page.waitForTimeout(2500);
const video = page.video();
await context.close();
await browser.close();
const webm = join(OUT, "proof-before-pay-silent.webm");
if (video) renameSync(await video.path(), webm);

const srtTime = (ms: number) => {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
};
const srt = cues.map((c, i) => {
  const end = i + 1 < cues.length ? cues[i + 1].at - 100 : c.at + 6000;
  return `${i + 1}\n${srtTime(c.at)} --> ${srtTime(Math.max(end, c.at + 1500))}\nAlexa (simulated): ${c.text}\n`;
}).join("\n");
writeFileSync(join(OUT, "proof-before-pay-alexa-lines.srt"), srt);

const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-r", "30", join(OUT, "proof-before-pay-silent.mp4")], { encoding: "utf8" });
const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", webm], { encoding: "utf8" }).stdout.trim();
console.log(`demo=${status} cues=${cues.length} duration=${dur}s webm=${webm} mp4=${ff.status === 0 ? "ok" : `failed: ${ff.stderr}`}`);
process.exit(status === "done" ? 0 : 1);
