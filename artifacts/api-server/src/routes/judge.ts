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
 *   4. UPDATE zie_preference_pairs SET judge_verified, judge_score_chosen,
 *      judge_score_rejected, judge_reasoning WHERE id = :pairId.
 *   5. Return receipt JSON.
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
    }>(
      `SELECT id, domain, task_type, prompt_hash,
              chosen_response_json, rejected_response_json,
              preference_source, judge_verified
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

    // ── 4. Persist judge verdict ──────────────────────────────────────────────
    const judgeVerified = judgeOutput.score_chosen > judgeOutput.score_rejected;

    await pool.query(
      `UPDATE zie_preference_pairs
       SET judge_verified      = $1,
           judge_score_chosen  = $2,
           judge_score_rejected = $3,
           judge_reasoning     = $4
       WHERE id = $5`,
      [
        judgeVerified,
        judgeOutput.score_chosen,
        judgeOutput.score_rejected,
        judgeOutput.reasoning,
        pairId,
      ],
    );

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
      judge_reasoning:     judgeOutput.reasoning,
      model_used:          modelUsed,
    });
  },
);

export default router;
