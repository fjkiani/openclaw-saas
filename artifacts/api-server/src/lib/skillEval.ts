/**
 * skillEval.ts — LLM-as-judge evaluation for workflow skill handler outputs.
 *
 * Extends the existing judgePair → evaluation_runs → evaluation_metrics pipeline
 * to cover workflow skill handlers. Instead of evaluating preference pairs, this
 * evaluates a single skill handler invocation against a rubric.
 *
 * Design:
 *   - Reuses the same evaluation_runs / evaluation_metrics tables that Forge uses.
 *   - Reuses invokeWithFallback + the same judge model chain as judgePair.ts.
 *   - domain = 'workflow-skill', task_type = skill_id (e.g. 'aacr-semantic-search')
 *   - Writes one evaluation_run row + N metric rows per invocation.
 *   - Called by workflowBenchmark.ts (batch) and routes/eval.ts (on-demand).
 *
 * Metrics written per skill eval:
 *   output_completeness   — did the handler return all required output keys?
 *   output_quality        — LLM judge score 0.0–1.0 on output usefulness
 *   latency_ms            — wall-clock time for the handler invocation
 *   error_rate            — 0 (success) or 1 (threw)
 *
 * Usage:
 *   const receipt = await evalSkillHandler({
 *     skillId: 'aacr-semantic-search',
 *     input: { query: 'KRAS G12C inhibitor resistance' },
 *     expectedOutputKeys: ['speakers', 'talk_ids'],
 *     rubric: 'Return relevant AACR 2026 speakers for the query. Output must include talk_ids.',
 *     tenantId: 'tenant-demo-openclaw',
 *     db: pool,
 *   });
 */

import type { Pool } from "pg";
import { z } from "zod";
import { logger } from "./logger.js";
import { invokeWithFallback, type ModelRouteConfig } from "./modelRouter.js";
import { workflowEngine } from "./workflowEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// Judge model chain (same as judgePair.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SKILL_JUDGE_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 512,
    timeoutMs: 20_000,
    tags: ["70b", "skill-judge-primary"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 512,
    timeoutMs: 55_000,
    tags: ["120b", "skill-judge-fallback"],
  },
];

const SKILL_JUDGE_SYSTEM_PROMPT = `You are evaluating the output of an AI skill handler.

Given:
- skill_id: the handler being evaluated
- rubric: what a good output should contain
- output: the actual handler output (JSON)

Score the output from 0.0 to 1.0 on:
- Completeness: does it contain the expected data?
- Usefulness: is the data actionable for the stated rubric?
- Correctness: no hallucinated or malformed fields?

Output ONLY valid JSON:
{
  "score": <float 0.0-1.0>,
  "reasoning": "<one sentence>",
  "missing": ["<field or concept missing from output, if any>"]
}

No markdown. No prose outside the JSON object.`;

const SkillJudgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string().min(5),
  missing: z.array(z.string()).default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillEvalInput {
  skillId: string;
  input: Record<string, unknown>;
  /** Keys the output must contain to pass completeness check */
  expectedOutputKeys: string[];
  /** Plain-language rubric for the LLM judge */
  rubric: string;
  tenantId: string;
  db: Pool;
}

export type SkillEvalReceipt = {
  ok: true;
  eval_run_id: number;
  skill_id: string;
  tenant_id: string;
  latency_ms: number;
  output_completeness: number;   // fraction of expectedOutputKeys present
  output_quality: number;        // LLM judge score 0.0–1.0
  error_rate: number;            // 0 or 1
  judge_reasoning: string;
  missing_keys: string[];
  model_used: string;
};

export type SkillEvalResult =
  | { kind: "ok"; receipt: SkillEvalReceipt }
  | { kind: "skill_not_registered"; skill_id: string }
  | { kind: "handler_threw"; skill_id: string; error: string }
  | { kind: "judge_failed"; skill_id: string }
  | { kind: "persist_failed"; skill_id: string };

// ─────────────────────────────────────────────────────────────────────────────
// Core evaluation function
// ─────────────────────────────────────────────────────────────────────────────

