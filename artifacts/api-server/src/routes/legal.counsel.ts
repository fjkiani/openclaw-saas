/**
 * POST /api/v1/legal/counsel/analyze      — multi-lens RAG + reasoning counsel (Phase 3)
 * POST /api/v1/legal/counsel/analyze/async — async variant: returns run_id immediately (C12)
 * GET  /api/v1/legal/counsel/runs/:id     — poll async run status (C12)
 * POST /api/v1/legal/counsel/diff         — structural version diff (no LLM)
 * POST /api/v1/legal/counsel/split-versions — inspect version boundaries
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { runLegalCounselAnalyze, runLegalCounselDiff } from "../lib/legalCounsel/pipeline.js";
import { splitContractVersions } from "../lib/legalCounsel/splitVersions.js";
import { RouterExhaustedError } from "../lib/modelRouter.js";
import { logger } from "../lib/logger.js";
import {
  createCounselRun,
  completeCounselRun,
  failCounselRun,
  getCounselRun,
  hashInput,
} from "../lib/legalCounsel/runStore.js";
import {
  evaluateGovernance,
  LEGAL_GOVERNANCE_POLICY,
} from "../lib/governanceEngine.js";

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const AnalyzeSchema = z.object({
  text: z.string().min(100).max(120_000),
  perspective: z.enum(["company", "counterparty", "neutral"]).optional().default("company"),
  doc_hint: z.string().optional(),
  /** When fixture has 2 versions, analyze this index only (0=first, 1=second). Default: latest. */
  version_index: z.number().int().min(0).max(5).optional(),
  /**
   * mode="orchestrator" → 4 parallel lens agents (default, satisfies C1 gate)
   * mode="monolith"     → single LLM call (legacy)
   */
  mode: z.enum(["orchestrator", "monolith"]).optional(),
  /**
   * async_mode=true → return run_id immediately; poll GET /runs/:id for result (C12)
   * Only valid on POST /analyze (not /analyze/async which is always async)
   */
  async_mode: z.boolean().optional().default(false),
});

const DiffSchema = z.object({
  version_a: z.string().min(100).max(120_000),
  version_b: z.string().min(100).max(120_000),
  label_a: z.string().optional(),
  label_b: z.string().optional(),
});

// ── Shared: build governance block from result ────────────────────────────────

function buildGovernanceDecision(
  result: Awaited<ReturnType<typeof runLegalCounselAnalyze>>,
  text: string,
  perspective: string,
) {
  const overallRisk = result.output.overall_risk;
  const confidence =
    result.meta.grounded_ratio != null ? result.meta.grounded_ratio : null;

  return evaluateGovernance({
    matter_id: `counsel-${Date.now()}`,
    domain: "legal",
    specialist: "counsel",
    output: {
      overall_risk: overallRisk,
      blocking_issues: result.output.blocking_issues,
      findings_grounded_count: result.output.findings_grounded.length,
      findings_inferred_count: result.output.findings_inferred.length,
      orchestrator_mode: result.meta.orchestrator_mode,
    },
    raw_text: text,
    confidence,
    policy: LEGAL_GOVERNANCE_POLICY,
  });
}

// ── Shared: run analysis + build response payload ─────────────────────────────

async function runAndBuildPayload(
  text: string,
  perspective: "company" | "counterparty" | "neutral",
  docHint: string | undefined,
  versionIndex: number | undefined,
  mode: "orchestrator" | "monolith" | undefined,
) {
  const result = await runLegalCounselAnalyze({
    text,
    perspective,
    docHint,
    versionIndex,
    mode,
  });

  const governance = buildGovernanceDecision(result, text, perspective);

  return {
    ok: true as const,
    ...result.output,
    governance: {
      ...result.output.governance,
      escalation: governance.action !== "pass" ? governance : undefined,
      governance_action: governance.action,
      escalation_reasons: governance.escalation_reasons,
    },
    meta: {
      ...result.meta,
      rag_sources: result.rag_sources,
      rag_corpus_version: result.rag_corpus_version,
      section_count: result.section_count,
      model_used: result.model_used,
      latency_ms: result.latency_ms,
    },
  };
}

// ── POST /v1/legal/counsel/analyze (sync, default) ───────────────────────────

