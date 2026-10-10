// Test helpers: a real proofpay MCP server + sandbox services on ephemeral ports, and Alexa request envelopes.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSandbox, type RunningSandbox } from "../../src/sandbox/server.ts";
import { createServices, envFromProcess } from "../../src/app/services.ts";
import { startMcpServer, type RunningServer } from "../../server/server.ts";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export type Stack = { mcp: RunningServer; sandbox: RunningSandbox; dataDir: string; close: () => Promise<void> };

/** proofpay MCP server + sandbox (fixture registry), wired to each other, on free ports, with a temp data dir. */
export async function startStack(): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), "pbp-skill-test-"));
  process.env.PROOFPAY_DATA_DIR = dataDir; // read on every store access
  const mcpPort = await freePort();
  const sandbox = await startSandbox({ port: 0, webhookUrl: `http://127.0.0.1:${mcpPort}/webhooks/doorbell`, quiet: true });
  const services = createServices(envFromProcess({ SANDBOX_BASE: sandbox.url, REGISTRY_MODE: "fixture" }));
  const mcp = await startMcpServer({ port: mcpPort, quiet: true, services });
  return {
    mcp,
    sandbox,
    dataDir,
    close: async () => {
      await mcp.close();
      await sandbox.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

type EnvOpts = {
  type?: string;
  intent?: string;
  slots?: Record<string, string>;
  sessionId?: string;
  attributes?: Record<string, unknown>;
  apl?: boolean;
  isNew?: boolean;
  timestamp?: string;
  arguments?: string[];
  applicationId?: string;
};

export function envelope(o: EnvOpts): any {
  const type = o.type ?? "IntentRequest";
  const applicationId = o.applicationId ?? "amzn1.ask.skill.test";
  const request: any = { type, requestId: `amzn1.echo-api.request.${Math.random().toString(36).slice(2)}`, timestamp: o.timestamp ?? new Date().toISOString(), locale: "en-US" };
  if (type === "IntentRequest") {
    request.intent = { name: o.intent, confirmationStatus: "NONE", slots: Object.fromEntries(Object.entries(o.slots ?? {}).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: "NONE" }])) };
    request.dialogState = undefined;
  }
  if (type === "Alexa.Presentation.APL.UserEvent") { request.token = "pbp"; request.arguments = o.arguments ?? []; }
  if (type === "SessionEndedRequest") request.reason = "USER_INITIATED";
  const apl = o.apl !== false;
  return {
    version: "1.0",
    session: { new: o.isNew ?? false, sessionId: o.sessionId ?? "amzn1.echo-api.session.test", application: { applicationId }, attributes: o.attributes ?? {}, user: { userId: "amzn1.ask.account.test" } },
    context: {
      System: {
        application: { applicationId },
        user: { userId: "amzn1.ask.account.test" },
        device: { deviceId: "amzn1.ask.device.test", supportedInterfaces: apl ? { "Alexa.Presentation.APL": { runtime: { maxVersion: "2024.3" } } } : {} },
        apiEndpoint: "https://api.amazonalexa.com",
      },
      ...(apl ? { Viewport: { experiences: [{ arcMinuteWidth: 246, arcMinuteHeight: 144, canRotate: false, canResize: false }], shape: "RECTANGLE", pixelWidth: 1280, pixelHeight: 800, dpi: 213, currentPixelWidth: 1280, currentPixelHeight: 800 } } : {}),
    },
    request,
  };
}

export const ssml = (r: any): string => r.response?.outputSpeech?.ssml ?? "";
export const speech = (r: any): string => ssml(r).replace(/^<speak>/, "").replace(/<\/speak>$/, "");
export const apl = (r: any): any => (r.response?.directives ?? []).find((d: any) => d.type === "Alexa.Presentation.APL.RenderDocument");
