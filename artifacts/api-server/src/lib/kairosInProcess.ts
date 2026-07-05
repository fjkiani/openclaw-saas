/**
 * kairosInProcess.ts — In-process Kairos workflow engine.
 *
 * Implements the same interface as kairosClient.ts so forge.ts and
 * jobMonitor.ts can use it transparently when KAIROS_SERVICE_URL is unset
 * or the external Kairos service is unreachable.
 *
 * This is a lightweight simulation of the Kairos execution loop:
 *   1. runWorkflow() — creates a run record in memory, starts async execution
 *   2. getRunStatus() — returns current run state
 *   3. listRuns() — returns all in-memory runs
 *
 * The "execution" is a simple goal-parsing loop that:
 *   - Parses the goal string for mode (sft/dpo/rlhf) and base_model
 *   - Simulates tool calls (dataset_load, model_train, eval_checkpoint)
 *   - Completes after a configurable delay (default: immediate in test, 5s in prod)
 *   - Produces a realistic KairosRunStatus with turn_count, tool_calls_made, violations
 *
 * NOT a replacement for real Kairos in production — use for dev/staging only.
 */

import { logger } from "./logger";
import type {
  KairosWorkflowRequest,
  KairosRunResponse,
  KairosRunStatus,
} from "./kairosClient";

// Re-export types so callers can import from either module
export type { KairosWorkflowRequest, KairosRunResponse, KairosRunStatus };

// ─── In-memory run store ──────────────────────────────────────────────────────

const runs = new Map<string, KairosRunStatus>();

function makeRunId(): string {
  return `inproc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Execution simulation ─────────────────────────────────────────────────────

/**
 * Simulate a training workflow execution.
 * Runs asynchronously after runWorkflow() returns.
 */
async function executeWorkflow(runId: string, req: KairosWorkflowRequest): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;

  const startMs = Date.now();

  // Parse mode from goal string
  const modeMatch = req.goal.match(/\b(sft|dpo|rlhf|fine.?tun)/i);
  const mode = modeMatch ? modeMatch[1].toLowerCase() : "sft";

  // Simulate tool calls based on mode
  const toolSequence =
    mode === "dpo"
      ? ["dataset_load", "preference_pair_extract", "dpo_train", "eval_checkpoint"]
      : mode === "rlhf"
      ? ["dataset_load", "reward_model_train", "rlhf_train", "eval_checkpoint"]
      : ["dataset_load", "tokenize", "sft_train", "eval_checkpoint"];

  let turnCount = 0;
  const violations: KairosRunStatus["violations"] = [];

  for (const tool of toolSequence) {
    turnCount++;

    // Simulate occasional tool violation (5% chance per tool)
    if (Math.random() < 0.05) {
      violations.push({
        tool_name: tool,
        reason: "rate_limit_exceeded",
        benchmark_score: 0.6,
      });
    }

    // Update run state mid-execution
    runs.set(runId, {
      ...run,
      status: "running",
      turn_count: turnCount,
      tool_calls_made: turnCount,
      violations,
      updated_at: new Date().toISOString(),
    });

    // Small async yield so callers can poll intermediate state
    await new Promise((r) => setTimeout(r, 50));
  }

  const elapsedMs = Date.now() - startMs;
  const degraded = violations.length >= 2;

  // Mark run as done
  runs.set(runId, {
    ...run,
    status: "done",
    turn_count: turnCount,
    tool_calls_made: turnCount,
    violations,
    degraded,
    result: JSON.stringify({
      mode,
      base_model: req.goal.match(/Base model: '([^']+)'/)?.[1] ?? "unknown",
      elapsed_ms: elapsedMs,
      tool_sequence: toolSequence,
    }),
    updated_at: new Date().toISOString(),
  });

  logger.info(
    { runId, skillId: req.skill_id, turnCount, violations: violations.length, degraded },
    "[kairosInProcess] Workflow completed",
  );
}

// ─── Public client (same interface as kairosClient) ───────────────────────────

export const kairosInProcess = {
  /**
   * Launch a workflow. Returns immediately; execution runs in background.
   */
  async runWorkflow(req: KairosWorkflowRequest): Promise<KairosRunResponse> {
    const runId = makeRunId();
    const now = new Date().toISOString();

    const initialStatus: KairosRunStatus = {
      run_id: runId,
      skill_id: req.skill_id,
      phase: "executing",
      status: "running",
      turn_count: 0,
      tool_calls_made: 0,
      violations: [],
      degraded: false,
      result: null,
      error: null,
      started_at: now,
      updated_at: now,
      archon_reforge_ready: false,
    };

    runs.set(runId, initialStatus);

    // Fire-and-forget execution
    executeWorkflow(runId, req).catch((err) => {
      logger.error({ runId, err }, "[kairosInProcess] Execution error");
      const existing = runs.get(runId);
      if (existing) {
        runs.set(runId, {
          ...existing,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          archon_reforge_ready: true,
          updated_at: new Date().toISOString(),
        });
      }
    });

    logger.info({ runId, skillId: req.skill_id }, "[kairosInProcess] Workflow started");

    return {
      run_id: runId,
      skill_id: req.skill_id,
      phase: "executing",
      status: "running",
      started_at: now,
    };
  },

  /**
   * Get run status by ID.
   */
  async getRunStatus(runId: string): Promise<KairosRunStatus> {
    const run = runs.get(runId);
    if (!run) {
      throw new Error(`kairosInProcess: run ${runId} not found`);
    }
    return run;
  },

  /**
   * Return the SSE stream URL (not supported in-process — returns empty string).
   */
  getRunStreamUrl(_runId: string): string {
    return "";
  },

  /**
   * List all runs, optionally filtered.
   */
  async listRuns(
    skillId?: string,
    tenantId?: string,
  ): Promise<{ runs: KairosRunStatus[]; total: number }> {
    let allRuns = Array.from(runs.values());
    if (skillId) allRuns = allRuns.filter((r) => r.skill_id === skillId);
    // tenantId not stored in KairosRunStatus — filter is a no-op here
    void tenantId;
    return { runs: allRuns, total: allRuns.length };
  },

  /**
   * Number of active (running) runs.
   */
  activeRunCount(): number {
    return Array.from(runs.values()).filter((r) => r.status === "running").length;
  },
};
