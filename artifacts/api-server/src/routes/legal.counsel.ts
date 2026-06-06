/**
 * POST /api/v1/legal/counsel/analyze — multi-lens RAG + reasoning counsel (Phase 3)
 * POST /api/v1/legal/counsel/diff     — structural version diff (no LLM)
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { runLegalCounselAnalyze, runLegalCounselDiff } from "../lib/legalCounsel/pipeline.js";
import { splitContractVersions } from "../lib/legalCounsel/splitVersions.js";
import { RouterExhaustedError } from "../lib/modelRouter.js";
import { logger } from "../lib/logger.js";

const router = Router();

const AnalyzeSchema = z.object({
  text: z.string().min(100).max(120_000),
  perspective: z.enum(["company", "counterparty", "neutral"]).optional().default("company"),
  doc_hint: z.string().optional(),
  /** When fixture has 2 versions, analyze this index only (0=first, 1=second). Default: latest. */
  version_index: z.number().int().min(0).max(5).optional(),
});

const DiffSchema = z.object({
  version_a: z.string().min(100).max(120_000),
  version_b: z.string().min(100).max(120_000),
  label_a: z.string().optional(),
  label_b: z.string().optional(),
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
      versionIndex: parsed.data.version_index,
    });

    res.status(200).json({
      ok: true,
      ...result.output,
      meta: {
        ...result.meta,
        rag_sources: result.rag_sources,
        rag_corpus_version: result.rag_corpus_version,
        section_count: result.section_count,
        model_used: result.model_used,
        latency_ms: result.latency_ms,
      },
    });
  } catch (err: unknown) {
    logger.error({ err }, "legal.counsel.analyze failed");
    const attemptLog = err instanceof RouterExhaustedError ? err.attempt_log : undefined;
    res.status(503).json({
      error: "Counsel analyze failed",
      details: err instanceof Error ? err.message : String(err),
      attempt_log: attemptLog,
    });
  }
});

router.post("/v1/legal/counsel/diff", async (req: Request, res: Response): Promise<void> => {
  const parsed = DiffSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  res.status(200).json(
    runLegalCounselDiff(parsed.data.version_a, parsed.data.version_b, {
      a: parsed.data.label_a,
      b: parsed.data.label_b,
    }),
  );
});

/** Split a multi-version paste without LLM (inspect boundaries). */
router.post("/v1/legal/counsel/split-versions", async (req: Request, res: Response): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (text.length < 100) {
    res.status(400).json({ error: "text required (min 100 chars)" });
    return;
  }
  const split = splitContractVersions(text);
  res.json({
    ok: true,
    single: split.single,
    versions: split.versions.map((v) => ({
      label: v.label,
      line_start: v.line_start,
      char_length: v.text.length,
    })),
  });
});

export default router;
