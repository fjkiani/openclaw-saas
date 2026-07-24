/**
 * certifyClient.ts — thin typed SDK for the MCP Trust Certification API.
 *
 * This is the "add a few lines, get a governed certificate" surface. It wraps
 * apiFetch (which prepends VITE_API_URL + auth) with typed methods that mirror
 * the /api/v1/certify/* endpoints. The same shapes back the /certify FE flow
 * and are the documented REST contract a buyer integrates against.
 *
 * A published standalone `@openclaw/certify-sdk` npm package is a documented
 * fast-follow; this client is the in-repo reference implementation.
 */

import { apiFetch } from "./apiFetch";

export type TrustGrade = "TRUSTED" | "CONDITIONAL" | "UNTRUSTED";

export interface TrustAxis {
  score: number;
  weight: number;
  evidence: "live" | "static" | "recorded" | "insufficient" | "dry";
  reasons: string[];
}

export interface TrustCertificatePayload {
  schema: string;
  cert_id: string;
  issuer: string;
  slug: string;
  version: string;
  trust_score: number;
  grade: TrustGrade;
  axes: {
    behavioral_safety: TrustAxis;
    capability_containment: TrustAxis;
    track_record: TrustAxis;
  };
  rubric: { w_behavior: number; w_containment: number; w_record: number };
  suite_version: string;
  model_evaluated: string | null;
  eval_mode: "live" | "dry";
  n_leaked: number;
  issued_at: string;
  nonce: string;
}

export interface SignedCertificate {
  payload: TrustCertificatePayload;
  signature: string;
  algorithm: "HMAC-SHA256";
}

export interface EvalItem {
  id: string;
  category: string;
  status: "blocked" | "leaked" | "partial";
  reason: string;
  prompt: string;
  response_excerpt?: string;
  latency_ms?: number;
}

export interface EvalReportSummary {
  mode: "live" | "dry";
  degraded_reason: string | null;
  n_blocked: number;
  n_leaked: number;
  n_partial: number;
  safety_score: number;
  overall_grade: "SAFE" | "PARTIAL" | "UNSAFE";
  category_breakdown: Record<string, { blocked: number; leaked: number; partial: number }>;
  items: EvalItem[];
}

export interface IssueResponse {
  ok: boolean;
  certificate: SignedCertificate;
  persisted: boolean;
  eval_report: EvalReportSummary;
  error?: string;
}

export interface StoredCertificate {
  cert_id: string;
  slug: string;
  version: string;
  trust_score: number;
  grade: TrustGrade;
  eval_mode: string;
  model_evaluated: string | null;
  suite_version: string;
  n_leaked: number;
  axes: TrustCertificatePayload["axes"];
  payload: TrustCertificatePayload;
  signature: string;
  algorithm: string;
  issued_at: string;
  revoked_at: string | null;
}

export interface VerifyResponse {
  ok: boolean;
  valid: boolean;
  signature_valid?: boolean;
  revoked?: boolean;
  cert_id?: string;
  slug?: string;
  version?: string;
  grade?: TrustGrade;
  trust_score?: number;
  eval_mode?: string;
  issued_at?: string;
  revoked_at?: string | null;
  error?: string;
}

export interface LeaderboardRow {
  slug: string;
  version: string;
  cert_id: string;
  trust_score: number;
  grade: TrustGrade;
  eval_mode: string;
  model_evaluated: string | null;
  revoked: boolean;
  issued_at: string;
}

const BASE = "/api/v1/certify";

function adminHeaders(): Record<string, string> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("openclaw-admin-token") : null;
  return token ? { "x-openclaw-admin-token": token } : {};
}

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T;
  return data;
}

export const certifyClient = {
  /** Run behavioral eval + issue a signed certificate (admin). */
  async certify(slug: string, opts: { dry?: boolean } = {}): Promise<IssueResponse> {
    const q = opts.dry ? "?dry=1" : "";
    const res = await apiFetch(`${BASE}/${encodeURIComponent(slug)}${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({}),
    });
    return json<IssueResponse>(res);
  },

  /** Latest certificate for an MCP slug. */
  async getBySlug(slug: string): Promise<{ ok: boolean; certificate?: StoredCertificate; error?: string }> {
    const res = await apiFetch(`${BASE}/mcp/${encodeURIComponent(slug)}`);
    return json(res);
  },

  /** A certificate by its public cert_id. */
  async getCertificate(certId: string): Promise<{ ok: boolean; certificate?: StoredCertificate; error?: string }> {
    const res = await apiFetch(`${BASE}/cert/${encodeURIComponent(certId)}`);
    return json(res);
  },

  /** Verify a certificate by id (server recomputes the HMAC). */
  async verify(certId: string): Promise<VerifyResponse> {
    const res = await apiFetch(`${BASE}/cert/${encodeURIComponent(certId)}/verify`);
    return json<VerifyResponse>(res);
  },

  /** Verify a payload+signature offline (a downloaded certificate JSON). */
  async verifyPayload(payload: TrustCertificatePayload, signature: string): Promise<VerifyResponse> {
    const res = await apiFetch(`${BASE}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });
    return json<VerifyResponse>(res);
  },

  /** Embeddable SVG badge URL for a certificate. */
  badgeUrl(certId: string): string {
    const apiBase = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
    return `${apiBase}${BASE}/cert/${encodeURIComponent(certId)}/badge.svg`;
  },

  /** Certified MCPs ranked by trust score. */
  async leaderboard(limit = 100): Promise<{ ok: boolean; count: number; leaderboard: LeaderboardRow[] }> {
    const res = await apiFetch(`${BASE}/leaderboard?limit=${limit}`);
    return json(res);
  },

  /** Revoke a certificate (admin). */
  async revoke(certId: string): Promise<{ ok: boolean; revoked?: boolean; error?: string }> {
    const res = await apiFetch(`${BASE}/cert/${encodeURIComponent(certId)}/revoke`, {
      method: "POST",
      headers: adminHeaders(),
    });
    return json(res);
  },
};
