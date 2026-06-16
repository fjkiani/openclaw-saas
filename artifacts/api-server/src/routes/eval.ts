/**
 * eval.ts — HTTP routes for workflow skill evaluation and benchmarking.
 *
 * Extends the judge.ts pattern to cover workflow skill handlers and full
 * workflow definitions. Results write into the same evaluation_runs /
 * evaluation_metrics / skill_benchmarks tables that Forge and ZOA use.
 *
 * Routes:
 *   POST /api/eval/skills/:skillId          — evaluate one skill handler (single invocation)
 *   POST /api/eval/workflows/:definitionId  — run L1–L4 benchmark on a workflow definition
 *   GET  /api/eval/workflows/:definitionId/results — latest benchmark result for a definition
 *   GET  /api/eval/skills/:skillId/history  — evaluation_runs history for a skill
 */

import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "@clerk/express";
import { evalSkillHandler } from "../lib/skillEval.js";
import { benchmarkWorkflowDefinition } from "../lib/workflowBenchmark.js";
import { SKILL_RUBRICS } from "../lib/workflowBenchmark.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/eval/skills/:skillId
// Evaluate a single skill handler invocation with the LLM judge.
// Body: { input: Record<string, unknown>, rubric?: string }
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/skills/:skillId",
  requireAuth(),
  async (req: Request, res: Response): Promise<void> => {
    const { skillId } = req.params;
    const { input = {}, rubric } = req.body as {
      input?: Record<string, unknown>;
      rubric?: string;
    };

    // Resolve tenant from Clerk auth
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tenantRes = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (tenantRes.rows.length === 0) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    const tenantId = tenantRes.rows[0].id;

    // Resolve rubric — caller can override, otherwise use registry
    const resolvedRubric = rubric ?? SKILL_RUBRICS[skillId]?.rubric;
    const expectedOutputKeys = SKILL_RUBRICS[skillId]?.expectedOutputKeys ?? [];

    if (!resolvedRubric) {
      res.status(400).json({
        error: `No rubric defined for skill '${skillId}'. Pass rubric in request body or add to SKILL_RUBRICS.`,
      });
      return;
    }

    const result = await evalSkillHandler({
      skillId,
      input,
      expectedOutputKeys,
      rubric: resolvedRubric,
      tenantId,
      db: pool,
    });

    switch (result.kind) {
      case "ok":
        res.status(200).json(result.receipt);
        return;
      case "skill_not_registered":
        res.status(404).json({ error: `Skill '${skillId}' is not registered in workflowEngine` });
        return;
      case "handler_threw":
        res.status(502).json({ error: `Skill handler threw: ${result.error}` });
        return;
      case "judge_failed":
        res.status(502).json({ error: "LLM judge failed after all fallbacks" });
        return;
      case "persist_failed":
        res.status(500).json({ error: "Failed to persist evaluation results" });
        return;
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/eval/workflows/:definitionId
// Run L1–L4 benchmark on a full workflow definition.
// Body: { test_inputs?: Array<Record<string, unknown>>, l4_timeout_ms?: number }
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/workflows/:definitionId",
  requireAuth(),
  async (req: Request, res: Response): Promise<void> => {
    const { definitionId } = req.params;
    const { test_inputs, l4_timeout_ms } = req.body as {
      test_inputs?: Array<Record<string, unknown>>;
      l4_timeout_ms?: number;
    };

    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tenantRes = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (tenantRes.rows.length === 0) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    const tenantId = tenantRes.rows[0].id;

    // Default test input for AACR workflows
    const testInputs = test_inputs ?? [
      { query: "KRAS G12C inhibitor resistance mechanisms" },
    ];

    try {
      const result = await benchmarkWorkflowDefinition({
        definitionId,
        tenantId,
        testInputs,
        db: pool,
        l4TimeoutMs: l4_timeout_ms ?? 60_000,
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: errMsg });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/eval/workflows/:definitionId/results
// Latest benchmark result for a workflow definition (from skill_benchmarks).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/workflows/:definitionId/results",
  requireAuth(),
  async (req: Request, res: Response): Promise<void> => {
    const { definitionId } = req.params;

    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Join workflow_definitions → skills → skill_benchmarks
    const res2 = await pool.query(
      `SELECT sb.*
       FROM skill_benchmarks sb
       JOIN skills s ON s.id = sb.skill_id
       JOIN workflow_definitions wd ON wd.name = s.name
       WHERE wd.id = $1
       ORDER BY sb.started_at DESC
       LIMIT 5`,
      [definitionId]
    );

    res.status(200).json({ results: res2.rows });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/eval/skills/:skillId/history
// evaluation_runs history for a skill (task_type = skillId, domain = 'workflow-skill').
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/skills/:skillId/history",
  requireAuth(),
  async (req: Request, res: Response): Promise<void> => {
    const { skillId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string ?? "20", 10), 100);

    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tenantRes = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (tenantRes.rows.length === 0) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    const tenantId = tenantRes.rows[0].id;

    const runsRes = await pool.query(
      `SELECT er.id, er.status, er.started_at, er.completed_at,
              json_agg(em ORDER BY em.metric_name) AS metrics
       FROM evaluation_runs er
       LEFT JOIN evaluation_metrics em ON em.eval_run_id = er.id
       WHERE er.tenant_id = $1
         AND er.domain = 'workflow-skill'
         AND er.task_type = $2
       GROUP BY er.id
       ORDER BY er.started_at DESC
       LIMIT $3`,
      [tenantId, skillId, limit]
    );

    res.status(200).json({ skill_id: skillId, runs: runsRes.rows });
  }
);

export default router;