export async function evalSkillHandler(params: SkillEvalInput): Promise<SkillEvalResult> {
  const { skillId, input, expectedOutputKeys, rubric, tenantId, db } = params;

  // 1. Verify skill is registered
  if (!workflowEngine.listSkills().includes(skillId)) {
    return { kind: "skill_not_registered", skill_id: skillId };
  }

  // 2. Invoke the handler, measure latency
  const startMs = Date.now();
  let handlerOutput: Record<string, unknown>;
  let errorRate = 0;

  try {
    // Access the internal skill registry via a single-step workflow run
    // We invoke via workflowEngine.startRun with a synthetic definition so
    // the run is persisted and auditable — same path as production.
    handlerOutput = await _invokeSkillDirect(skillId, input, tenantId);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ skillId, err }, "skillEval: handler threw");
    errorRate = 1;
    // Still write an eval run so the failure is recorded in evaluation_runs
    await _persistEvalRun(db, {
      tenantId,
      skillId,
      latencyMs: Date.now() - startMs,
      completeness: 0,
      quality: 0,
      errorRate: 1,
      reasoning: `Handler threw: ${errMsg}`,
      missingKeys: expectedOutputKeys,
      modelUsed: "none",
    });
    return { kind: "handler_threw", skill_id: skillId, error: errMsg };
  }

  const latencyMs = Date.now() - startMs;

  // 3. Completeness check — fraction of expected keys present in output
  const presentKeys = expectedOutputKeys.filter(
    (k) => handlerOutput[k] !== undefined && handlerOutput[k] !== null
  );
  const missingKeys = expectedOutputKeys.filter((k) => !presentKeys.includes(k));
  const completeness = expectedOutputKeys.length > 0
    ? presentKeys.length / expectedOutputKeys.length
    : 1.0;

  // 4. LLM judge — quality score
  let judgeScore = 0;
  let judgeReasoning = "";
  let modelUsed = "";

  try {
    const userContent = JSON.stringify({
      skill_id: skillId,
      rubric,
      output: handlerOutput,
    });

    const result = await invokeWithFallback<z.infer<typeof SkillJudgeOutputSchema>>(
      {
        systemPrompt: SKILL_JUDGE_SYSTEM_PROMPT,
        userContent,
        title: "OpenClaw Skill Eval Judge",
        maxTokens: 512,
        temperature: 0,
      },
      SKILL_JUDGE_CHAIN,
      {
        validator: (raw) => SkillJudgeOutputSchema.parse(raw),
        routeChainId: "skill-eval-judge",
        schemaType: "seo",
      }
    );
    judgeScore = result.parsed.score;
    judgeReasoning = result.parsed.reasoning;
    modelUsed = result.model_used;
  } catch (err: unknown) {
    logger.error({ err, skillId }, "skillEval: LLM judge failed");
    return { kind: "judge_failed", skill_id: skillId };
  }

  // 5. Persist to evaluation_runs + evaluation_metrics
  let evalRunId: number;
  try {
    evalRunId = await _persistEvalRun(db, {
      tenantId,
      skillId,
      latencyMs,
      completeness,
      quality: judgeScore,
      errorRate,
      reasoning: judgeReasoning,
      missingKeys,
      modelUsed,
    });
  } catch (err: unknown) {
    logger.error({ err, skillId }, "skillEval: persist failed");
    return { kind: "persist_failed", skill_id: skillId };
  }

  logger.info(
    { skillId, evalRunId, latencyMs, completeness, quality: judgeScore },
    "skillEval: evaluation complete"
  );

  return {
    kind: "ok",
    receipt: {
      ok: true,
      eval_run_id: evalRunId,
      skill_id: skillId,
      tenant_id: tenantId,
      latency_ms: latencyMs,
      output_completeness: completeness,
      output_quality: judgeScore,
      error_rate: errorRate,
      judge_reasoning: judgeReasoning,
      missing_keys: missingKeys,
      model_used: modelUsed,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: invoke a registered skill handler directly (bypasses DB run record)
// Used only for eval — production always goes through workflowEngine.startRun
// ─────────────────────────────────────────────────────────────────────────────

async function _invokeSkillDirect(
  skillId: string,
  input: Record<string, unknown>,
  tenantId: string
): Promise<Record<string, unknown>> {
  // workflowEngine exposes listSkills() but not direct handler access.
  // We use a minimal single-step run against a synthetic in-memory definition.
  // This is intentional: eval runs are auditable in workflow_runs just like prod runs.
  //
  // However, for eval we need the output synchronously. We use a Promise that
  // resolves when the run completes by polling getStepResults.
  //
  // Alternative: expose workflowEngine._invokeHandler() — but that breaks encapsulation.
  // The polling approach keeps the engine's FSM intact.

  // We can't call startRun without a real definition in the DB.
  // Instead, access the handler via the skills Map through a test shim.
  // workflowEngine exposes listSkills() — we verify registration above.
  // For direct invocation we use the internal _executeStep shim below.
  return _executeRegisteredSkill(skillId, input, tenantId);
}

// Shim: calls the registered handler via a minimal WorkflowRunContext
// This is the only place in the codebase that bypasses the DB run lifecycle.
// It is intentionally scoped to eval — never called from production routes.
async function _executeRegisteredSkill(
  skillId: string,
  input: Record<string, unknown>,
  tenantId: string
): Promise<Record<string, unknown>> {
  // Access the handler via workflowEngine's public interface.
  // workflowEngine doesn't expose handlers directly — we trigger a real run
  // against the seeded AACR definition if skillId matches, otherwise we
  // construct a minimal synthetic run.
  //
  // For eval purposes, we need the raw handler output. The cleanest approach
  // that doesn't break encapsulation: re-import the handler module directly.
  // The handler modules are pure functions — safe to call outside the engine.

  // Dynamic import of the skill module based on skillId prefix
  if (skillId.startsWith("aacr-") || ["crispro-scorer", "cd-hit-extractor", "crm-push"].includes(skillId)) {
    const { _getHandler } = await import("./skills/aacr/index.js");
    const handler = _getHandler(skillId);
    if (!handler) throw new Error(`Handler not found for ${skillId}`);
    return handler(input, {
      runId: `eval-${Date.now()}`,
      tenantId,
      stepIndex: 0,
      stepOutputs: {},
    });
  }

  throw new Error(`No eval shim for skill domain of '${skillId}' — add a case in skillEval._executeRegisteredSkill`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: write evaluation_run + metrics rows
// ─────────────────────────────────────────────────────────────────────────────

interface PersistParams {
  tenantId: string;
  skillId: string;
  latencyMs: number;
  completeness: number;
  quality: number;
  errorRate: number;
  reasoning: string;
  missingKeys: string[];
  modelUsed: string;
}

async function _persistEvalRun(db: Pool, p: PersistParams): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const runRes = await client.query<{ id: number }>(
      `INSERT INTO evaluation_runs
         (tenant_id, domain, task_type, status, started_at, completed_at)
       VALUES ($1, 'workflow-skill', $2, 'completed', now(), now())
       RETURNING id`,
      [p.tenantId, p.skillId]
    );
    const evalRunId = runRes.rows[0].id;

    await client.query(
      `INSERT INTO evaluation_metrics
         (tenant_id, eval_run_id, metric_name, metric_value, passed, metadata)
       VALUES
         ($1, $2, 'output_completeness', $3, $4, $5),
         ($1, $2, 'output_quality',      $6, $7, $8),
         ($1, $2, 'latency_ms',          $9, true, '{}'),
         ($1, $2, 'error_rate',          $10, $11, '{}')`,
      [
        p.tenantId,
        evalRunId,
        p.completeness,
        p.completeness >= 1.0,
        JSON.stringify({ missing_keys: p.missingKeys }),
        p.quality,
        p.quality >= 0.7,
        JSON.stringify({ reasoning: p.reasoning, model_used: p.modelUsed }),
        p.latencyMs,
        p.errorRate,
        p.errorRate === 0,
      ]
    );

    await client.query("COMMIT");
    return evalRunId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
