// Sandbox services for Proof Before Pay (SPEC 3.4). Everything here is simulated; nothing touches a real
// marketplace, camera, lock or card.
//   /spi/*   marketplace in Home Services SPI shapes: ListProfessionals, CreateBooking (ESTIMATE|CONFIRMATION),
//            GetBooking, CancelBooking, invoice/:partnerBookingId, photos/:partnerBookingId, capture (partial)
//   /ring/*  Ring Partner API simulator: GET /ring/v1/history/devices/:id/events (Authorization: Bearer sandbox)
//   /sim/*   GET clock, POST advance { to } (emits due camera webhooks, signed), POST reset { scenario }, GET webhooks
//
// Run: node src/sandbox/server.ts
//   SANDBOX_PORT       default 8791
//   ADDON_WEBHOOK_URL  default http://127.0.0.1:8787/webhooks/doorbell ("" disables delivery)
//   RING_SIGNING_KEY   default "sandbox-signing-key" (a literal sandbox value, not a secret)
//   SANDBOX_SCENARIO   default "demo" (fixtures/demo/scenario.json)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { sign, SIGNATURE_HEADER } from "../core/doorbell/hmac.ts";
import { timestampReadable, type RingWebhook } from "../core/doorbell/ring-format.ts";
import { loadScenario } from "./scenario.ts";
import { SandboxError, SandboxState } from "./state.ts";

export const DEFAULT_SANDBOX_PORT = 8791;
export const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:8787/webhooks/doorbell";
export const SANDBOX_SIGNING_KEY = "sandbox-signing-key";
export const RING_SANDBOX_TOKEN = "sandbox";
const DEFAULT_CORS = ["http://127.0.0.1:5178", "http://localhost:5178"];
const WEBHOOK_TIMEOUT_MS = 5_000; // Ring treats slower endpoints as failed

export interface SandboxOptions {
  port?: number; // 0 = ephemeral
  scenario?: string;
  webhookUrl?: string; // "" = do not deliver
  signingKey?: string;
  corsOrigins?: string[];
  quiet?: boolean;
}

export interface Delivery {
  id: string;
  type: RingWebhook["data"]["type"];
  subType: string | null;
  timestamp: number;
  requestId: string;
  url: string | null;
  delivered: boolean;
  status: number | null;
  error: string | null;
}

export interface RunningSandbox {
  url: string;
  port: number;
  state: SandboxState;
  deliveries: () => Delivery[];
  close: () => Promise<void>;
}

