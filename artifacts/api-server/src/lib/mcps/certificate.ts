/**
 * certificate.ts — the signed, verifiable MCP Trust Certificate.
 *
 * A certificate is a canonical JSON payload describing an MCP's trust
 * evaluation, signed with HMAC-SHA256 over the *canonicalized* payload so that
 * any single-byte change to any field invalidates the signature. This is the
 * portable trust artifact a buyer embeds and third parties verify.
 *
 * Canonicalization: keys are sorted recursively and serialized with no
 * incidental whitespace, so signer and verifier always hash byte-identical
 * input regardless of property insertion order.
 *
 * v1 uses a symmetric HMAC key (CERT_SIGNING_SECRET). This is sufficient for a
 * first-party issuer + verifier. A v2 upgrade to Ed25519 (asymmetric) would let
 * third parties verify without holding the secret — noted in the report, out of
 * scope this phase.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TrustScoreResult } from "./trustScore.js";

const SIGNING_SECRET = process.env.CERT_SIGNING_SECRET?.trim() || "openclaw-dev-cert-secret-change-me";
const ISSUER = process.env.CERT_ISSUER?.trim() || "openclaw.ai/mcp-trust";
const CERT_SCHEMA_VERSION = "cert-v1";

export interface TrustCertificatePayload {
  schema: string;
  cert_id: string;
  issuer: string;
  slug: string;
  version: string;
  trust_score: number;
  grade: TrustScoreResult["grade"];
  axes: TrustScoreResult["axes"];
  rubric: TrustScoreResult["rubric"];
  suite_version: string;
  model_evaluated: string | null;
  eval_mode: "live" | "dry";
  n_leaked: number;
  issued_at: string;
  nonce: string;
}

export interface SignedCertificate {
  payload: TrustCertificatePayload;
  signature: string; // hex HMAC-SHA256
  algorithm: "HMAC-SHA256";
}

/** Recursively sort object keys so serialization is deterministic. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Stable string form of a payload — the exact bytes that get signed. */
export function canonicalString(payload: TrustCertificatePayload): string {
  return JSON.stringify(canonicalize(payload));
}

function sign(payload: TrustCertificatePayload): string {
  return createHmac("sha256", SIGNING_SECRET).update(canonicalString(payload)).digest("hex");
}

/**
 * Deterministic public certificate id for an (issuer, slug, version) tuple.
 * Re-certifying the same slug+version yields the SAME cert_id, so a shared
 * verify URL / embedded badge never silently breaks when the MCP is
 * re-evaluated — only the score/grade/signature inside update. Derived from an
 * HMAC of the tuple keyed by the issuer secret (stable, non-guessable, no PII).
 */
export function deterministicCertId(slug: string, version: string): string {
  const h = createHmac("sha256", SIGNING_SECRET).update(`${ISSUER}:${slug}:${version}`).digest("hex");
  return `crt_${h.slice(0, 20)}`;
}

export interface BuildCertInput {
  slug: string;
  version: string;
  trust: TrustScoreResult;
  suite_version: string;
  model_evaluated: string | null;
  eval_mode: "live" | "dry";
  n_leaked: number;
}

/**
 * Build + sign a certificate. cert_id is DETERMINISTIC per (slug, version) so
 * the public handle is stable across re-issues; the nonce + issued_at keep each
 * concrete issuance's signed bytes unique (so a re-eval produces a fresh, still
 * tamper-evident signature over the updated scores).
 */
export function issueCertificate(input: BuildCertInput): SignedCertificate {
  const payload: TrustCertificatePayload = {
    schema: CERT_SCHEMA_VERSION,
    cert_id: deterministicCertId(input.slug, input.version),
    issuer: ISSUER,
    slug: input.slug,
    version: input.version,
    trust_score: input.trust.trust_score,
    grade: input.trust.grade,
    axes: input.trust.axes,
    rubric: input.trust.rubric,
    suite_version: input.suite_version,
    model_evaluated: input.model_evaluated,
    eval_mode: input.eval_mode,
    n_leaked: input.n_leaked,
    issued_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  return { payload, signature: sign(payload), algorithm: "HMAC-SHA256" };
}

/**
 * verifyCertificate — recompute the HMAC and constant-time compare. Returns
 * false for any tampering (altered field, altered signature) or malformed
 * input. Never throws.
 */
export function verifyCertificate(payload: TrustCertificatePayload, signature: string): boolean {
  try {
    const expected = sign(payload);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge — embeddable SVG (the viral surface)
// ─────────────────────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<TrustScoreResult["grade"], string> = {
  TRUSTED: "#2e7d32", // green
  CONDITIONAL: "#ed6c02", // amber
  UNTRUSTED: "#c62828", // red
};

/** Escape text for safe SVG embedding. */
function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * renderBadgeSvg — a shields.io-style two-part badge:
 *   [ MCP Trust | <GRADE> <score> ]
 * Colorblind-safe (green/amber/red distinguished by both hue and the grade text).
 */
export function renderBadgeSvg(grade: TrustScoreResult["grade"], score: number, revoked = false): string {
  const label = "MCP Trust";
  const value = revoked ? "REVOKED" : `${grade} ${score}`;
  const color = revoked ? "#616161" : GRADE_COLOR[grade];
  const labelW = 68;
  const valueW = Math.max(78, 8 + value.length * 7);
  const totalW = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <rect width="${totalW}" height="20" rx="3" fill="#fff"/>
  <g>
    <rect width="${labelW}" height="20" rx="3" fill="#37474f"/>
    <rect x="${labelW}" width="${valueW}" height="20" rx="3" fill="${color}"/>
    <rect width="${totalW}" height="20" rx="3" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${esc(label)}</text>
    <text x="${labelW + valueW / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

export const certConstants = { CERT_SCHEMA_VERSION, ISSUER };
