/**
 * workflowEngine.ts — Lightweight workflow execution engine.
 *
 * Executes workflow_definitions step-by-step, persisting results to
 * workflow_runs + workflow_step_results. Each step calls a registered
 * skill handler by skill_id.
 *
 * Design constraints (from HANDOFF doc):
 *  - Does NOT replace jobMonitor.ts — coordinate separately
 *  - Does NOT touch forge.ts, kairosClient.ts, or requireWorkspaceMember.ts
 *  - Skill handlers are registered at startup; unknown skill_ids are skipped with error
 *  - All DB writes are idempotent (upsert on step_index)
 *
 * Usage:
 *   import { workflowEngine } from './workflowEngine.js';
 *   workflowEngine.registerSkill('aacr-semantic-search', acrSearchHandler);
 *   const runId = await workflowEngine.startRun(definitionId, tenantId, input);
 */

import { Pool } from "pg";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  skill_id: string;
  description?: string;
  input_mapping?: Record<string, string>; // maps run.input keys → step input keys
  output_key?: string; // key to store step output in run context
}

export interface WorkflowDefinition {
  id: string;
  tenant_id: string;
  workspace_id?: number;
  name: string;
  description?: string;
  trigger: "manual" | "scheduled" | "webhook";
  steps: WorkflowStep[];
  policy_id?: string;
  version: number;
  is_active: boolean;
}

export interface WorkflowRun {
  id: string;
  definition_id: string;
  tenant_id: string;
  workspace_id?: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  trigger_kind: "manual" | "scheduled" | "webhook";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  started_at?: Date;
  completed_at?: Date;
  created_by?: string;
  created_at: Date;
}

export type SkillHandler = (
  input: Record<string, unknown>,
  context: WorkflowRunContext
) => Promise<Record<string, unknown>>;

export interface WorkflowRunContext {
  runId: string;
  tenantId: string;
  workspaceId?: number;
  stepIndex: number;
  /** Accumulated outputs from previous steps */
  stepOutputs: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

class WorkflowEngine {
  private pool: Pool | null = null;
  private skills = new Map<string, SkillHandler>();

  /** Call once at startup with the shared pg Pool. */
  init(pool: Pool) {
    this.pool = pool;
  }

  /** Register a skill handler by skill_id. */
  registerSkill(skillId: string, handler: SkillHandler) {
    this.skills.set(skillId, handler);
    logger.debug({ skillId }, "workflowEngine: skill registered");
  }

  /** List registered skill IDs. */
  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a new workflow run from a definition ID.
   * Returns the run ID immediately; execution is async.
   */
  async startRun(
    definitionId: string,
    tenantId: string,
    input: Record<string, unknown>,
    opts: { createdBy?: string; triggerKind?: WorkflowRun["trigger_kind"] } = {}
  ): Promise<string> {
    if (!this.pool) throw new Error("workflowEngine not initialized — call init(pool) first");

    const client = await this.pool.connect();
    try {
      // Load definition
      const defRes = await client.query<WorkflowDefinition>(
        `SELECT * FROM workflow_definitions WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
        [definitionId, tenantId]
      );
      if (defRes.rows.length === 0) {
        throw new Error(`Workflow definition ${definitionId} not found or inactive for tenant ${tenantId}`);
      }
      const def = defRes.rows[0];

      // Create run record
      const runRes = await client.query<{ id: string }>(
        `INSERT INTO workflow_runs
           (definition_id, tenant_id, workspace_id, status, trigger_kind, input, created_by)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6)
         RETURNING id`,
        [
          definitionId,
          tenantId,
          def.workspace_id ?? null,
          opts.triggerKind ?? "manual",
          JSON.stringify(input),
          opts.createdBy ?? null,
        ]
      );
      const runId = runRes.rows[0].id;

      // Execute async (non-blocking)
      this._executeRun(runId, def, input).catch((err) => {
        logger.error({ err, runId }, "workflowEngine: run execution failed");
      });

      return runId;
    } finally {
      client.release();
    }
  }

  /** Get run status + output. */
  async getRun(runId: string, tenantId: string): Promise<WorkflowRun | null> {
    if (!this.pool) throw new Error("workflowEngine not initialized");
    const client = await this.pool.connect();
    try {
      const res = await client.query<WorkflowRun>(
        `SELECT * FROM workflow_runs WHERE id = $1 AND tenant_id = $2`,
        [runId, tenantId]
      );
      return res.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  /** Get step results for a run. */
  async getStepResults(runId: string) {
    if (!this.pool) throw new Error("workflowEngine not initialized");
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT * FROM workflow_step_results WHERE run_id = $1 ORDER BY step_index ASC`,
        [runId]
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  /** Cancel a pending/running run. */
  async cancelRun(runId: string, tenantId: string): Promise<boolean> {
    if (!this.pool) throw new Error("workflowEngine not initialized");
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `UPDATE workflow_runs
         SET status = 'cancelled', completed_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'running')
         RETURNING id`,
        [runId, tenantId]
      );
      return res.rows.length > 0;
    } finally {
      client.release();
    }
  }

