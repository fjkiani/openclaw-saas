/**
 * modalDispatch.ts
 *
 * Double-Dip Data Flywheel — The Forge.
 *
 * Counts unused SFT records and DPO pairs in the zie_* tables.
 * When thresholds are met (200 SFT + 100 DPO), creates a training_jobs row
 * with compute_backend='modal' and spawns a Modal LoRA fine-tune job.
 *
 * DRY_RUN=true skips the actual Modal SDK call — safe for staging/CI.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

// ── Thresholds ────────────────────────────────────────────────────────────────

export const SFT_THRESHOLD = 200;
export const DPO_THRESHOLD = 100;

// ── Modal SDK (optional peer dep — guarded by DRY_RUN) ───────────────────────
// We import lazily so the server starts even when @modal-labs/modal is absent.

type ModalFunctionHandle = {
  spawn: (args: Record<string, unknown>) => Promise<unknown>;
};

async function getModalFunction(
  appName: string,
  fnName: string,
): Promise<ModalFunctionHandle> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const modal = await import("@modal-labs/modal").catch(() => {
    throw new Error(
      "Modal SDK not installed. Run: pnpm add @modal-labs/modal",
    );
  });
  return (modal as any).functions.fromName(appName, fnName) as ModalFunctionHandle;
}

// ── Threshold check + dispatch ────────────────────────────────────────────────

export async function checkThresholdsAndDispatch(): Promise<{
  dispatched: boolean;
  sftCount: number;
  dpoCount: number;
  jobId?: number;
  dryRun?: boolean;
}> {
  // Count unused SFT records
  const sftRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM zie_training_records WHERE used_for_sft = false`,
  );
  const sftCount = parseInt(sftRes.rows[0].count, 10);

  // Count unused DPO pairs
  const dpoRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM zie_preference_pairs WHERE used_for_dpo = false`,
  );
  const dpoCount = parseInt(dpoRes.rows[0].count, 10);

  if (sftCount < SFT_THRESHOLD || dpoCount < DPO_THRESHOLD) {
    logger.info(
      { sftCount, dpoCount, sftThreshold: SFT_THRESHOLD, dpoThreshold: DPO_THRESHOLD },
      "modalDispatch: thresholds not met — skipping dispatch",
    );
    return { dispatched: false, sftCount, dpoCount };
  }

  logger.info(
    { sftCount, dpoCount },
    "modalDispatch: thresholds met — creating training job and dispatching to Modal Forge",
  );

  // ── Create training_jobs row with compute_backend='modal' ─────────────────
  // Uses the system tenant / workspace reserved for autonomous flywheel jobs.
  // workspace_id=1 and dataset_id=1 are the bootstrap rows seeded at migration time.
  // If those rows don't exist yet, the INSERT will fail loudly — intentional.
  const jobRes = await pool.query<{ id: number }>(
    `INSERT INTO training_jobs
       (tenant_id, workspace_id, dataset_id, dataset_version_id,
        name, mode, base_model, hyperparams, status, compute_backend)
     VALUES
       ('system', 1, 1, 1,
        $1, 'fine_tuning', 'meta-llama/llama-3.2-1b-instruct',
        $2, 'queued', 'modal')
     RETURNING id`,
    [
      `flywheel-lora-sft${sftCount}-dpo${dpoCount}-${Date.now()}`,
      JSON.stringify({
        sft_samples: SFT_THRESHOLD,
        dpo_samples: DPO_THRESHOLD,
        lora_rank: 16,
        lora_alpha: 32,
        epochs: 3,
        learning_rate: 2e-4,
      }),
    ],
  );
  const jobId = jobRes.rows[0].id;

  // ── DRY_RUN guard ─────────────────────────────────────────────────────────
  if (process.env.DRY_RUN) {
    logger.info(
      { jobId, sftCount, dpoCount },
      "[DRY RUN] Would trigger Modal app: manuscript-trainer / train_lora",
    );
    return { dispatched: true, sftCount, dpoCount, jobId, dryRun: true };
  }

  // ── Spawn Modal LoRA job ──────────────────────────────────────────────────
  try {
    const trainFn = await getModalFunction("manuscript-trainer", "train_lora");
    await trainFn.spawn({
      jobId,
      sftSamples: SFT_THRESHOLD,
      dpoSamples: DPO_THRESHOLD,
    });

    // Mark records as consumed so they aren't double-counted on next threshold check
    await Promise.all([
      pool.query(
        `UPDATE zie_training_records
         SET used_for_sft = true
         WHERE id IN (
           SELECT id FROM zie_training_records
           WHERE used_for_sft = false
           ORDER BY created_at ASC
           LIMIT $1
         )`,
        [SFT_THRESHOLD],
      ),
      pool.query(
        `UPDATE zie_preference_pairs
         SET used_for_dpo = true
         WHERE id IN (
           SELECT id FROM zie_preference_pairs
           WHERE used_for_dpo = false
           ORDER BY created_at ASC
           LIMIT $1
         )`,
        [DPO_THRESHOLD],
      ),
    ]);

    logger.info({ jobId }, "modalDispatch: Modal LoRA job spawned successfully");
    return { dispatched: true, sftCount, dpoCount, jobId, dryRun: false };
  } catch (err: unknown) {
    // Update job to failed so it's visible in the Forge UI
    await pool.query(
      `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
      [err instanceof Error ? err.message : String(err), jobId],
    );
    logger.error({ err, jobId }, "modalDispatch: Modal spawn failed");
    throw err;
  }
}
