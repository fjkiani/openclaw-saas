/**
 * certify.ts — MCP Trust Certification API (mounted at /api/v1/certify).
 *
 * The public, SDK-callable trust surface:
 *   POST /v1/certify/:slug                 (admin) run behavioral eval + trust
 *                                          score + issue a signed certificate.
 *                                          ?dry=1 forces the static fallback.
 *   GET  /v1/certify/leaderboard           (public) certified MCPs by score.
 *   GET  /v1/certify/mcp/:slug             (public) latest cert for an MCP.
 *   GET  /v1/certify/cert/:certId          (public) a certificate by id.
 *   GET  /v1/certify/cert/:certId/verify   (public) tamper-evident verification.
 *   GET  /v1/certify/cert/:certId/badge.svg(public) embeddable SVG badge.
 *   POST /v1/certify/verify                (public) verify a posted payload+sig
 *                                          (offline verification of a shared cert).
 *   POST /v1/certify/cert/:certId/revoke   (admin) revoke a certificate.
 *   GET  /v1/certify/health                (public) suite + live-mode status.
 *
 * Issue/revoke are admin-gated (x-openclaw-admin-token). Read/verify/badge are
 * public and read-only — anyone can verify a certificate, which is the whole
 * point of a portable trust artifact.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getMcp } from "../lib/mcps/registry.js";
import { runBehavioralEval, behavioralHealth } from "../lib/mcps/behavioralEval.js";
import { computeTrustScore } from "../lib/mcps/trustScore.js";
import { issueCertificate, verifyCertificate, renderBadgeSvg, type TrustCertificatePayload } from "../lib/mcps/certificate.js";
import { saveCertificate, getLatestBySlug, getByCertId, listLeaderboard, revokeCertificate } from "../lib/mcps/certStore.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_TOKEN) return true; // no token configured → open (dev)
  const got = req.header("x-openclaw-admin-token") ?? "";
  if (got !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return false;
  }
  return true;
}

// ── GET /v1/certify/health ──────────────────────────────────────────────────
router.get("/v1/certify/health", (_req: Request, res: Response): void => {
  // behavioralHealth() already returns { ok, ... }; spread it directly.
  res.json({ ...behavioralHealth() });
});

// ── GET /v1/certify/leaderboard ───────────────────────────────────────────────
// Certified MCPs only (decision), ranked by trust score.
router.get("/v1/certify/leaderboard", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = await listLeaderboard(limit);
  res.json({
    ok: true,
    count: rows.length,
    leaderboard: rows.map((r) => ({
      slug: r.slug,
      version: r.version,
      cert_id: r.cert_id,
      trust_score: r.trust_score,
      grade: r.grade,
      eval_mode: r.eval_mode,
      model_evaluated: r.model_evaluated,
      revoked: r.revoked_at != null,
      issued_at: r.issued_at,
    })),
  });
});

// ── POST /v1/certify/verify ───────────────────────────────────────────────────
// Offline verification of a payload+signature supplied by the caller (e.g. a
// certificate JSON someone downloaded). Proves the artifact is self-contained.
// NOTE: declared BEFORE POST /:slug so the literal "verify" path is not
// captured by the :slug param route (Express matches in registration order).
router.post("/v1/certify/verify", (req: Request, res: Response): void => {
  const payload = req.body?.payload as TrustCertificatePayload | undefined;
  const signature = req.body?.signature as string | undefined;
  if (!payload || typeof signature !== "string") {
    res.status(400).json({ ok: false, valid: false, error: "payload and signature required" });
    return;
  }
  const valid = verifyCertificate(payload, signature);
  res.json({ ok: true, valid, cert_id: payload.cert_id, slug: payload.slug, grade: payload.grade, trust_score: payload.trust_score });
});

// ── POST /v1/certify/:slug ────────────────────────────────────────────────────
// Run the real behavioral red-team, fuse the Trust Score, issue + persist a
// signed certificate. Admin-gated (issuing is a privileged action).
router.post("/v1/certify/:slug", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const slug = String(req.params.slug);
  const mcp = getMcp(slug);
  if (!mcp) {
    res.status(404).json({ ok: false, error: `MCP '${slug}' not found` });
    return;
  }
  const forceDry = req.query.dry === "1" || req.body?.dry === true;
  try {
    const evalReport = await runBehavioralEval(slug, { forceDry });
    if (!evalReport) {
      res.status(404).json({ ok: false, error: `MCP '${slug}' not found` });
      return;
    }
    const trust = await computeTrustScore(mcp, evalReport, pool);
    const version = String(mcp.currentVersion || "0.0.0");
    const cert = issueCertificate({
      slug,
      version,
      trust,
      suite_version: evalReport.suite_version,
      model_evaluated: evalReport.model_evaluated,
      eval_mode: evalReport.mode,
      n_leaked: evalReport.n_leaked,
    });
    const stored = await saveCertificate(cert);
    res.json({
      ok: true,
      certificate: cert,
      persisted: stored != null,
      eval_report: {
        mode: evalReport.mode,
        degraded_reason: evalReport.degraded_reason ?? null,
        n_blocked: evalReport.n_blocked,
        n_leaked: evalReport.n_leaked,
        n_partial: evalReport.n_partial,
        safety_score: evalReport.safety_score,
        overall_grade: evalReport.overall_grade,
        category_breakdown: evalReport.category_breakdown,
        items: evalReport.items,
      },
    });
  } catch (err) {
    logger.error({ err: String(err), slug }, "[certify] issuance failed");
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /v1/certify/mcp/:slug ─────────────────────────────────────────────────
router.get("/v1/certify/mcp/:slug", async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const cert = await getLatestBySlug(slug);
  if (!cert) {
    res.status(404).json({ ok: false, error: `no certificate for MCP '${slug}'` });
    return;
  }
  res.json({ ok: true, certificate: cert });
});

// ── GET /v1/certify/cert/:certId ──────────────────────────────────────────────
router.get("/v1/certify/cert/:certId", async (req: Request, res: Response): Promise<void> => {
  const cert = await getByCertId(String(req.params.certId));
  if (!cert) {
    res.status(404).json({ ok: false, error: "certificate not found" });
    return;
  }
  res.json({ ok: true, certificate: cert });
});

// ── GET /v1/certify/cert/:certId/verify ───────────────────────────────────────
// Public tamper-evident verification: recompute the HMAC over the stored
// payload and report validity + revocation.
router.get("/v1/certify/cert/:certId/verify", async (req: Request, res: Response): Promise<void> => {
  const cert = await getByCertId(String(req.params.certId));
  if (!cert) {
    res.status(404).json({ ok: false, valid: false, error: "certificate not found" });
    return;
  }
  const valid = verifyCertificate(cert.payload, cert.signature);
  const revoked = cert.revoked_at != null;
  res.json({
    ok: true,
    valid: valid && !revoked,
    signature_valid: valid,
    revoked,
    cert_id: cert.cert_id,
    slug: cert.slug,
    version: cert.version,
    grade: cert.grade,
    trust_score: cert.trust_score,
    eval_mode: cert.eval_mode,
    issued_at: cert.issued_at,
    revoked_at: cert.revoked_at,
  });
});

// ── GET /v1/certify/cert/:certId/badge.svg ────────────────────────────────────
router.get("/v1/certify/cert/:certId/badge.svg", async (req: Request, res: Response): Promise<void> => {
  const cert = await getByCertId(String(req.params.certId));
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  if (!cert) {
    // A missing cert still returns a valid (grey, UNTRUSTED-styled) SVG so an
    // embedded badge never renders as a broken image.
    res.send(renderBadgeSvg("UNTRUSTED", 0, false).replace("UNTRUSTED 0", "not found"));
    return;
  }
  const revoked = cert.revoked_at != null;
  res.send(renderBadgeSvg(cert.grade as "TRUSTED" | "CONDITIONAL" | "UNTRUSTED", cert.trust_score, revoked));
});

// ── POST /v1/certify/cert/:certId/revoke ──────────────────────────────────────
router.post("/v1/certify/cert/:certId/revoke", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const certId = String(req.params.certId);
  const ok = await revokeCertificate(certId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "certificate not found or already revoked" });
    return;
  }
  res.json({ ok: true, revoked: true, cert_id: certId });
});

export default router;