  // ── Internal execution ─────────────────────────────────────────────────────

  private async _executeRun(
    runId: string,
    def: WorkflowDefinition,
    runInput: Record<string, unknown>
  ) {
    if (!this.pool) return;
    const client = await this.pool.connect();

    try {
      // Mark running
      await client.query(
        `UPDATE workflow_runs SET status = 'running', started_at = now() WHERE id = $1`,
        [runId]
      );

      const steps: WorkflowStep[] = Array.isArray(def.steps) ? def.steps : [];
      const stepOutputs: Record<string, unknown> = {};
      let finalOutput: Record<string, unknown> = {};

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Check if run was cancelled
        const statusRes = await client.query<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE id = $1`,
          [runId]
        );
        if (statusRes.rows[0]?.status === "cancelled") {
          logger.info({ runId, stepIndex: i }, "workflowEngine: run cancelled mid-execution");
          return;
        }

        // Build step input from run input + previous step outputs
        const stepInput: Record<string, unknown> = { ...runInput };
        if (step.input_mapping) {
          for (const [from, to] of Object.entries(step.input_mapping)) {
            if (stepOutputs[from] !== undefined) {
              stepInput[to] = stepOutputs[from];
            }
          }
        }

        // Create step result record
        await client.query(
          `INSERT INTO workflow_step_results
             (run_id, step_index, skill_id, status, input, started_at)
           VALUES ($1, $2, $3, 'running', $4, now())
           ON CONFLICT (run_id, step_index) DO UPDATE
             SET status = 'running', started_at = now()`,
          [runId, i, step.skill_id, JSON.stringify(stepInput)]
        );

        const startMs = Date.now();
        const context: WorkflowRunContext = {
          runId,
          tenantId: def.tenant_id,
          workspaceId: def.workspace_id,
          stepIndex: i,
          stepOutputs,
        };

        try {
          const handler = this.skills.get(step.skill_id);
          if (!handler) {
            throw new Error(`No handler registered for skill_id '${step.skill_id}'`);
          }

          const output = await handler(stepInput, context);
          const durationMs = Date.now() - startMs;

          // Store output in context
          const outputKey = step.output_key ?? `step_${i}`;
          stepOutputs[outputKey] = output;
          finalOutput = { ...finalOutput, [outputKey]: output };

          await client.query(
            `UPDATE workflow_step_results
             SET status = 'completed', output = $1, duration_ms = $2, completed_at = now()
             WHERE run_id = $3 AND step_index = $4`,
            [JSON.stringify(output), durationMs, runId, i]
          );

          logger.debug({ runId, stepIndex: i, skillId: step.skill_id, durationMs }, "workflowEngine: step completed");
        } catch (stepErr: unknown) {
          const durationMs = Date.now() - startMs;
          const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);

          await client.query(
            `UPDATE workflow_step_results
             SET status = 'failed', error = $1, duration_ms = $2, completed_at = now()
             WHERE run_id = $3 AND step_index = $4`,
            [errMsg, durationMs, runId, i]
          );

          // Fail the run on step failure
          await client.query(
            `UPDATE workflow_runs
             SET status = 'failed', error = $1, completed_at = now()
             WHERE id = $2`,
            [`Step ${i} (${step.skill_id}) failed: ${errMsg}`, runId]
          );

          logger.error({ runId, stepIndex: i, skillId: step.skill_id, err: stepErr }, "workflowEngine: step failed");
          return;
        }
      }

      // All steps completed
      await client.query(
        `UPDATE workflow_runs
         SET status = 'completed', output = $1, completed_at = now()
         WHERE id = $2`,
        [JSON.stringify(finalOutput), runId]
      );

      logger.info({ runId, steps: steps.length }, "workflowEngine: run completed");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await client.query(
        `UPDATE workflow_runs
         SET status = 'failed', error = $1, completed_at = now()
         WHERE id = $2`,
        [errMsg, runId]
      ).catch(() => {});
      logger.error({ err, runId }, "workflowEngine: run failed");
    } finally {
      client.release();
    }
  }
}

// Singleton
export const workflowEngine = new WorkflowEngine();