// ---------- request schemas ----------
const slot = z.object({ start: z.number().int(), end: z.number().int() });
const schemas = {
  list: z.looseObject({ trade: z.string().optional(), serviceDescription: z.string().optional(), postalCode: z.string().optional() }),
  create: z.object({
    stage: z.enum(["ESTIMATE", "CONFIRMATION"]),
    alexaBookingId: z.string().min(1).max(100),
    proId: z.string().optional(),
    partnerBookingId: z.string().optional(),
    timeSlot: slot.optional(),
    homeownerConsentToVisitLogging: z.boolean().optional(),
  }),
  byId: z.object({ partnerBookingId: z.string().min(1) }),
  capture: z.object({ partnerBookingId: z.string().min(1), amount: z.number(), idempotencyKey: z.string().min(1).max(100).optional() }),
  advance: z.object({ to: z.union([z.number().int(), z.string().min(1)]) }),
  reset: z.object({ scenario: z.string().optional() }),
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 100_000) throw new SandboxError(413, "too_large", "body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new SandboxError(400, "bad_json", "body is not valid JSON"); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new SandboxError(400, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startSandbox(opts: SandboxOptions = {}): Promise<RunningSandbox> {
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log("[sandbox]", ...a); };
  const signingKey = opts.signingKey ?? SANDBOX_SIGNING_KEY;
  const webhookUrl = opts.webhookUrl ?? DEFAULT_WEBHOOK_URL;
  const cors = new Set(opts.corsOrigins ?? DEFAULT_CORS);
  let state = new SandboxState(loadScenario(opts.scenario ?? "demo"));
  let deliveries: Delivery[] = [];
  // /sim/advance and /sim/reset run one at a time so webhooks never interleave.
  let simChain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = simChain.then(fn, fn);
    simChain = run.catch(() => undefined);
    return run;
  };

  async function deliver(w: RingWebhook): Promise<Delivery> {
    const sub = w.data.type === "motion_detected" ? w.data.attributes.sub_type : null;
    const d: Delivery = { id: w.data.id, type: w.data.type, subType: sub, timestamp: w.data.attributes.timestamp, requestId: w.meta.request_id, url: webhookUrl || null, delivered: false, status: null, error: null };
    if (!webhookUrl) { d.error = "delivery disabled (ADDON_WEBHOOK_URL is empty)"; return d; }
    const body = JSON.stringify(w);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: sign(body, signingKey) },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      d.status = res.status;
      d.delivered = res.ok;
      if (!res.ok) d.error = `HTTP ${res.status}`;
    } catch (err) {
      d.error = err instanceof Error ? err.message : String(err);
    }
    return d;
  }

  const clockView = () => ({
    scenario: state.scenario.id,
    timeZone: state.scenario.timeZone,
    now: state.now,
    nowIso: new Date(state.now).toISOString(),
    nowLocal: timestampReadable(state.now, state.scenario.timeZone),
    demoAdvanceTo: state.scenario.clock.demoAdvanceTo,
    demoAdvanceToLocal: timestampReadable(state.scenario.clock.demoAdvanceTo, state.scenario.timeZone),
    bookings: state.bookings().map((b) => ({ partnerBookingId: b.partnerBookingId, proId: b.proId, status: b.status })),
  });

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (p === "/healthz") return send(res, 200, { ok: true, scenario: state.scenario.id, now: state.now });

    // ---------- marketplace ----------
    if (p === "/spi/ListProfessionals" && m === "POST") {
      const body = parse(schemas.list, await readBody(req));
      return send(res, 200, { professionals: state.listProfessionals({ trade: body.trade }) });
    }
    if (p === "/spi/CreateBooking" && m === "POST") {
      const body = parse(schemas.create, await readBody(req));
      if (body.stage === "ESTIMATE" && !body.proId) throw new SandboxError(400, "bad_request", "proId is required for ESTIMATE");
      if (body.stage === "CONFIRMATION" && !body.partnerBookingId) throw new SandboxError(400, "bad_request", "partnerBookingId is required for CONFIRMATION");
      return send(res, 200, { booking: state.createBooking(body) });
    }
    if (p === "/spi/GetBooking" && (m === "POST" || m === "GET")) {
      const body = m === "GET" ? { partnerBookingId: url.searchParams.get("partnerBookingId") ?? "" } : await readBody(req);
      return send(res, 200, { booking: state.getBooking(parse(schemas.byId, body).partnerBookingId) });
    }
    if (p === "/spi/CancelBooking" && m === "POST") {
      return send(res, 200, { booking: state.cancelBooking(parse(schemas.byId, await readBody(req)).partnerBookingId) });
    }
    let match = /^\/spi\/invoice\/([A-Za-z0-9-]+)$/.exec(p);
    if (match && m === "GET") return send(res, 200, { invoice: state.invoice(match[1]) });
    match = /^\/spi\/photos\/([A-Za-z0-9-]+)$/.exec(p);
    if (match && m === "GET") return send(res, 200, { partnerBookingId: match[1], photos: state.photos(match[1]) });
    if (p === "/spi/capture" && m === "POST") {
      return send(res, 200, { capture: state.capture(parse(schemas.capture, await readBody(req))) });
    }

    // ---------- Ring simulator ----------
    match = /^\/ring\/v1\/history\/devices\/([^/]+)\/events$/.exec(p);
    if (match && m === "GET") {
      if (req.headers.authorization !== `Bearer ${RING_SANDBOX_TOKEN}`) throw new SandboxError(401, "unauthorized", "Authorization: Bearer sandbox required");
      const page = state.history(decodeURIComponent(match[1]), { eventTypes: url.searchParams.get("event_types") ?? undefined, pageKey: url.searchParams.get("page[key]") ?? undefined });
      return send(res, 200, page);
    }

    // ---------- simulation control ----------
    if (p === "/sim/clock" && m === "GET") return send(res, 200, clockView());
    if (p === "/sim/webhooks" && m === "GET") return send(res, 200, { deliveries });
    if (p === "/sim/advance" && m === "POST") {
      const body = parse(schemas.advance, await readBody(req));
      const out = await exclusive(async () => {
        const to = typeof body.to === "number" ? body.to : body.to === "demo" ? state.scenario.clock.demoAdvanceTo : Date.parse(body.to);
        if (Number.isNaN(to)) throw new SandboxError(400, "bad_time", "to must be epoch milliseconds, an ISO time, or \"demo\"");
        const due = state.advance(to);
        const emitted: Delivery[] = [];
        for (const w of due) emitted.push(await deliver(w)); // in time order, one at a time
        deliveries = [...deliveries, ...emitted];
        log(`clock -> ${new Date(to).toISOString()}, ${emitted.length} webhook(s), ${emitted.filter((d) => d.delivered).length} delivered`);
        const active = state.bookings().find((b) => b.stage === "CONFIRMATION" && b.status !== "CANCELLED");
        let invoiceVisible = false;
        let photosVisible = 0;
        if (active) {
          photosVisible = state.photos(active.partnerBookingId).length;
          try { state.invoice(active.partnerBookingId); invoiceVisible = true; } catch { invoiceVisible = false; }
        }
        return { ...clockView(), emitted, invoiceVisible, photosVisible };
      });
      return send(res, 200, out);
    }
    if (p === "/sim/reset" && m === "POST") {
      const body = parse(schemas.reset, await readBody(req));
      await exclusive(async () => {
        const name = body.scenario ?? "demo";
        try { state = new SandboxState(loadScenario(name)); } catch (err) { throw new SandboxError(400, "unknown_scenario", err instanceof Error ? err.message : String(err)); }
        deliveries = [];
      });
      log(`reset to scenario ${state.scenario.id}`);
      return send(res, 200, clockView());
    }
    throw new SandboxError(404, "not_found", `no route ${m} ${p}`);
  }

  const http: Server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    try {
      await route(req, res, new URL(req.url ?? "/", "http://127.0.0.1"));
    } catch (err) {
      if (err instanceof SandboxError) { send(res, err.status, { error: { code: err.code, message: err.message } }); return; }
      console.error("[sandbox] error:", err);
      if (!res.headersSent) send(res, 500, { error: { code: "internal", message: "internal error" } });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? DEFAULT_SANDBOX_PORT, "127.0.0.1", () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? DEFAULT_SANDBOX_PORT;
  log(`sandbox on http://127.0.0.1:${port} (scenario ${state.scenario.id}, webhooks -> ${webhookUrl || "disabled"})`);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get state() { return state; },
    deliveries: () => [...deliveries],
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

if (import.meta.main) {
  const env = process.env;
  const running = await startSandbox({
    port: env.SANDBOX_PORT ? Number(env.SANDBOX_PORT) : DEFAULT_SANDBOX_PORT,
    webhookUrl: env.ADDON_WEBHOOK_URL ?? DEFAULT_WEBHOOK_URL,
    signingKey: env.RING_SIGNING_KEY || SANDBOX_SIGNING_KEY,
    scenario: env.SANDBOX_SCENARIO || "demo",
  });
  const shutdown = () => { running.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