router.post("/v1/legal/counsel/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { text, perspective, doc_hint, version_index, mode, async_mode } = parsed.data;

  // If async_mode=true, return run_id immediately and process in background (C12)
  if (async_mode) {
    const inputSha = hashInput(text);
    const runId = await createCounselRun({
      perspective,
      inputSha256: inputSha,
      counselMode: mode ?? "orchestrator",
    });

    // Fire-and-forget background processing
    setImmediate(async () => {
      try {
        const payload = await runAndBuildPayload(text, perspective, doc_hint, version_index, mode);
        await completeCounselRun({
          runId,
          result: payload,
          groundedCount: payload.findings_grounded?.length ?? 0,
          groundedRatio: payload.meta.grounded_ratio ?? 0,
        });
      } catch (err) {
        await failCounselRun(runId, err instanceof Error ? err.message : String(err));
      }
    });

    res.status(202).json({
      ok: true,
      run_id: runId,
      status: "running",
      poll_url: `/v1/legal/counsel/runs/${runId}`,
    });
    return;
  }

  // Sync path — also create a run record for receipt (C12)
  const inputSha = hashInput(text);
  const runId = await createCounselRun({
    perspective,
    inputSha256: inputSha,
    counselMode: mode ?? "orchestrator",
  });

  try {
    const payload = await runAndBuildPayload(text, perspective, doc_hint, version_index, mode);

    await completeCounselRun({
      runId,
      result: payload,
      groundedCount: payload.findings_grounded?.length ?? 0,
      groundedRatio: payload.meta.grounded_ratio ?? 0,
    });

    res.status(200).json({ ...payload, run_id: runId });
  } catch (err: unknown) {
    await failCounselRun(runId, err instanceof Error ? err.message : String(err));
    logger.error({ err }, "legal.counsel.analyze failed");
    const attemptLog = err instanceof RouterExhaustedError ? err.attempt_log : undefined;
    res.status(503).json({
      error: "Counsel analyze failed",
      run_id: runId,
      details: err instanceof Error ? err.message : String(err),
      attempt_log: attemptLog,
    });
  }
});

// ── POST /v1/legal/counsel/analyze/async (always async, C12) ─────────────────

router.post(
  "/v1/legal/counsel/analyze/async",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = AnalyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { text, perspective, doc_hint, version_index, mode } = parsed.data;
    const inputSha = hashInput(text);
    const runId = await createCounselRun({
      perspective,
      inputSha256: inputSha,
      counselMode: mode ?? "orchestrator",
    });

    setImmediate(async () => {
      try {
        const payload = await runAndBuildPayload(text, perspective, doc_hint, version_index, mode);
        await completeCounselRun({
          runId,
          result: payload,
          groundedCount: payload.findings_grounded?.length ?? 0,
          groundedRatio: payload.meta.grounded_ratio ?? 0,
        });
      } catch (err) {
        await failCounselRun(runId, err instanceof Error ? err.message : String(err));
      }
    });

    res.status(202).json({
      ok: true,
      run_id: runId,
      status: "running",
      poll_url: `/v1/legal/counsel/runs/${runId}`,
    });
  },
);

// ── GET /v1/legal/counsel/runs/:id (poll, C12) ────────────────────────────────

router.get("/v1/legal/counsel/runs/:id", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!id || typeof id !== "string" || id.length < 10) {
    res.status(400).json({ error: "Invalid run_id" });
    return;
  }

  const row = await getCounselRun(id);
  if (!row) {
    res.status(404).json({ error: "Run not found", run_id: id });
    return;
  }

  if (row.status === "running") {
    res.status(202).json({
      ok: true,
      run_id: row.id,
      status: "running",
      created_at: row.created_at,
      poll_url: `/v1/legal/counsel/runs/${id}`,
    });
    return;
  }

  if (row.status === "failed") {
    res.status(200).json({
      ok: false,
      run_id: row.id,
      status: "failed",
      error: row.error,
      created_at: row.created_at,
      completed_at: row.completed_at,
    });
    return;
  }

  // status === "done"
  res.status(200).json({
    ok: true,
    run_id: row.id,
    status: "done",
    created_at: row.created_at,
    completed_at: row.completed_at,
    grounded_count: row.grounded_count,
    grounded_ratio: row.grounded_ratio,
    result: row.result,
  });
});

// ── POST /v1/legal/counsel/diff ───────────────────────────────────────────────

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

// ── POST /v1/legal/counsel/split-versions ────────────────────────────────────

router.post(
  "/v1/legal/counsel/split-versions",
  async (req: Request, res: Response): Promise<void> => {
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
  },
);

export default router;
