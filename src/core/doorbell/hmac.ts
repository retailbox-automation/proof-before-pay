// Ring webhook signatures: X-Signature: sha256=<hex HMAC-SHA256 of the raw body, key as UTF-8>.
// Verify over the raw bytes exactly as received. Never re-serialize JSON before verifying
// (whitespace and key order change the bytes). Verify first, parse second.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Signature";

export function sign(rawBody: string | Uint8Array, key: string): string {
  if (!key) throw new Error("signing key is empty");
  return `sha256=${createHmac("sha256", key).update(rawBody).digest("hex")}`;
}

/** Constant-time check. False for a missing/duplicated/malformed header or an empty key. */
export function verify(rawBody: string | Uint8Array, header: string | string[] | null | undefined, key: string): boolean {
  if (!key || typeof header !== "string") return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest();
  const received = Buffer.from(m[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
