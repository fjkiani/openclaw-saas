import { pool } from "@workspace/db";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

export const SFT_THRESHOLD = 200;
export const DPO_THRESHOLD = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Modal SDK — imported at call time so the server starts without it installed.
// Set DRY_RUN=true to bypass the actual spawn and return a stub functionCallId.
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  dispatched: boolean;
  sftCount: number;
  dpoCount: number;
  jobId?: number;
  functionCallId?: string;
  dryRun: boolean;
}

export async function dispatchTraining(
  jobId: number,
  sftCount: number,
  dpoCount: number,
): Promise<string> {
  if (process.env.DRY_RUN) {
    const stubId = `dry-run-${jobId}-${Date.now()}`;
    logger.info(
      { jobId, sftCount, dpoCount, functionCallId: stubId },
      "[DRY RUN] Would call modal.functions.fromName('manuscript-trainer', 'train_lora').spawn()",
    );
    return stubId;
  }

  // Live path — requires @modal-labs/modal installed and MODAL_TOKEN_ID / MODAL_TOKEN_SECRET set
  const modal = await import("@modal-labs/modal").catch(() => {
    throw new Error(
      "Modal SDK not installed. Run: pnpm add @modal-labs/modal in artifacts/api-server",
    );
  });

  const trainFn = (modal as any).functions.fromName(
    "manuscript-trainer",
    "train_lora",
  ) as { spawn: (args: Record<string, unknown>) => Promise<{ object_id: string }> };

  const call = await trainFn.spawn({
    jobId,
    sftSamples: SFT_THRESHOLD,
    dpoSamples: DPO_THRESHOLD,
  });

  return call.object_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold check + dispatch
// ─────────────────────────────────────────────────────────────────────────────

export async function checkThresholdsAndDispatch(): Promise<DispatchResult> {
  const sftRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM zie_training_records WHERE used_for_sft = false`,
  );
  const sftCount = parseInt(sftRes.rows[0].count, 10);

  const dpoRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM zie_preference_pairs WHERE used_for_dpo = false`,
  );
  const dpoCount = parseInt(dpoRes.rows[0].count, 10);

  if (sftCount < SFT_THRESHOLD || dpoCount < DPO_THRESHOLD) {
    logger.info(
      { sftCount, dpoCount, sftThreshold: SFT_THRESHOLD, dpoThreshold: DPO_THRESHOLD },
      "modalDispatch: thresholds not met",
    );
    return { dispatched: false, sftCount, dpoCount, dryRun: !!process.env.DRY_RUN };
  }

  logger.info({ sftCount, dpoCount }, "modalDispatch: thresholds met — inserting training job");

  const jobRes = await pool.query<{ id: number }>(
    `INSERT INTO training_jobs
       (tenant_id, workspace_id, dataset_id, dataset_version_id,
        name, mode, base_model, hyperparams, status, compute_backend)
     VALUES
       ('system', 1, 1, 1,
        $1, 'fine_tuning', 'liquid/lfm-2.5-1.2b',
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

  let functionCallId: string;
  try {
    functionCallId = await dispatchTraining(jobId, sftCount, dpoCount);
  } catch (err: unknown) {
    await pool.query(
      `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
      [err instanceof Error ? err.message : String(err), jobId],
    );
    logger.error({ err, jobId }, "modalDispatch: dispatch failed — job marked failed");
    throw err;
  }

  // Mark consumed records so they don't re-trigger on the next hourly check
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

  logger.info({ jobId, functionCallId }, "modalDispatch: Modal LoRA job spawned");
  return {
    dispatched: true,
    sftCount,
    dpoCount,
    jobId,
    functionCallId,
    dryRun: !!process.env.DRY_RUN,
  };
}
