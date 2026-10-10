// POST /webhooks/doorbell — front door camera events (Ring Partner API v1.1 webhook format).
// 1. Read the RAW body and verify X-Signature (HMAC-SHA256) over those exact bytes. Bad -> 401, nothing stored.
// 2. Keep only arrive/leave-relevant fields (ids + timestamps). No video, no faces, no recognition.
// 3. Attach an event only to a confirmed job of the household that owns the device, inside the booking
//    window (60 min before start .. 120 min after end), and only when both sides consented to visit logging.
//    Anything else is dropped, not stored (data is kept for the job only).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../src/app/services.ts";
import { listUserIds, loadUser, updateUser } from "./store.ts";

const MAX_BODY = 64 * 1024;

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export type WebhookStats = { received: number; rejected: number; stored: number; dropped: number };

export async function handleDoorbellWebhook(req: IncomingMessage, res: ServerResponse, services: Services, stats: WebhookStats, log: (...a: unknown[]) => void): Promise<void> {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); json(res, 405, { error: "method not allowed" }); return; }
  let raw: Buffer;
  try { raw = await readRaw(req); } catch (e) { json(res, (e as { status?: number }).status ?? 400, { error: String((e as Error).message) }); return; }
  stats.received++;
  const sig = req.headers["x-signature"];
  if (!services.verifyWebhook(raw, Array.isArray(sig) ? sig[0] : sig)) {
    stats.rejected++;
    log("webhook rejected: bad or missing X-Signature (nothing stored)");
    json(res, 401, { error: "invalid signature" });
    return;
  }
  let events;
  try { events = services.parseWebhook(raw); } catch { json(res, 400, { error: "invalid JSON" }); return; }
  let stored = 0, dropped = 0;
  for (const ev of events) {
    let attached = false;
    for (const uid of listUserIds()) {
      const s = loadUser(uid);
      if (s.doorbell.deviceId !== ev.deviceId || (ev.accountId && s.doorbell.accountId !== ev.accountId)) continue;
      const match = s.jobs.find((j) => j.status === "CONFIRMED" && j.scope.visitLoggingConsent.granted && ev.at >= j.start - 60 * 60_000 && ev.at <= j.end + 120 * 60_000);
      if (!match) continue;
      attached = updateUser(uid, (st) => {
        const j = st.jobs.find((x) => x.jobId === match.jobId)!;
        if (j.cameraEvents.some((e) => e.id === ev.id)) return true; // duplicate delivery: already stored
        j.cameraEvents.push({ ...ev, receivedAt: Date.now(), signature: "verified" });
        return true;
      }) || attached;
    }
    if (attached) stored++; else dropped++;
  }
  stats.stored += stored;
  stats.dropped += dropped;
  log(`webhook ok: ${events.length} event(s), ${stored} attached, ${dropped} dropped (no consented job in window)`);
  json(res, 200, { ok: true, stored, dropped });
}
