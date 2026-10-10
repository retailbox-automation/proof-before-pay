// Lambda-style entry (Alexa-hosted skill or own AWS Lambda): exports `handler(event, context)`.
// Alexa-hosted and Lambda verify the caller themselves (no signature check needed here).
// Env: MCP_URL (public URL of the proofpay /mcp endpoint), PBP_TOKEN, ALEXA_SKILL_ID, MCP_TIMEOUT_MS.
import { buildSkill } from "./handler.ts";
import { createProofpay } from "./proofpay.ts";

const e = process.env;
const skill = buildSkill({
  proofpay: createProofpay({ url: e.MCP_URL ?? "http://127.0.0.1:8787/mcp", token: e.PBP_TOKEN ?? "pbp-sandbox-echo-demo", timeoutMs: Number(e.MCP_TIMEOUT_MS ?? 6000) }),
  skillId: e.ALEXA_SKILL_ID || undefined,
});

export const handler = (event: any, context?: any) => skill.invoke(event, context);
