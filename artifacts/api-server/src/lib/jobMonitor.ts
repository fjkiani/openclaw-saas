// ALPHA ONLY: in-process setInterval polling. Does not survive restart or
// horizontal scale-out. Replace with pg-boss or BullMQ background worker
// before production deployment.

import { pool } from "@workspace/db";
import { kairosClient, type KairosRunStatus } from "./kairosClient";
import { logger } from "./logger";

// jobId → interval handle
const activePolls = new Map<number, NodeJS.Timeout>();

const POLL_INTERVAL_MS = 30_000;

/**
 * evaluateKairosRun — compute a real benchmark score from Kairos run telemetry.
 *
 * Scoring rubric (archon-v1):
 *   - Base score: 0.80 (training completed)
 *   - Degraded penalty: -0.15 (agent entered degraded mode)
 *   - Per-violation penalty: -0.05 each (capped at -0.25 total)
 *   - Efficiency bonus: +0.05 if turn_count ≤ 5 (clean run)
 *   - Tool call bonus: +0.05 if tool_calls_made ≥ 3 (agent was active)
 *
 * Returns { overall_score, passed, details }
 */
function evaluateKairosRun(status: KairosRunStatus): {
  overall_score: number;
  passed: boolean;
  details: string;
} {
  const THRESHOLD = 0.70;
  let score = 0.80;
  const notes: string[] = [];

  if (status.degraded) {
    score -= 0.15;
    notes.push("degraded mode");
  }

  const violationPenalty = Math.min(0.25, (status.violations?.length ?? 0) * 0.05);
  if (violationPenalty > 0) {
    score -= violationPenalty;
    notes.push(`${status.violations.length} violation(s)`);
  }

  if ((status.turn_count ?? 0) <= 5) {
    score += 0.05;
    notes.push("efficient run");
  }

  if ((status.tool_calls_made ?? 0) >= 3) {
    score += 0.05;
    notes.push("active tool use");
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

  return {
    overall_score: score,
    passed: score >= THRESHOLD,
    details: notes.length > 0 ? notes.join(", ") : "clean run",
  };
}

async function pollOnce(
  jobId: number,
  kairosRunId: string,
  tenantId: string,
  workspaceId: number,
): Promise<void> {
  let kairosStatus: KairosRunStatus;
  try {
    // Route to in-process engine for inproc- run IDs, real Kairos otherwise
    if (kairosRunId.startsWith("inproc-")) {
      kairosStatus = await kairosInProcess.getRunStatus(kairosRunId);
    } else {
      kairosStatus = await kairosClient.getRunStatus(kairosRunId);
    }
  } catch (err) {
    logger.warn({ jobId, kairosRunId, err }, "[jobMonitor] Failed to poll Kairos run status");
    return;
  }

  if (kairosStatus.status === "running") {
    // Nothing to do — keep polling
    return;
  }

  // Stop polling regardless of outcome
  const handle = activePolls.get(jobId);
  if (handle !== undefined) {
    clearInterval(handle);
    activePolls.delete(jobId);
  }

  if (kairosStatus.status === "done") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Transition job → evaluating
      await client.query(
        `UPDATE training_jobs SET status='evaluating', updated_at=now() WHERE id=$1`,
        [jobId],
      );

      // 2. Compute real benchmark score from Kairos telemetry
      const evaluation = evaluateKairosRun(kairosStatus);
      const evalStatus = evaluation.passed ? "passed" : "failed";

      logger.info(
        { jobId, overall_score: evaluation.overall_score, passed: evaluation.passed, details: evaluation.details },
        "[jobMonitor] Benchmark evaluation complete",
      );

      // 3. Create evaluation run
      const evalRunRes = await client.query(
        `INSERT INTO evaluation_runs (tenant_id, job_id, rubric_id, status)
         VALUES ($1, $2, 'archon-v1', 'running')
         RETURNING id`,
        [tenantId, jobId],
      );
      const evalRunId: number = evalRunRes.rows[0].id;

      // 4. Insert real metrics
      const THRESHOLD = 0.70;
      await client.query(
        `INSERT INTO evaluation_metrics (tenant_id, eval_run_id, metric_name, value, threshold, passed)
         VALUES ($1, $2, 'overall_score', $3, $4, $5)`,
        [tenantId, evalRunId, evaluation.overall_score, THRESHOLD, evaluation.passed],
      );

      // 5. Insert sub-metrics from Kairos telemetry
      await client.query(
        `INSERT INTO evaluation_metrics (tenant_id, eval_run_id, metric_name, value, threshold, passed)
         VALUES ($1, $2, 'violation_count', $3, 3, $4)`,
        [tenantId, evalRunId, kairosStatus.violations?.length ?? 0, (kairosStatus.violations?.length ?? 0) < 3],
      );

      await client.query(
        `INSERT INTO evaluation_metrics (tenant_id, eval_run_id, metric_name, value, threshold, passed)
         VALUES ($1, $2, 'degraded', $3, 0, $4)`,
        [tenantId, evalRunId, kairosStatus.degraded ? 1 : 0, !kairosStatus.degraded],
      );

      // 6. Mark eval run
      await client.query(
        `UPDATE evaluation_runs SET status=$1, completed_at=now() WHERE id=$2`,
        [evalStatus, evalRunId],
      );

      // 7. Transition job → completed or failed based on eval
      const finalJobStatus = evaluation.passed ? "completed" : "failed";
      const failReason = evaluation.passed
        ? null
        : `Benchmark score ${evaluation.overall_score} below threshold 0.70 (${evaluation.details})`;

      await client.query(
        `UPDATE training_jobs SET status=$1, error=$2, updated_at=now() WHERE id=$3`,
        [finalJobStatus, failReason, jobId],
      );

      // 8. Only register model if evaluation passed
      if (evaluation.passed) {
        const jobRes = await client.query(
          `SELECT name FROM training_jobs WHERE id=$1`,
          [jobId],
        );
        const jobName: string = jobRes.rows[0]?.name ?? `forge-job-${jobId}`;

        const regRes = await client.query(
          `INSERT INTO model_registrations (tenant_id, workspace_id, job_id, name)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [tenantId, workspaceId, jobId, jobName],
        );
        const regId: number = regRes.rows[0].id;

        await client.query(
          `INSERT INTO model_versions (tenant_id, registration_id, version, status)
           VALUES ($1, $2, 1, 'candidate')`,
          [tenantId, regId],
        );

        logger.info({ jobId, evalRunId, regId }, "[jobMonitor] Training completed — model registered");
      } else {
        logger.warn({ jobId, evalRunId, score: evaluation.overall_score }, "[jobMonitor] Training completed but benchmark failed — model NOT registered");
      }

      // 9. Emit usage event
      await client.query(
        `INSERT INTO model_usage_events (tenant_id, job_id, event_type)
         VALUES ($1, $2, $3)`,
        [tenantId, jobId, evaluation.passed ? "training_completed" : "training_benchmark_failed"],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error({ jobId, err }, "[jobMonitor] DB error handling done status");
    } finally {
      client.release();
    }
    return;
  }

  if (kairosStatus.status === "failed") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE training_jobs
         SET status='failed', error=$2, reforge_suggested=$3, updated_at=now()
         WHERE id=$1`,
        [jobId, kairosStatus.error, kairosStatus.archon_reforge_ready],
      );

      await client.query(
        `INSERT INTO model_usage_events (tenant_id, job_id, event_type)
         VALUES ($1, $2, 'training_failed')`,
        [tenantId, jobId],
      );

      await client.query("COMMIT");
      logger.warn({ jobId, error: kairosStatus.error }, "[jobMonitor] Training failed");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error({ jobId, err }, "[jobMonitor] DB error handling failed status");
    } finally {
      client.release();
    }
  }
}

export const jobMonitor = {
  start(jobId: number, kairosRunId: string, tenantId: string, workspaceId: number): void {
    if (activePolls.has(jobId)) {
      logger.warn({ jobId }, "[jobMonitor] Already polling this job — skipping duplicate start");
      return;
    }
    const handle = setInterval(() => {
      pollOnce(jobId, kairosRunId, tenantId, workspaceId).catch((err) => {
        logger.error({ jobId, err }, "[jobMonitor] Unhandled error in poll tick");
      });
    }, POLL_INTERVAL_MS);
    activePolls.set(jobId, handle);
    logger.info({ jobId, kairosRunId }, "[jobMonitor] Started polling");
  },

  stop(jobId: number): void {
    const handle = activePolls.get(jobId);
    if (handle !== undefined) {
      clearInterval(handle);
      activePolls.delete(jobId);
      logger.info({ jobId }, "[jobMonitor] Stopped polling");
    }
  },

  activeJobs(): number[] {
    return Array.from(activePolls.keys());
  },
};
