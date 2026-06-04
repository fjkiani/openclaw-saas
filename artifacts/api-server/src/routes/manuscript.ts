/**
 * manuscript.ts
 *
 * POST /v1/manuscript/review
 *
 * Accepts a CanonicalSubmissionPayload, runs the double-dip flywheel,
 * and returns the Zod-validated SlopAnalysis JSON.
 *
 * The route is intentionally lightweight — all routing, model invocation,
 * Zod validation, and vault persistence live in doubleDipRouter.ts.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { executeDoubleDip, hashPrompt, SlopSchema } from "../lib/doubleDipRouter.js";
import { RouterExhaustedError } from "../lib/modelRouter.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── Request schema ────────────────────────────────────────────────────────────

const CanonicalSubmissionPayload = z.object({
  /** The raw manuscript text to audit. Required. */
  text: z.string().min(50, "text must be at least 50 characters"),
  /** Optional caller-supplied identifier for lineage tracking. */
  submission_id: z.string().optional(),
  /** Optional tenant context — used for multi-tenant vault partitioning in future. */
  tenant_id: z.string().optional(),
});

export type CanonicalSubmissionPayloadType = z.infer<typeof CanonicalSubmissionPayload>;

// ── POST /v1/manuscript/review ────────────────────────────────────────────────

router.post("/v1/manuscript/review", async (req, res): Promise<void> => {
  // Parse and validate request body
  const parseResult = CanonicalSubmissionPayload.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid request payload",
      issues: parseResult.error.issues,
    });
    return;
  }

  const { text, submission_id, tenant_id } = parseResult.data;

  // Deterministic prompt hash — deduplicates vault entries for identical inputs
  const promptHash = hashPrompt(text);

  const logCtx = {
    promptHash,
    submission_id: submission_id ?? null,
    tenant_id: tenant_id ?? null,
    textLength: text.length,
  };

  logger.info(logCtx, "manuscript/review: executing double-dip");

  try {
    const { analysis, path_taken } = await executeDoubleDip(
      { text, submission_id, tenant_id },
      promptHash,
      "manuscript_slop_check",
      {
        domain: "manuscript",
        sourceKind: "direct_call",
        outputSchema: SlopSchema,
      },
    );

    // analysis is validated by SlopSchema inside executeDoubleDip
    const slopResult = SlopSchema.parse(analysis);

    logger.info(
      { ...logCtx, severity: slopResult.severity, confidence: slopResult.confidence, path_taken },
      "manuscript/review: complete",
    );

    res.json({
      ok: true,
      prompt_hash: promptHash,
      path_taken,
      analysis: slopResult,
    });
  } catch (err: unknown) {
    if (err instanceof RouterExhaustedError) {
      logger.error(
        { ...logCtx, attemptLog: err.attempt_log },
        "manuscript/review: all model routes exhausted",
      );
      res.status(503).json({
        error: "All model routes exhausted — no inference result available",
        attempt_log: err.attempt_log,
      });
      return;
    }

    logger.error({ err, ...logCtx }, "manuscript/review: unexpected error");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
});

export default router;
