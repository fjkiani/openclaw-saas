/**
 * forgeScheduler.ts
 *
 * pg-boss cron scheduler for the double-dip flywheel forge dispatch.
 *
 * Registers a single recurring job: "hourly-forge-check"
 * Cron: every hour on the hour ("0 * * * *")
 * Handler: checkThresholdsAndDispatch() from modalDispatch.ts
 *
 * pg-boss uses the same Postgres connection as the rest of the app.
 * It creates its own schema (pgboss) on first start — fully idempotent.
 *
 * Usage: call startForgeScheduler() once during server startup, after
 * the DB connection is confirmed live.
 */

import PgBoss from "pg-boss";
import { checkThresholdsAndDispatch } from "./modalDispatch.js";
import { logger } from "./logger.js";

const DATABASE_URL = process.env.DATABASE_URL;

let boss: PgBoss | null = null;

export async function startForgeScheduler(): Promise<void> {
  if (!DATABASE_URL) {
    logger.warn(
      "forgeScheduler: DATABASE_URL not set — pg-boss scheduler disabled",
    );
    return;
  }

  boss = new PgBoss({
    connectionString: DATABASE_URL,
    // Retain completed job records for 24 h for observability
    deleteAfterHours: 24,
    // Prevent runaway retries on a broken Modal endpoint
    retryLimit: 2,
    retryDelay: 300, // 5 min between retries
  });

  boss.on("error", (err: unknown) => {
    logger.error({ err }, "forgeScheduler: pg-boss error");
  });

  await boss.start();
  logger.info("forgeScheduler: pg-boss started");

  // pg-boss v10: queue must exist before schedule() can reference it
  await boss.createQueue("hourly-forge-check");
  logger.info("forgeScheduler: queue hourly-forge-check created (idempotent)");

  // Register the cron schedule — idempotent, safe to call on every startup
  await boss.schedule(
    "hourly-forge-check",
    "0 * * * *", // every hour on the hour
    {},           // no job data needed — handler reads DB directly
    {
      tz: "UTC",
      singletonKey: "hourly-forge-check", // prevent duplicate concurrent runs
    },
  );

  // Register the worker that processes the scheduled jobs
  await boss.work<Record<string, never>>(
    "hourly-forge-check",
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info({ jobId: job.id }, "forgeScheduler: hourly-forge-check fired");
      try {
        const result = await checkThresholdsAndDispatch();
        logger.info(
          {
            jobId: job.id,
            dispatched: result.dispatched,
            sftCount: result.sftCount,
            dpoCount: result.dpoCount,
            trainingJobId: result.jobId ?? null,
            dryRun: result.dryRun ?? false,
          },
          "forgeScheduler: hourly-forge-check complete",
        );
      } catch (err: unknown) {
        logger.error(
          { err, jobId: job.id },
          "forgeScheduler: hourly-forge-check handler threw",
        );
        // Re-throw so pg-boss marks the job as failed and retries per retryLimit
        throw err;
      }
    },
  );

  logger.info(
    "forgeScheduler: hourly-forge-check scheduled (cron: 0 * * * * UTC)",
  );
}

export async function stopForgeScheduler(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    logger.info("forgeScheduler: pg-boss stopped");
  }
}
