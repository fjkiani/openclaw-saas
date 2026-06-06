/**
 * POST /api/v1/legal/counsel/analyze — multi-lens RAG + reasoning counsel
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { runLegalCounselAnalyze } from "../lib/legalCounsel/pipeline.js";
import { RouterExhaustedError } from "../lib/modelRouter.js";
import { logger } from "../lib/logger.js";

const router = Router();

const AnalyzeSchema = z.object({
  text: z.string().min(100).max(120_000),
  perspective: z.enum(["company", "counterparty", "neutral"]).optional().default("company"),
  doc_hint: z.string().optional(),
});

router.post("/v1/legal/counsel/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await runLegalCounselAnalyze({
      text: parsed.data.text,
      perspective: parsed.data.perspective,
      docHint: parsed.data.doc_hint,
    });

    res.status(200).json({
      ok: true,
      ...result.output,
      meta: {
        rag_sources: result.rag_sources,
        rag_corpus_version: result.rag_corpus_version,
        retrieval_mode: result.retrieval_mode,
        section_count: result.section_count,
        model_used: result.model_used,
        latency_ms: result.latency_ms,
      },
    });
  } catch (err: unknown) {
    logger.error({ err }, "legal.counsel.analyze failed");
    const attemptLog = err instanceof RouterExhaustedError ? err.attempt_log : undefined;
    res.status(503).json({
      error: "Counsel analysis failed",
      details: err instanceof Error ? err.message : String(err),
      attempt_log: attemptLog,
    });
  }
});

export default router;
