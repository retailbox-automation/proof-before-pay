// Shared contracts for Proof Before Pay. Pure data types only: no I/O here.
// Every money amount is integer US cents. Every timestamp is epoch milliseconds (UTC).

/** Where a fact came from. Shown on cards and chips so every conclusion has a visible source. */
export type SourceMode = "live" | "fixture" | "sandbox" | "simulated";
export interface Source {
  service: string; // e.g. "Florida DBPR license search", "Front door camera (Ring Partner API format)"
  mode: SourceMode;
  ref?: string; // URL, event id, booking id, photo id
  asOf?: string; // registry "current as of" text, or ISO time of the check
}

// ---------- License registry ----------
export interface LicenseRecord {
  licenseNumber: string; // as printed by the registry, e.g. "EC13001234"
  licenseType: string; // e.g. "Certified Electrical Contractor"
  names: { name: string; nameType: string }[]; // nameType: "Primary" | "DBA" | ...
  status: string; // e.g. "Current, Active"
  expires: string | null; // "MM/DD/YYYY"
}
export interface LicenseCheck {
  query: string; // license number we looked up
  found: boolean;
  records: LicenseRecord[];
  active: boolean; // found AND some record status contains "Active" AND not expired at check time
  claimedName: string; // business name the pro claims on the marketplace
  nameMatch: "match" | "partial" | "mismatch" | "n/a"; // claimedName vs registry names (deterministic)
  verdict: "verified" | "not_found" | "inactive" | "name_mismatch" | "unavailable"; // unavailable = registry did not answer; never treated as verified
  source: Source;
}

// ---------- Marketplace (Alexa+ Home Services SPI shapes, sandbox) ----------
export type ChargeCategory = "SERVICE" | "MATERIAL" | "LABOR" | "TAX" | "FEE" | "OTHER";
export interface Charge {
  chargeDescription: string;
  chargeCategory: ChargeCategory;
  amount: number; // cents
  scopeItemId?: string; // set when the pro links the line to a scope item
  quantity?: number;
}
export type BookingStatus = "PENDING" | "CONFIRMED" | "IN_PROGRESS" | "COMPLETED" | "ASSIGNED" | "CANCELLED" | "RESCHEDULED";
export interface Professional {
  proId: string;
  businessName: string; // fictional
  trade: string;
  rating: number;
  reviewCount: number;
  costEstimate: number; // cents
  claimedLicense: string; // number shown on the marketplace profile
}

// ---------- Scope of work ----------
export type ProofKind = "photo" | "visit";
export interface ScopeItem {
  id: string; // "S1".."S6"
  description: string;
  quantity: number;
  price: number; // cents, line total
  proof: ProofKind[]; // what proves this item is done
}
export interface ScopeOfWork {
  jobId: string;
  proId: string;
  items: ScopeItem[];
  permit: "not_needed" | "required";
  visitLoggingConsent: { granted: boolean; byPro: boolean; byHomeowner: boolean; at: number | null; source: Source };
}

// ---------- Evidence ----------
export interface Photo {
  photoId: string;
  scopeItemId: string | null; // pro tags each photo with the item it proves
  takenAt: number;
  source: Source;
}
export interface VisitWindow {
  arrivedAt: number | null;
  leftAt: number | null;
  eventIds: string[];
  source: Source; // camera events; arrive/leave only, no video kept
}
export interface Evidence {
  license: LicenseCheck;
  visit: VisitWindow;
  photos: Photo[];
}

// ---------- Reconciliation (deterministic) ----------
export type LineVerdict =
  | { kind: "proven"; scopeItemId: string; reasons: string[] }
  | { kind: "unproven"; scopeItemId: string; reasons: string[] } // in scope, proof missing or invalid
  | { kind: "not_in_scope"; reasons: string[] }
  | { kind: "over_scope"; scopeItemId: string; reasons: string[] }; // amount or quantity above scope
export interface LineResult {
  line: Charge;
  verdict: LineVerdict;
  payNow: number; // cents
  waits: number; // cents
}
export interface PaymentPlan {
  jobId: string;
  invoiceTotal: number;
  payNow: number;
  waits: number;
  lines: LineResult[];
  blockers: string[]; // job-level gates that stop all payment (e.g. license not verified, no visit)
  notConfirmed: string[]; // plain-language list of what could not be proven (always shown)
  engine: "reconcile-v1"; // deterministic rules, no model
}
