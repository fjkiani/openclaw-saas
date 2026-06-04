/**
 * judge.ts
 *
 * POST /v1/judge/pair/:pairId
 *
 * LLM-as-judge for a DPO preference pair.
 *
 * Flow:
 *   1. Fetch zie_preference_pairs row by UUID.
 *   2. Send chosen + rejected responses to the judge LLM (GROQ llama-3.3-70b).
 *   3. Parse judge scores (0.0–1.0 each) + reasoning.
 *   4. In ONE transaction: insert an evaluation_run, insert its evaluation_metrics
 *      (judge_score_chosen, judge_score_rejected, judge_delta) using the SPEC
 *      columns eval_run_id / metric_value, then UPDATE
 *      zie_preference_pairs SET judge_verified, judge_score_*, judge_reasoning,
 *      judge_run_id = <evaluation_run.id> WHERE id = :pairId.
 *   5. Return receipt JSON (includes judge_run_id).
 *
 * Requires migration 0007_judge_evaluation_bridge.sql (evaluation_metrics table
 * + zie_preference_pairs.judge_* columns incl. judge_run_id).
 *
 * Judge schema (strict JSON output):
 *   { "score_chosen": 0.0–1.0, "score_rejected": 0.0–1.0, "reasoning": "<string>" }
 *
 * judge_verified = true iff score_chosen > score_rejected.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { invokeWithFallback, type ModelRouteConfig } from "../lib/modelRouter.js";

const router = Router();

// ── Judge model chain ─────────────────────────────────────────────────────────
// GROQ first (fast, cheap), OpenRouter 120B fallback for robustness.
const JUDGE_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 512,
    timeoutMs: 20_000,
    tags: ["70b", "judge-primary"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 512,
    timeoutMs: 55_000,
    tags: ["120b", "judge-fallback"],
  },
];

const JUDGE_SYSTEM_PROMPT = `You are a strict LLM-as-judge evaluating two AI responses to the same prompt.

Score each response from 0.0 to 1.0 based on:
- Accuracy and factual correctness
- Completeness and depth of analysis
- Actionability of recommendations
- Clarity and structure

Output ONLY valid JSON with exactly these fields:
{
  "score_chosen": <float 0.0-1.0>,
  "score_rejected": <float 0.0-1.0>,
  "reasoning": "<one concise sentence explaining why chosen outperforms rejected>"
}

No markdown. No prose outside the JSON object.`;

// ── Zod schema for judge output ───────────────────────────────────────────────
const JudgeOutputSchema = z.object({
  score_chosen:  z.number().min(0).max(1),
  score_rejected: z.number().min(0).max(1),
  reasoning:     z.string().min(10),
});

// ── POST /v1/judge/pair/:pairId ───────────────────────────────────────────────
router.post(
  "/v1/judge/pair/:pairId",
  async (req: Request, res: Response): Promise<void> => {
    const { pairId } = req.params;

    // ── 1. Fetch the pair ─────────────────────────────────────────────────────
    const pairResult = await pool.query<{
      id: string;
      domain: string;
      task_type: string;
      prompt_hash: string;
      chosen_response_json: unknown;
      rejected_response_json: unknown;
      preference_source: string;
      judge_verified: boolean;
      tenant_id: string | null;
    }>(
      `SELECT id, domain, task_type, prompt_hash,
              chosen_response_json, rejected_response_json,
              preference_source, judge_verified, tenant_id
       FROM zie_preference_pairs
       WHERE id = $1`,
      [pairId],
    );

    if (pairResult.rows.length === 0) {
      res.status(404).json({ error: `Pair ${pairId} not found` });
      return;
    }

    const pair = pairResult.rows[0];

    if (pair.judge_verified) {
      res.status(200).json({
        ok: true,
        pair_id: pairId,
        already_verified: true,
        message: "Pair already judge-verified — skipping re-evaluation",
      });
      return;
    }

    // ── 2. Build judge prompt ─────────────────────────────────────────────────
    const userContent = JSON.stringify({
      domain:    pair.domain,
      task_type: pair.task_type,
      chosen_response:   pair.chosen_response_json,
      rejected_response: pair.rejected_response_json,
    });

    // ── 3. Invoke judge LLM ───────────────────────────────────────────────────
    let judgeOutput: z.infer<typeof JudgeOutputSchema>;
    let modelUsed: string;

    try {
      const result = await invokeWithFallback<z.infer<typeof JudgeOutputSchema>>(
        {
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          userContent,
          title: "OpenClaw ZIE Judge",
          maxTokens: 512,
          temperature: 0,
        },
        JUDGE_CHAIN,
        {
          validator: (raw) => JudgeOutputSchema.parse(raw),
          routeChainId: "zie-judge",
          schemaType: "seo", // bypass legal-specific detectUnusableOutput
        },
      );
      judgeOutput = result.parsed;
      modelUsed   = result.model_used;
    } catch (err: unknown) {
      logger.error({ err, pairId }, "judge.ts: LLM judge failed");
      res.status(502).json({ error: "Judge LLM failed after all fallbacks" });
      return;
    }

    // ── 4. Persist judge verdict + evaluation bridge (atomic) ─────────────────
    // The judge writes three coupled records inside one transaction so the
    // flywheel is observable: an evaluation_run, its evaluation_metrics, and the
    // back-reference (judge_run_id) on the preference pair. Either all land or none.
    const judgeVerified = judgeOutput.score_chosen > judgeOutput.score_rejected;
    const judgeDelta = judgeOutput.score_chosen - judgeOutput.score_rejected;
    // evaluation_runs.tenant_id is NOT NULL; judge is a system process, so fall
    // back to a system tenant when the pair has no tenant attached.
    const tenantId = pair.tenant_id ?? "system";

    const client = await pool.connect();
    let evalRunId: number;
    try {
      await client.query("BEGIN");

      // 4a. evaluation_run — id is SERIAL (integer), capture it via RETURNING.
      const runInsert = await client.query<{ id: number }>(
        `INSERT INTO evaluation_runs (tenant_id, domain, task_type, status, completed_at)
         VALUES ($1, $2, $3, 'completed', NOW())
         RETURNING id`,
        [tenantId, pair.domain, pair.task_type],
      );
      evalRunId = runInsert.rows[0].id;

      // 4b. evaluation_metrics — SPEC columns: eval_run_id (integer FK), metric_value (real).
      await client.query(
        `INSERT INTO evaluation_metrics (tenant_id, eval_run_id, metric_name, metric_value)
         VALUES
           ($1, $2, 'judge_score_chosen',   $3),
           ($1, $2, 'judge_score_rejected', $4),
           ($1, $2, 'judge_delta',          $5)`,
        [
          tenantId,
          evalRunId,
          judgeOutput.score_chosen,
          judgeOutput.score_rejected,
          judgeDelta,
        ],
      );

      // 4c. preference pair — include judge_run_id (integer FK -> evaluation_runs.id).
      await client.query(
        `UPDATE zie_preference_pairs
         SET judge_verified       = $1,
             judge_score_chosen   = $2,
             judge_score_rejected = $3,
             judge_reasoning      = $4,
             judge_run_id         = $5
         WHERE id = $6`,
        [
          judgeVerified,
          judgeOutput.score_chosen,
          judgeOutput.score_rejected,
          judgeOutput.reasoning,
          evalRunId,
          pairId,
        ],
      );

      await client.query("COMMIT");
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      logger.error({ err, pairId }, "judge.ts: evaluation-bridge transaction failed");
      res.status(500).json({ error: "Failed to persist judge evaluation bridge" });
      return;
    } finally {
      client.release();
    }

    logger.info(
      {
        pairId,
        domain:          pair.domain,
        judge_verified:  judgeVerified,
        score_chosen:    judgeOutput.score_chosen,
        score_rejected:  judgeOutput.score_rejected,
        model_used:      modelUsed,
      },
      "judge.ts: pair evaluated",
    );

    // ── 5. Return receipt ─────────────────────────────────────────────────────
    res.status(200).json({
      ok:                  true,
      pair_id:             pairId,
      domain:              pair.domain,
      task_type:           pair.task_type,
      judge_verified:      judgeVerified,
      judge_score_chosen:  judgeOutput.score_chosen,
      judge_score_rejected: judgeOutput.score_rejected,
      judge_delta:         judgeDelta,
      judge_reasoning:     judgeOutput.reasoning,
      judge_run_id:        evalRunId,
      model_used:          modelUsed,
    });
  },
);

export default router;
