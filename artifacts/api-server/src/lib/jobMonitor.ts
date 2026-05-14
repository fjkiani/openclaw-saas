// ALPHA ONLY: in-process setInterval polling. Does not survive restart or
// horizontal scale-out. Replace with pg-boss or BullMQ background worker
// before production deployment.

import { pool } from "@workspace/db";
import { kairosClient } from "./kairosClient";
import { logger } from "./logger";

// jobId → interval handle
const activePolls = new Map<number, NodeJS.Timeout>();

const POLL_INTERVAL_MS = 30_000;

async function pollOnce(
  jobId: number,
  kairosRunId: string,
  tenantId: string,
  workspaceId: number,
): Promise<void> {
  let kairosStatus;
  try {
    kairosStatus = await kairosClient.getRunStatus(kairosRunId);
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

      // 2. Create evaluation run
      const evalRunRes = await client.query(
        `INSERT INTO evaluation_runs (tenant_id, job_id, rubric_id, status)
         VALUES ($1, $2, 'stub-v1', 'running')
         RETURNING id`,
        [tenantId, jobId],
      );
      const evalRunId: number = evalRunRes.rows[0].id;

      // 3. Insert stub metric
      await client.query(
        `INSERT INTO evaluation_metrics (tenant_id, eval_run_id, metric_name, value, threshold, passed)
         VALUES ($1, $2, 'overall_score', 0.85, 0.70, true)`,
        [tenantId, evalRunId],
      );

      // 4. Mark eval run passed
      await client.query(
        `UPDATE evaluation_runs SET status='passed', completed_at=now() WHERE id=$1`,
        [evalRunId],
      );

      // 5. Transition job → completed
      await client.query(
        `UPDATE training_jobs SET status='completed', updated_at=now() WHERE id=$1`,
        [jobId],
      );

      // 6. Fetch job row for name
      const jobRes = await client.query(
        `SELECT name FROM training_jobs WHERE id=$1`,
        [jobId],
      );
      const jobName: string = jobRes.rows[0]?.name ?? `forge-job-${jobId}`;

      // 7. Register model
      const regRes = await client.query(
        `INSERT INTO model_registrations (tenant_id, workspace_id, job_id, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tenantId, workspaceId, jobId, jobName],
      );
      const regId: number = regRes.rows[0].id;

      // 8. Create initial model version
      await client.query(
        `INSERT INTO model_versions (tenant_id, registration_id, version, status)
         VALUES ($1, $2, 1, 'candidate')`,
        [tenantId, regId],
      );

      // 9. Emit usage event
      await client.query(
        `INSERT INTO model_usage_events (tenant_id, job_id, event_type)
         VALUES ($1, $2, 'training_completed')`,
        [tenantId, jobId],
      );

      await client.query("COMMIT");
      logger.info({ jobId, evalRunId, regId }, "[jobMonitor] Training completed — model registered");
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
