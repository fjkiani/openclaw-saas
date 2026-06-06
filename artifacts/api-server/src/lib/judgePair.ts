/**
 * judgePair.ts — LLM-as-judge for one zie_preference_pairs row.
 * Shared by routes/judge.ts and vault auto-judge hook.
 */

import type { Pool } from "pg";
import { z } from "zod";
import { logger } from "./logger.js";
import { invokeWithFallback, type ModelRouteConfig } from "./modelRouter.js";

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

const JudgeOutputSchema = z.object({
  score_chosen: z.number().min(0).max(1),
  score_rejected: z.number().min(0).max(1),
  reasoning: z.string().min(10),
});

export type JudgeReceipt = {
  ok: true;
  pair_id: string;
  domain: string;
  task_type: string;
  judge_verified: boolean;
  judge_score_chosen: number;
  judge_score_rejected: number;
  judge_delta: number;
  judge_reasoning: string;
  judge_run_id: number;
  model_used: string;
};

export type JudgeResult =
  | { kind: "ok"; receipt: JudgeReceipt }
  | { kind: "already_verified"; pair_id: string }
  | { kind: "not_found"; pair_id: string }
  | { kind: "llm_failed" }
  | { kind: "persist_failed" };

export async function judgePairById(pairId: string, db: Pool): Promise<JudgeResult> {
  const pairResult = await db.query<{
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
    return { kind: "not_found", pair_id: pairId };
  }

  const pair = pairResult.rows[0];

  if (pair.judge_verified) {
    return { kind: "already_verified", pair_id: pairId };
  }

  const userContent = JSON.stringify({
    domain: pair.domain,
    task_type: pair.task_type,
    chosen_response: pair.chosen_response_json,
    rejected_response: pair.rejected_response_json,
  });

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
        schemaType: "seo",
      },
    );
    judgeOutput = result.parsed;
    modelUsed = result.model_used;
  } catch (err: unknown) {
    logger.error({ err, pairId }, "judgePair: LLM judge failed");
    return { kind: "llm_failed" };
  }

  const judgeVerified = judgeOutput.score_chosen > judgeOutput.score_rejected;
  const judgeDelta = judgeOutput.score_chosen - judgeOutput.score_rejected;
  const tenantId = pair.tenant_id ?? "system";

  const client = await db.connect();
  let evalRunId: number;
  try {
    await client.query("BEGIN");

    const runInsert = await client.query<{ id: number }>(
      `INSERT INTO evaluation_runs (tenant_id, domain, task_type, status, completed_at)
       VALUES ($1, $2, $3, 'completed', NOW())
       RETURNING id`,
      [tenantId, pair.domain, pair.task_type],
    );
    evalRunId = runInsert.rows[0].id;

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
    logger.error({ err, pairId }, "judgePair: evaluation-bridge transaction failed");
    return { kind: "persist_failed" };
  } finally {
    client.release();
  }

  return {
    kind: "ok",
    receipt: {
      ok: true,
      pair_id: pairId,
      domain: pair.domain,
      task_type: pair.task_type,
      judge_verified: judgeVerified,
      judge_score_chosen: judgeOutput.score_chosen,
      judge_score_rejected: judgeOutput.score_rejected,
      judge_delta: judgeDelta,
      judge_reasoning: judgeOutput.reasoning,
      judge_run_id: evalRunId,
      model_used: modelUsed,
    },
  };
}
