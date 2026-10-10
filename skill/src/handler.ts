// Alexa custom skill "proof before pay": the same demo as the Echo Show simulator, on a real device.
// The skill is a thin MCP client of the proofpay server: every intent maps to one proofpay tool, the skill
// speaks the tool's own line (content[0].text) and renders the tool's card as APL when the device has a screen.
//
// Payment belongs to Alexa+ (SPEC §7.1): this skill never collects payment, card data or a voice code. On
// "pay" it prepares the checkout session (proofpay.prepare_checkout, proven items only) and says that Alexa
// completes the checkout on the platform.
import { SkillBuilders, getIntentName, getRequestType, getSlot, getSupportedInterfaces, type HandlerInput, type RequestHandler, type ErrorHandler } from "ask-sdk-core";
import type { Response } from "ask-sdk-model";
import { aplDocument, datasourceFor, docFor, messageCard, type DocName } from "./apl.ts";
import type { Proofpay, ToolOutcome } from "./proofpay.ts";

export const TEXT = {
  welcome: "Proof Before Pay. I check a pro's license, the work and the invoice before you pay. Tell me what you need done, for example: I need a licensed electrician to replace outlets.",
  welcomeReprompt: "Tell me what you need done, for example: I need a licensed electrician.",
  help: "You can say: I need a licensed electrician. Book Bright Current. He sent the invoice. What's left with the electrician. Or: the bathroom outlet stopped working again.",
  reprompt: "What would you like to do next?",
  goodbye: "Okay. Your jobs stay saved.",
  fallback: "Sorry, I didn't get that. You can say: I need a licensed electrician, or: he sent the invoice.",
  notAvailable: "That step isn't available yet.",
  platformCheckout: "Alexa completes the checkout on the platform. I never ask for your card or your voice code here.",
  timeout: "The proof service didn't answer in time. Please try again.",
  error: "The proof service had a problem. Please try again in a moment.",
  needSearch: "I need to find pros first. Tell me what you need done.",
  unknownPro: "I didn't catch which pro. Say, for example: book Bright Current.",
  nothingToConfirm: "There's nothing waiting for a yes right now. What would you like to do?",
  noThanks: "Okay, I won't do that. What would you like to do next?",
};

const DEFAULT_JOB = "replace outlets and smoke detectors in the master bath";
/** The interaction model's warranty samples are about the bathroom outlet (no slot). */
const WARRANTY_ISSUE = "The bathroom outlet stopped working again";
const APL = "Alexa.Presentation.APL";

type Pending =
  | { kind: "offer_pro"; proId: string }
  | { kind: "book"; proId: string }
  | { kind: "cancel" }
  | { kind: "checkout" }
  | { kind: "draft" }
  | { kind: "warranty" };
type ProRef = { proId: string; businessName: string; eligible: boolean };
type Attrs = { pros?: ProRef[]; pending?: Pending | null; viewportLogged?: boolean };

export type SkillDeps = { proofpay: Proofpay; skillId?: string; log?: (msg: string, extra?: Record<string, unknown>) => void };

const escapeSsml = (s: string) => s.replace(/&/g, "and").replace(/</g, " ").replace(/>/g, " ");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !["the", "a", "an", "electric", "electrical", "pros", "llc", "inc"].includes(t));

