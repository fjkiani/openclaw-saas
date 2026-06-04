/**
 * seo.ts
 *
 * POST /api/v1/seo/audit
 *
 * Runs a double-dip SEO content audit for a given domain + GitHub repo.
 * Captures SFT + DPO vault rows with domain="seo", source_kind="direct_call".
 */

import { Router } from "express";
import { z } from "zod";
import { runSeoAudit } from "../lib/seoAuditAnalyzer.js";
import { logger } from "../lib/logger.js";

const seoRouter = Router();

// ─── Request schema ───────────────────────────────────────────────────────────

const SeoAuditRequestSchema = z.object({
  domain: z.string().min(1),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  github_branch: z.string().min(1).default("main"),
  keywords: z
    .array(
      z.object({
        keyword: z.string().min(1),
        volume: z.number().int().min(0),
        competition_index: z.number().min(0).max(1),
      }),
    )
    .min(1, "At least one keyword required"),
  desktop_performance: z.number().min(0).max(100).default(50),
});

// ─── POST /api/v1/seo/audit ───────────────────────────────────────────────────

seoRouter.post("/api/v1/seo/audit", async (req, res) => {
  const parsed = SeoAuditRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request body",
      details: parsed.error.issues,
    });
  }

  const input = parsed.data;

  logger.info(
    { domain: input.domain, keywords: input.keywords.map(k => k.keyword) },
    "seo.audit: request received",
  );

  try {
    const { audit, path_taken, prompt_hash } = await runSeoAudit(input);

    return res.status(200).json({
      ok: true,
      domain: input.domain,
      path_taken,
      prompt_hash,
      audit,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, domain: input.domain }, "seo.audit: handler threw");
    return res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

export default seoRouter;
