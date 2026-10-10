// Alexa request verification for the own-HTTPS-endpoint path, per Amazon's "Host a Custom Skill as a Web
// Service" (checking the signature of the request + the timestamp):
//   1. SignatureCertChainUrl: scheme https, host s3.amazonaws.com (case-insensitive), normalized path starting
//      with /echo.api/ (case-sensitive), port 443 if a port is given.
//   2. Download the PEM chain (cached per URL). Signing (leaf) certificate: inside its validity dates and the
//      SAN contains echo-api.amazon.com. Every certificate chains to the next by signature, intermediates are
//      CAs, and the chain ends at a root in Node's trusted root store.
//   3. Signature-256 header (base64) = RSA-SHA256 over the raw request body bytes, checked with the leaf key.
//   4. request.timestamp within 150 s of now.
// Built on node:crypto X509Certificate (OpenSSL). We deliberately do not use ask-sdk-express-adapter's
// verifier: it validates chains with node-forge, which has an unfixed advisory in RSA PKCS#1 v1.5 signature
// verification (GHSA-86w9-cpqp-85rv, checked 2026-10-10).
import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import { get } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { posix } from "node:path";
import { rootCertificates } from "node:tls";

export const ECHO_DOMAIN = "echo-api.amazon.com";
export const TOLERANCE_MS = 150_000;

export class VerificationError extends Error {}

export type AlexaVerifier = (rawBody: Buffer | string, headers: IncomingHttpHeaders) => Promise<void>;

export type VerifierOptions = {
  now?: () => number;
  /** How the chain is downloaded (tests inject a local one). Default: HTTPS GET, 3 s timeout. */
  fetchChain?: (url: string) => Promise<string>;
  /** Trusted roots (PEM). Default: Node's bundled Mozilla root store (tls.rootCertificates). */
  trustedRoots?: readonly string[];
  toleranceMs?: number;
};

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Step 1. Throws VerificationError on any deviation. */
export function checkCertUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new VerificationError("cert url: not a URL"); }
  if (u.protocol !== "https:") throw new VerificationError("cert url: scheme must be https");
  if (u.hostname.toLowerCase() !== "s3.amazonaws.com") throw new VerificationError("cert url: host must be s3.amazonaws.com");
  if (u.port && u.port !== "443") throw new VerificationError("cert url: port must be 443");
  // WHATWG URL already resolves "." and ".." segments; normalize again for encoded forms.
  const path = posix.normalize(decodeURIComponent(u.pathname));
  if (!path.startsWith("/echo.api/")) throw new VerificationError("cert url: path must start with /echo.api/");
}

export function splitPem(chain: string): X509Certificate[] {
  const blocks = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new VerificationError("chain: no certificates");
  return blocks.map((b) => new X509Certificate(b));
}

const within = (c: X509Certificate, now: number) => now >= Date.parse(c.validFrom) && now <= Date.parse(c.validTo);
const issuedBy = (child: X509Certificate, parent: X509Certificate) => child.checkIssued(parent) && child.verify(parent.publicKey);

/** Step 2. Returns the leaf certificate when the chain is valid now. */
export function validateChain(pem: string, opts: { now: number; trustedRoots: readonly string[] }): X509Certificate {
  const certs = splitPem(pem);
  const leaf = certs[0];
  if (!within(leaf, opts.now)) throw new VerificationError("chain: signing certificate expired or not yet valid");
  const sans = (leaf.subjectAltName ?? "").split(",").map((s) => s.trim());
  if (!sans.includes(`DNS:${ECHO_DOMAIN}`)) throw new VerificationError(`chain: ${ECHO_DOMAIN} missing from the signing certificate SAN`);
  const roots = opts.trustedRoots.map((r) => new X509Certificate(r));
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    if (!within(c, opts.now)) throw new VerificationError(`chain: certificate ${i} expired or not yet valid`);
    if (i > 0 && !c.ca) throw new VerificationError(`chain: certificate ${i} is not a CA`);
    if (roots.some((r) => within(r, opts.now) && issuedBy(c, r))) return leaf; // reached a trusted root
    const next = certs[i + 1];
    if (!next || !issuedBy(c, next)) throw new VerificationError(`chain: certificate ${i} is not issued by the next certificate or a trusted root`);
  }
  throw new VerificationError("chain: no trusted root");
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new VerificationError(`chain: HTTP ${res.statusCode}`)); return; }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 64 * 1024) req.destroy(new VerificationError("chain: too large")); });
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new VerificationError("chain: download timeout")));
    req.on("error", reject);
  });
}

export function createAlexaVerifier(opts: VerifierOptions = {}): AlexaVerifier {
  const now = opts.now ?? Date.now;
  const fetchChain = opts.fetchChain ?? httpsGet;
  const trustedRoots = opts.trustedRoots ?? rootCertificates;
  const tolerance = Math.min(opts.toleranceMs ?? TOLERANCE_MS, TOLERANCE_MS);
  const chains = new Map<string, string>(); // url -> PEM (re-validated on every request: dates move)

  return async (rawBody, headers) => {
    const certUrl = header(headers, "SignatureCertChainUrl");
    const sig = header(headers, "Signature-256");
    if (!certUrl) throw new VerificationError("missing SignatureCertChainUrl header");
    if (!sig) throw new VerificationError("missing Signature-256 header");
    checkCertUrl(certUrl);
    let pem = chains.get(certUrl);
    if (!pem) {
      pem = await fetchChain(certUrl);
      chains.set(certUrl, pem);
    }
    const t = now();
    let leaf: X509Certificate;
    try { leaf = validateChain(pem, { now: t, trustedRoots }); } catch (e) { chains.delete(certUrl); throw e; }
    const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    if (!cryptoVerify("sha256", body, leaf.publicKey, Buffer.from(sig, "base64"))) throw new VerificationError("signature does not match the request body");

    let ts: number;
    try { ts = Date.parse(JSON.parse(body.toString("utf8"))?.request?.timestamp); } catch { throw new VerificationError("body is not JSON"); }
    if (!Number.isFinite(ts)) throw new VerificationError("request.timestamp missing");
    if (Math.abs(t - ts) > tolerance) throw new VerificationError(`request.timestamp is ${Math.round((t - ts) / 1000)} s off (max ${tolerance / 1000} s)`);
  };
}
