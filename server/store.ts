// Per-user state: one JSON file per user, written with an atomic rename. Survives a new MCP session
// and a server restart. All writes go through updateUser(), which is synchronous (load -> mutate ->
// save in one tick), so a webhook and a tool call in the same process cannot interleave a write.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LicenseCheck, PaymentPlan, Photo, ScopeOfWork, VisitWindow } from "../src/core/types.ts";
import type { CameraEvent, Policy, Quote } from "../src/app/services.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = () => process.env.PROOFPAY_DATA_DIR ?? join(ROOT, "data");
const usersDir = () => join(dataDir(), "users");

export type ProView = {
  proId: string;
  businessName: string;
  rating: number;
  reviewCount: number;
  estimate: number;
  license: LicenseCheck;
  eligible: boolean;
};
export type StoredEvent = CameraEvent & { receivedAt: number; signature: "verified" | "history-api" };
/** A payment completed by Alexa+ checkout (observed by reading the checkout session; the add-on never takes payment). */
export type Payment = { checkoutSessionId: string; amount: number; at: number; mode: "sandbox" };
export type Job = {
  jobId: string;
  title: string;
  summary: string;
  proId: string;
  proName: string;
  alexaBookingId: string;
  partnerBookingId: string;
  status: string; // CONFIRMED | CANCELLED
  bookedAt: number;
  cancelledAt: number | null;
  start: number;
  end: number;
  total: number;
  policies: Policy[];
  paymentInstrument: { id: string; wallet: string };
  scope: ScopeOfWork;
  licenseAtBooking: LicenseCheck;
  doorCode: { from: number; to: number; simulated: true; note: string };
  cameraEvents: StoredEvent[];
  plan: PaymentPlan | null;
  planAt: number | null;
  licenseAtReview: LicenseCheck | null; // re-checked when the invoice is reviewed
  visitAtReview: VisitWindow | null; // derived from stored camera events at review time
  photosAtReview: Photo[] | null;
  /** Checkout session prepared for the proven items (Alexa+ completes it; we only read its status). */
  checkout: { sessionId: string; planHash: string; amount: number; waits: number; preparedAt: number } | null;
  payments: Payment[];
  warranty: {
    issue: string; scopeItemIds: string[]; covered: boolean; reason: string; laborWarrantyDays: number; warrantyEnds: number;
    returnVisit: { start: number; end: number }; booked: boolean; offeredAt: number;
  } | null;
  drafts: { text: string; at: number }[];
};
export type UserState = {
  version: 1;
  userId: string;
  createdAt: number;
  profile: { zipCode: string; timeZone: string };
  doorbell: { deviceId: string; accountId: string };
  lastSearch: { at: number; summary: string; trade: string; pros: ProView[] } | null;
  pendingBooking: { quote: Quote; proName: string; title: string; summary: string; license: LicenseCheck; readBackAt: number } | null;
  pendingCancel: { jobId: string; at: number } | null;
  jobs: Job[];
  currentJobId: string | null;
};

const USER_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function fresh(userId: string): UserState {
  return {
    version: 1,
    userId,
    createdAt: Date.now(),
    profile: { zipCode: process.env.DEMO_ZIP ?? "32000", timeZone: "America/New_York" },
    // The household's linked front door camera (sandbox defaults = fixtures/demo/scenario.json).
    doorbell: { deviceId: process.env.DOORBELL_DEVICE_ID ?? "sandbox-front-door-01", accountId: process.env.DOORBELL_ACCOUNT_ID ?? "ava1.ring.account.SANDBOX01" },
    lastSearch: null,
    pendingBooking: null,
    pendingCancel: null,
    jobs: [],
    currentJobId: null,
  };
}

const fileOf = (userId: string) => {
  if (!USER_ID.test(userId)) throw new Error("invalid user id");
  return join(usersDir(), `${userId}.json`);
};

export function loadUser(userId: string): UserState {
  const f = fileOf(userId);
  if (!existsSync(f)) return fresh(userId);
  const s = JSON.parse(readFileSync(f, "utf8")) as UserState;
  if (s?.version !== 1 || s.userId !== userId || !Array.isArray(s.jobs)) throw new Error(`corrupt state file for ${userId}`);
  return s;
}

export function saveUser(s: UserState): void {
  const f = fileOf(s.userId);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}

/** Synchronous read-modify-write. Do all network I/O BEFORE calling this. */
export function updateUser<T>(userId: string, fn: (s: UserState) => T): T {
  const s = loadUser(userId);
  const out = fn(s);
  saveUser(s);
  return out;
}

export function listUserIds(): string[] {
  if (!existsSync(usersDir())) return [];
  return readdirSync(usersDir()).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => USER_ID.test(id));
}

export function currentJob(s: UserState, jobId?: string): Job | undefined {
  if (jobId) return s.jobs.find((j) => j.jobId === jobId);
  return s.jobs.find((j) => j.jobId === s.currentJobId) ?? s.jobs[s.jobs.length - 1];
}
