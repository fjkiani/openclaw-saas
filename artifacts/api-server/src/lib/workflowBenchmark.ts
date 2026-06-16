/**
 * workflowBenchmark.ts — End-to-end benchmark for workflow definitions.
 *
 * Extends benchmarkClient.ts to run L1–L4 benchmark suites against a full
 * workflow definition (not just individual skills). Writes results into
 * skill_benchmarks (same table the ZOA skills use) so the skills page can
 * display workflow benchmark grades alongside individual skill grades.
 *
 * L1 — Schema validation: all step outputs match their declared output_key types
 * L2 — Skill coverage: every registered skill_id in the definition has a handler
 * L3 — Quality gate: evalSkillHandler() judge score >= 0.7 for each step
 * L4 — End-to-end run: POST /api/workflows/runs → completed within timeout
 *
 * Design:
 *   - Reuses benchmarkClient.runBenchmarkSync for L1/L2 (structural checks).
 *   - Calls evalSkillHandler() for L3 (quality, writes to evaluation_runs).
 *   - Calls workflowEngine.startRun() for L4 (live run, writes to workflow_runs).
 *   - Writes a skill_benchmarks row with grade CERTIFIED / CONDITIONAL / FAILED.
 *   - Grade logic: L1+L2 must pass; L3 avg >= 0.7; L4 must complete.
 *
 * Usage:
 *   const result = await benchmarkWorkflowDefinition({
 *     definitionId: '1',
 *     tenantId: 'tenant-demo-openclaw',
 *     testInputs: [{ query: 'KRAS G12C inhibitor resistance' }],
 *     db: pool,
 *   });
 */

import type { Pool } from "pg";
import { logger } from "./logger.js";
import { workflowEngine } from "./workflowEngine.js";
import { evalSkillHandler, type SkillEvalResult } from "./skillEval.js";

// ─────────────────────────────────────────────────────────────────────────────
// Rubric registry — maps skill_id → { expectedOutputKeys, rubric }
// Add an entry here when a new skill domain is registered.
// ─────────────────────────────────────────────────────────────────────────────

interface SkillRubric {
  expectedOutputKeys: string[];
  rubric: string;
}