/** Match a spoken pro name ("bright current") to a pro from the last search. */
export function resolvePro(spoken: string | undefined, pros: ProRef[]): ProRef | undefined {
  if (!spoken) return undefined;
  const want = new Set(norm(spoken));
  if (!want.size) return undefined;
  let best: { p: ProRef; score: number } | undefined;
  for (const p of pros) {
    const have = new Set(norm(p.businessName));
    const inter = [...want].filter((t) => have.has(t)).length;
    const score = inter / new Set([...want, ...have]).size;
    if (inter > 0 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p;
}

function attrs(h: HandlerInput): Attrs {
  return h.attributesManager.getSessionAttributes() as Attrs;
}
function setAttrs(h: HandlerInput, patch: Partial<Attrs>): void {
  h.attributesManager.setSessionAttributes({ ...attrs(h), ...patch });
}
const sessionKey = (h: HandlerInput) => h.requestEnvelope.session?.sessionId ?? `nosession-${h.requestEnvelope.context?.System?.device?.deviceId ?? "x"}`;
const hasScreen = (h: HandlerInput) => !!getSupportedInterfaces(h.requestEnvelope)?.[APL];

function render(h: HandlerInput, doc: DocName, datasources: Record<string, unknown>): void {
  if (!hasScreen(h)) return;
  h.responseBuilder.addDirective({
    type: `${APL}.RenderDocument`,
    token: `pbp-${doc}`,
    document: aplDocument(doc),
    datasources,
  } as any);
}

function logViewport(h: HandlerInput, log: NonNullable<SkillDeps["log"]>): void {
  const a = attrs(h);
  if (a.viewportLogged) return;
  const vp = (h.requestEnvelope.context as any)?.Viewport;
  if (vp) log("viewport", { shape: vp.shape, width: vp.pixelWidth, height: vp.pixelHeight, dpi: vp.dpi, aplVersion: getSupportedInterfaces(h.requestEnvelope)?.[APL]?.runtime?.maxVersion });
  setAttrs(h, { viewportLogged: true });
}

export function buildSkill(deps: SkillDeps) {
  const log = deps.log ?? ((m: string, x?: Record<string, unknown>) => console.log(new Date().toISOString(), "[skill]", m, x ? JSON.stringify(x) : ""));
  const pp = deps.proofpay;

  /** Speak + show one tool result. Returns the outcome so callers can update session state. */
  async function runTool(h: HandlerInput, tool: string, args: Record<string, unknown>, opts: { prefix?: string; suffix?: string; keepOpen?: boolean } = {}): Promise<{ out: ToolOutcome; response: Response }> {
    logViewport(h, log);
    const out = await pp.call(sessionKey(h), tool, args);
    const rb = h.responseBuilder;
    let speech: string;
    if (out.kind === "ok") {
      speech = [opts.prefix, out.text, opts.suffix].filter(Boolean).join(" ");
      const doc = docFor(out.structured?.view, tool);
      render(h, doc, datasourceFor(doc, out.structured));
      log("tool", { tool, ms: out.ms, isError: out.isError, view: out.structured?.view ?? null, doc });
    } else if (out.kind === "missing") {
      speech = [TEXT.notAvailable, opts.suffix].filter(Boolean).join(" ");
      render(h, "card", messageCard("Proof Before Pay", TEXT.notAvailable, "pending"));
      log("tool not available yet", { tool, available: out.available });
    } else if (out.kind === "timeout") {
      speech = TEXT.timeout;
      render(h, "card", messageCard("Proof Before Pay", TEXT.timeout, "bad"));
    } else {
      speech = TEXT.error;
      render(h, "card", messageCard("Proof Before Pay", TEXT.error, "bad"));
    }
    rb.speak(escapeSsml(speech));
    if (opts.keepOpen !== false) rb.reprompt(TEXT.reprompt);
    return { out, response: rb.getResponse() };
  }

  async function findPros(h: HandlerInput, summary: string): Promise<Response> {
    const { out, response } = await runTool(h, "find_pros", { trade: "electrician", job_summary: summary });
    if (out.kind === "ok" && !out.isError) {
      const pros: ProRef[] = (out.structured?.data?.pros ?? []).map((p: any) => ({ proId: p.proId, businessName: p.businessName, eligible: !!p.eligible }));
      const rec = out.structured?.data?.recommendedProId;
      setAttrs(h, { pros, pending: rec ? { kind: "offer_pro", proId: rec } : null });
    }
    return response;
  }

  async function bookReadBack(h: HandlerInput, proId: string): Promise<Response> {
    const { out, response } = await runTool(h, "book_job", { pro_id: proId, confirm: false });
    const ok = out.kind === "ok" && !out.isError && out.structured?.data?.needsConfirmation;
    setAttrs(h, { pending: ok ? { kind: "book", proId } : null });
    return response;
  }

  async function book(h: HandlerInput, spoken: string | undefined): Promise<Response> {
    const pros = attrs(h).pros ?? [];
    if (!pros.length) return h.responseBuilder.speak(TEXT.needSearch).reprompt(TEXT.welcomeReprompt).getResponse();
    const pro = resolvePro(spoken, pros);
    if (!pro) return h.responseBuilder.speak(TEXT.unknownPro).reprompt(TEXT.unknownPro).getResponse();
    return bookReadBack(h, pro.proId);
  }

  async function review(h: HandlerInput): Promise<Response> {
    const { out, response } = await runTool(h, "review_invoice", {});
    const payNow = out.kind === "ok" ? out.structured?.data?.plan?.payNow : 0;
    setAttrs(h, { pending: typeof payNow === "number" && payNow > 0 ? { kind: "checkout" } : null });
    return response;
  }

  async function checkout(h: HandlerInput): Promise<Response> {
    // Never pay_proven (it takes a voice code); the platform owns checkout.
    const { response } = await runTool(h, "prepare_checkout", {}, { suffix: TEXT.platformCheckout });
    setAttrs(h, { pending: null });
    return response;
  }

  async function status(h: HandlerInput): Promise<Response> {
    const { out, response } = await runTool(h, "job_status", {});
    setAttrs(h, { pending: out.kind === "ok" && out.structured?.card?.action ? { kind: "draft" } : null });
    return response;
  }

  async function draft(h: HandlerInput): Promise<Response> {
    const { response } = await runTool(h, "draft_note", {});
    setAttrs(h, { pending: null });
    return response;
  }

  async function warranty(h: HandlerInput, confirm: boolean): Promise<Response> {
    // First call names the problem (the server matches it to scope items and their photos); confirm accepts that offer.
    const { out, response } = await runTool(h, "warranty_callback", confirm ? { confirm: true } : { issue: WARRANTY_ISSUE });
    const offer = !confirm && out.kind === "ok" && !out.isError && (out.structured?.data?.needsConfirmation ?? !!out.structured?.card?.action);
    setAttrs(h, { pending: offer ? { kind: "warranty" } : null });
    return response;
  }

  async function cancelBooking(h: HandlerInput, confirm: boolean): Promise<Response> {
    const { out, response } = await runTool(h, "cancel_booking", { confirm });
    setAttrs(h, { pending: !confirm && out.kind === "ok" && out.structured?.data?.needsConfirmation ? { kind: "cancel" } : null });
    return response;
  }

  async function confirm(h: HandlerInput): Promise<Response> {
    const p = attrs(h).pending;
    if (!p) return h.responseBuilder.speak(TEXT.nothingToConfirm).reprompt(TEXT.reprompt).getResponse();
    switch (p.kind) {
      case "offer_pro": return bookReadBack(h, p.proId);
      case "book": {
        const { response } = await runTool(h, "book_job", { pro_id: p.proId, confirm: true });
        setAttrs(h, { pending: null });
        return response;
      }
      case "cancel": return cancelBooking(h, true);
      case "checkout": return checkout(h);
      case "draft": return draft(h);
      case "warranty": return warranty(h, true);
    }
  }

  const is = (type: string, intent?: string) => (h: HandlerInput) => getRequestType(h.requestEnvelope) === type && (!intent || getIntentName(h.requestEnvelope) === intent);
  const intent = (name: string, handle: (h: HandlerInput) => Promise<Response> | Response): RequestHandler => ({ canHandle: is("IntentRequest", name), handle });

  const handlers: RequestHandler[] = [
    {
      canHandle: is("LaunchRequest"),
      handle: (h) => {
        logViewport(h, log);
        render(h, "card", messageCard("Proof Before Pay", "Say what you need done, for example: I need a licensed electrician."));
        return h.responseBuilder.speak(TEXT.welcome).reprompt(TEXT.welcomeReprompt).getResponse();
      },
    },
    intent("FindProsIntent", (h) => {
      const job = getSlot(h.requestEnvelope, "job")?.value?.trim();
      return findPros(h, job && job.length >= 3 ? job : DEFAULT_JOB);
    }),
    intent("BookIntent", (h) => book(h, getSlot(h.requestEnvelope, "pro")?.value)),
    intent("ConfirmIntent", confirm),
    intent("AMAZON.YesIntent", confirm),
    intent("AMAZON.NoIntent", (h) => { setAttrs(h, { pending: null }); return h.responseBuilder.speak(TEXT.noThanks).reprompt(TEXT.reprompt).getResponse(); }),
    intent("ReviewInvoiceIntent", review),
    intent("PayProvenIntent", checkout),
    intent("StatusIntent", status),
    intent("WarrantyIntent", (h) => warranty(h, false)),
    intent("AMAZON.HelpIntent", (h) => h.responseBuilder.speak(TEXT.help).reprompt(TEXT.reprompt).getResponse()),
    {
      canHandle: (h) => getRequestType(h.requestEnvelope) === "IntentRequest" && ["AMAZON.StopIntent", "AMAZON.CancelIntent"].includes(getIntentName(h.requestEnvelope)),
      handle: async (h) => {
        await pp.endSession(sessionKey(h));
        return h.responseBuilder.speak(TEXT.goodbye).withShouldEndSession(true).getResponse();
      },
    },
    intent("AMAZON.FallbackIntent", (h) => h.responseBuilder.speak(TEXT.fallback).reprompt(TEXT.reprompt).getResponse()),
    intent("AMAZON.NavigateHomeIntent", (h) => h.responseBuilder.speak(TEXT.welcomeReprompt).reprompt(TEXT.reprompt).getResponse()),
    {
      // Touch on the APL card: the buttons send the same request a spoken line would.
      canHandle: is(`${APL}.UserEvent`),
      handle: (h) => {
        const args: string[] = ((h.requestEnvelope.request as any).arguments ?? []).map(String);
        const [what, message = ""] = args;
        if (what === "book") return book(h, message.replace(/^book\s+/i, "").replace(/\.$/, ""));
        if (what === "pay") return checkout(h);
        if (what === "draft") return draft(h);
        if (what === "confirm") return confirm(h);
        if (what === "action") {
          if (/^yes\b/i.test(message) && /draft/i.test(message)) return draft(h);
          if (/^yes\b/i.test(message)) return confirm(h);
          if (/cancel/i.test(message)) return cancelBooking(h, false);
          if (/pay/i.test(message)) return checkout(h);
        }
        return h.responseBuilder.speak(TEXT.help).reprompt(TEXT.reprompt).getResponse();
      },
    },
    {
      canHandle: is("SessionEndedRequest"),
      handle: async (h) => {
        log("session ended", { reason: (h.requestEnvelope.request as any).reason, error: (h.requestEnvelope.request as any).error });
        await pp.endSession(sessionKey(h));
        return h.responseBuilder.getResponse();
      },
    },
  ];

  const errorHandler: ErrorHandler = {
    canHandle: () => true,
    handle: (h, err) => {
      log("handler error", { error: String(err?.message ?? err), type: getRequestType(h.requestEnvelope) });
      return h.responseBuilder.speak(TEXT.error).reprompt(TEXT.reprompt).getResponse();
    },
  };

  const builder = SkillBuilders.custom().addRequestHandlers(...handlers).addErrorHandlers(errorHandler);
  if (deps.skillId) builder.withSkillId(deps.skillId);
  return builder.create();
}
