/**
 * certStore.ts — persistence for signed MCP Trust Certificates.
 *
 * Writes/reads REAL rows in zie_mcp_certificates (migration 0019). One logical
 * certificate per (slug, version): re-certifying the same version UPSERTs in
 * place (stable within a version, no duplicate rows). cert_id is the public,
 * globally-unique verification handle.
 *
 * All functions are defensive: a DB failure returns null / [] and logs, so a
 * downed database degrades the certification surface rather than crashing it.
 */

import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import type { SignedCertificate, TrustCertificatePayload } from "./certificate.js";

export interface StoredCertificate {
  cert_id: string;
  slug: string;
  version: string;
  trust_score: number;
  grade: string;
  eval_mode: string;
  model_evaluated: string | null;
  suite_version: string;
  n_leaked: number;
  axes: unknown;
  payload: TrustCertificatePayload;
  signature: string;
  algorithm: string;
  issued_at: string;
  revoked_at: string | null;
}

function rowToStored(r: Record<string, unknown>): StoredCertificate {
  return {
    cert_id: String(r.cert_id),
    slug: String(r.slug),
    version: String(r.version),
    trust_score: Number(r.trust_score),
    grade: String(r.grade),
    eval_mode: String(r.eval_mode),
    model_evaluated: r.model_evaluated == null ? null : String(r.model_evaluated),
    suite_version: String(r.suite_version),
    n_leaked: Number(r.n_leaked ?? 0),
    axes: r.axes ?? {},
    payload: (r.payload ?? {}) as TrustCertificatePayload,
    signature: String(r.signature),
    algorithm: String(r.algorithm ?? "HMAC-SHA256"),
    issued_at: r.issued_at instanceof Date ? r.issued_at.toISOString() : String(r.issued_at),
    revoked_at: r.revoked_at == null ? null : r.revoked_at instanceof Date ? r.revoked_at.toISOString() : String(r.revoked_at),
  };
}

/** Upsert a freshly issued certificate. Returns the stored row or null. */
export async function saveCertificate(cert: SignedCertificate): Promise<StoredCertificate | null> {
  const p = cert.payload;
  try {
    const res = await pool.query(
      `INSERT INTO "zie_mcp_certificates"
         (cert_id, slug, version, trust_score, grade, eval_mode, model_evaluated,
          suite_version, n_leaked, axes, payload, signature, algorithm, issued_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14, NULL)
       ON CONFLICT ("slug","version") DO UPDATE SET
         cert_id = EXCLUDED.cert_id,
         trust_score = EXCLUDED.trust_score,
         grade = EXCLUDED.grade,
         eval_mode = EXCLUDED.eval_mode,
         model_evaluated = EXCLUDED.model_evaluated,
         suite_version = EXCLUDED.suite_version,
         n_leaked = EXCLUDED.n_leaked,
         axes = EXCLUDED.axes,
         payload = EXCLUDED.payload,
         signature = EXCLUDED.signature,
         algorithm = EXCLUDED.algorithm,
         issued_at = EXCLUDED.issued_at,
         revoked_at = NULL
       RETURNING *`,
      [
        p.cert_id, p.slug, p.version, p.trust_score, p.grade, p.eval_mode, p.model_evaluated,
        p.suite_version, p.n_leaked, JSON.stringify(p.axes), JSON.stringify(p), cert.signature, cert.algorithm,
        p.issued_at,
      ],
    );
    return res.rows[0] ? rowToStored(res.rows[0]) : null;
  } catch (err) {
    logger.error({ err: String(err), slug: p.slug }, "[certStore] saveCertificate failed");
    return null;
  }
}

/** Latest certificate for an MCP slug. */
export async function getLatestBySlug(slug: string): Promise<StoredCertificate | null> {
  try {
    const res = await pool.query(
      `SELECT * FROM "zie_mcp_certificates" WHERE slug = $1 ORDER BY issued_at DESC LIMIT 1`,
      [slug],
    );
    return res.rows[0] ? rowToStored(res.rows[0]) : null;
  } catch (err) {
    logger.error({ err: String(err), slug }, "[certStore] getLatestBySlug failed");
    return null;
  }
}

/** Fetch by public cert_id (used by the verify + badge endpoints). */
export async function getByCertId(certId: string): Promise<StoredCertificate | null> {
  try {
    const res = await pool.query(`SELECT * FROM "zie_mcp_certificates" WHERE cert_id = $1 LIMIT 1`, [certId]);
    return res.rows[0] ? rowToStored(res.rows[0]) : null;
  } catch (err) {
    logger.error({ err: String(err), certId }, "[certStore] getByCertId failed");
    return null;
  }
}

/** Leaderboard: certified MCPs ranked by trust score (latest cert per slug). */
export async function listLeaderboard(limit = 100): Promise<StoredCertificate[]> {
  try {
    const res = await pool.query(
      `SELECT DISTINCT ON (slug) *
         FROM "zie_mcp_certificates"
        ORDER BY slug, issued_at DESC`,
    );
    return res.rows
      .map(rowToStored)
      .sort((a: StoredCertificate, b: StoredCertificate) => b.trust_score - a.trust_score)
      .slice(0, limit);
  } catch (err) {
    logger.error({ err: String(err) }, "[certStore] listLeaderboard failed");
    return [];
  }
}

/** Revoke a certificate by cert_id. Returns true if a row was updated. */
export async function revokeCertificate(certId: string): Promise<boolean> {
  try {
    const res = await pool.query(
      `UPDATE "zie_mcp_certificates" SET revoked_at = now() WHERE cert_id = $1 AND revoked_at IS NULL`,
      [certId],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error({ err: String(err), certId }, "[certStore] revokeCertificate failed");
    return false;
  }
}