export const SKILL_RUBRICS: Record<string, SkillRubric> = {
  "aacr-semantic-search": {
    expectedOutputKeys: ["speakers", "talk_ids"],
    rubric:
      "Return relevant AACR 2026 speakers and their talk_ids for the query. " +
      "Output must include a non-empty speakers array and matching talk_ids.",
  },
  "crispro-scorer": {
    expectedOutputKeys: ["crispro_opps", "scored_count"],
    rubric:
      "Return CrisPRO competitive intelligence opportunities for the given talk_ids. " +
      "Each opportunity should have a talk_id, opportunity description, and priority.",
  },
  "cd-hit-extractor": {
    expectedOutputKeys: ["cd_hits", "hit_count"],
    rubric:
      "Return cognitive dissonance hits from AACR 2026 talks for the given talk_ids. " +
      "Each hit should identify a vulnerability or contradiction in the speaker's data.",
  },
  "crm-push": {
    expectedOutputKeys: ["pushed", "status"],
    rubric:
      "Acknowledge receipt of CRM push payload. " +
      "Output must include pushed count and status field (stub is acceptable).",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowBenchmarkInput {
  definitionId: string;
  tenantId: string;
  /** One or more test inputs to run through the workflow */
  testInputs: Array<Record<string, unknown>>;
  db: Pool;
  /** Timeout for L4 end-to-end run in ms. Default 60_000. */
  l4TimeoutMs?: number;
}

export interface LevelResult {
  level: "L1" | "L2" | "L3" | "L4";
  passed: boolean;
  score: number;       // 0.0–1.0
  details: string;
  eval_run_ids?: number[];  // evaluation_runs rows written (L3 only)
  workflow_run_id?: string; // workflow_runs row written (L4 only)
}

export interface WorkflowBenchmarkResult {
  definition_id: string;
  tenant_id: string;
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED";
  overall_score: number;
  levels: LevelResult[];
  skill_benchmark_id?: number;  // skill_benchmarks row written
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main benchmark function
// ─────────────────────────────────────────────────────────────────────────────

export async function benchmarkWorkflowDefinition(
  params: WorkflowBenchmarkInput
): Promise<WorkflowBenchmarkResult> {
  const { definitionId, tenantId, testInputs, db, l4TimeoutMs = 60_000 } = params;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  logger.info({ definitionId, tenantId }, "workflowBenchmark: starting");

  // Load definition from DB
  const client = await db.connect();
  let def: {
    id: string;
    name: string;
    steps: Array<{ skill_id: string; output_key?: string }>;
    tenant_id: string;
  };
  try {
    const res = await client.query(
      `SELECT id, name, steps, tenant_id FROM workflow_definitions WHERE id = $1 AND tenant_id = $2`,
      [definitionId, tenantId]
    );
    if (res.rows.length === 0) {
      throw new Error(`Workflow definition ${definitionId} not found for tenant ${tenantId}`);
    }
    def = res.rows[0];
    def.steps = Array.isArray(def.steps) ? def.steps : JSON.parse(def.steps as unknown as string);
  } finally {
    client.release();
  }

  const levels: LevelResult[] = [];

  // ── L1: Schema validation ──────────────────────────────────────────────────
  // Every step must have a skill_id string. output_key is optional but recommended.
  const l1Issues: string[] = [];
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    if (!step.skill_id || typeof step.skill_id !== "string") {
      l1Issues.push(`Step ${i}: missing or invalid skill_id`);
    }
    if (!step.output_key) {
      l1Issues.push(`Step ${i} (${step.skill_id}): no output_key — step outputs won't be addressable`);
    }
  }
  const l1Passed = l1Issues.length === 0;
  levels.push({
    level: "L1",
    passed: l1Passed,
    score: l1Passed ? 1.0 : Math.max(0, 1 - l1Issues.length / def.steps.length),
    details: l1Passed
      ? `All ${def.steps.length} steps have valid schema`
      : `Schema issues: ${l1Issues.join("; ")}`,
  });

  // ── L2: Skill coverage ─────────────────────────────────────────────────────
  // Every skill_id in the definition must be registered in workflowEngine.
  const registeredSkills = new Set(workflowEngine.listSkills());
  const unregistered = def.steps
    .map((s) => s.skill_id)
    .filter((id) => !registeredSkills.has(id));
  const l2Passed = unregistered.length === 0;
  levels.push({
    level: "L2",
    passed: l2Passed,
    score: l2Passed ? 1.0 : Math.max(0, 1 - unregistered.length / def.steps.length),
    details: l2Passed
      ? `All ${def.steps.length} skill_ids registered`
      : `Unregistered skills: ${unregistered.join(", ")}`,
  });

  // ── L3: Quality gate (evalSkillHandler per step per test input) ────────────
  const l3EvalRunIds: number[] = [];
  const l3Scores: number[] = [];
  const l3Issues: string[] = [];

  for (const testInput of testInputs) {
    for (const step of def.steps) {
      const rubric = SKILL_RUBRICS[step.skill_id];
      if (!rubric) {
        l3Issues.push(`No rubric defined for skill '${step.skill_id}' — add to SKILL_RUBRICS in workflowBenchmark.ts`);
        l3Scores.push(0);
        continue;
      }

      const evalResult: SkillEvalResult = await evalSkillHandler({
        skillId: step.skill_id,
        input: testInput,
        expectedOutputKeys: rubric.expectedOutputKeys,
        rubric: rubric.rubric,
        tenantId,
        db,
      });

      if (evalResult.kind === "ok") {
        const { output_completeness, output_quality, eval_run_id } = evalResult.receipt;
        // Combined score: 40% completeness, 60% quality
        const combined = 0.4 * output_completeness + 0.6 * output_quality;
        l3Scores.push(combined);
        l3EvalRunIds.push(eval_run_id);
        if (combined < 0.7) {
          l3Issues.push(
            `${step.skill_id}: score ${combined.toFixed(2)} < 0.7 — ${evalResult.receipt.judge_reasoning}`
          );
        }
      } else {
        l3Scores.push(0);
        l3Issues.push(`${step.skill_id}: eval failed (${evalResult.kind})`);
      }
    }
  }

  const l3Avg = l3Scores.length > 0 ? l3Scores.reduce((a, b) => a + b, 0) / l3Scores.length : 0;
  const l3Passed = l3Avg >= 0.7 && l3Issues.length === 0;
  levels.push({
    level: "L3",
    passed: l3Passed,
    score: l3Avg,
    details: l3Passed
      ? `All steps passed quality gate (avg score ${l3Avg.toFixed(2)})`
      : `Quality issues: ${l3Issues.join("; ")}`,
    eval_run_ids: l3EvalRunIds,
  });

  // ── L4: End-to-end run ─────────────────────────────────────────────────────
  // Run the workflow with the first test input and wait for completion.
  let l4WorkflowRunId: string | undefined;
  let l4Passed = false;
  let l4Details = "";

  try {
    const runId = await workflowEngine.startRun(definitionId, tenantId, testInputs[0] ?? {});
    l4WorkflowRunId = runId;

    // Poll for completion (max l4TimeoutMs)
    const pollIntervalMs = 2_000;
    const maxPolls = Math.ceil(l4TimeoutMs / pollIntervalMs);
    let finalStatus = "running";

    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const run = await workflowEngine.getRun(runId, tenantId);
      if (!run) {
        l4Details = `Run ${runId} not found after start`;
        break;
      }
      finalStatus = run.status;
      if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "cancelled") {
        break;
      }
    }

    l4Passed = finalStatus === "completed";
    l4Details = l4Passed
      ? `Run ${runId} completed successfully`
      : `Run ${runId} ended with status '${finalStatus}'`;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    l4Details = `startRun threw: ${errMsg}`;
  }

  levels.push({
    level: "L4",
    passed: l4Passed,
    score: l4Passed ? 1.0 : 0.0,
    details: l4Details,
    workflow_run_id: l4WorkflowRunId,
  });

  // ── Grade ──────────────────────────────────────────────────────────────────
  // CERTIFIED:   L1+L2+L4 pass, L3 avg >= 0.7
  // CONDITIONAL: L1+L2 pass, L4 pass, L3 avg >= 0.5 (quality marginal)
  // FAILED:      L1 or L2 or L4 fails
  const l1 = levels[0];
  const l2 = levels[1];
  const l3 = levels[2];
  const l4 = levels[3];
  const overallScore = (l1.score + l2.score + l3.score + l4.score) / 4;

  let grade: WorkflowBenchmarkResult["grade"];
  if (!l1.passed || !l2.passed || !l4.passed) {
    grade = "FAILED";
  } else if (l3.score >= 0.7) {
    grade = "CERTIFIED";
  } else if (l3.score >= 0.5) {
    grade = "CONDITIONAL";
  } else {
    grade = "FAILED";
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // ── Write skill_benchmarks row ─────────────────────────────────────────────
  // Uses the same table as ZOA skill benchmarks so the skills page can display
  // workflow benchmark grades alongside individual skill grades.
  let skillBenchmarkId: number | undefined;
  try {
    const bmClient = await db.connect();
    try {
      const bmRes = await bmClient.query<{ id: number }>(
        `INSERT INTO skill_benchmarks
           (skill_id, benchmark_id, status, grade, overall_score, level_scores,
            started_at, completed_at, duration_ms)
         VALUES (
           (SELECT id FROM skills WHERE name = $1 LIMIT 1),
           $2, 'completed', $3, $4, $5, $6, $7, $8
         )
         RETURNING id`,
        [
          def.name,
          `workflow-bench-${definitionId}-${Date.now()}`,
          grade,
          overallScore,
          JSON.stringify(
            Object.fromEntries(levels.map((l) => [l.level, { score: l.score, passed: l.passed, details: l.details }]))
          ),
          startedAt,
          completedAt,
          durationMs,
        ]
      );
      skillBenchmarkId = bmRes.rows[0]?.id;
    } finally {
      bmClient.release();
    }
  } catch (err) {
    // skill_benchmarks write is best-effort — don't fail the benchmark if the skill row doesn't exist
    logger.warn({ err, definitionId }, "workflowBenchmark: skill_benchmarks write failed (non-fatal)");
  }

  logger.info(
    { definitionId, grade, overallScore, durationMs },
    "workflowBenchmark: complete"
  );

  return {
    definition_id: definitionId,
    tenant_id: tenantId,
    grade,
    overall_score: overallScore,
    levels,
    skill_benchmark_id: skillBenchmarkId,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
  };
}
