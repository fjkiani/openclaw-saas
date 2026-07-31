/**
 * modalDispatch.ts
 *
 * ZIE Factory — Forge dispatcher + routing policy updater.
 *
 * SIMULATION NOTICE: The live Modal path requires @modal-labs/modal SDK to be
 * installed and MODAL_TOKEN_ID + MODAL_TOKEN_SECRET env vars to be set.
 * When DRY_RUN is set (current default), dispatchTraining() returns a stub
 * functionCallId without calling Modal. The training_jobs row is still created
 * in Postgres so the flywheel tracking is real — only the actual GPU training
 * is deferred. To enable live training: install the SDK, set DRY_RUN=false,
 * and provide Modal credentials.
 *
 * checkThresholdsAndDispatch():
 *   Counts unused SFT/DPO rows per task_type.
 *   When a task_type hits 200 SFT + 100 DPO, creates a training_jobs row
 *   with compute_backend='modal' and spawns a Modal LoRA fine-tune job.
 *   Runs for ALL task_types in a single hourly pass — Legal, Manuscript, SEO.
 *
 * updateRoutingPolicy():
 *   Called by the Modal webhook (or manually) after training completes.
 *   Writes the trained model ID into zie_router_policies for the task_type.
 *   executeDoubleDip() reads this table at invocation time — the fast path
 *   automatically starts using the fine-tuned LoRA adapter.
 *
 * dispatchTraining():
 *   Calls modal.functions.fromName("manuscript-trainer", "train_lora").spawn().
 *   DRY_RUN=true returns a stub functionCallId without hitting Modal.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

export const SFT_THRESHOLD = 200;
export const DPO_THRESHOLD = 100;
// Verified-DPO threshold: fires Modal when a task_type accumulates 50 judge-verified pairs.
// This is the primary training trigger — quality signal, not raw volume.
export const VERIFIED_DPO_THRESHOLD = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskTypeCount {
  task_type: string;
  sft_count: number;
  dpo_count: number;
}

export interface DispatchResult {
  task_type: string;
  dispatched: boolean;
  sftCount: number;
  dpoCount: number;
  jobId?: number;
  functionCallId?: string;
  dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatchTraining — calls Modal or returns DRY_RUN stub
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchTraining(
  jobId: number,
  taskType: string,
  sftCount: number,
  dpoCount: number,
): Promise<string> {
  if (process.env.DRY_RUN) {
    const stubId = `dry-run-${taskType}-${jobId}-${Date.now()}`;
    logger.info(
      { jobId, taskType, sftCount, dpoCount, functionCallId: stubId },
      "[DRY RUN] Would call modal.functions.fromName('manuscript-trainer', 'train_lora').spawn()",
    );
    return stubId;
  }

  // Live path — requires @modal-labs/modal + MODAL_TOKEN_ID + MODAL_TOKEN_SECRET
  // @ts-ignore — @modal-labs/modal is an optional runtime dep; not installed in dev
  const modal = await import("@modal-labs/modal").catch(() => {
    throw new Error(
      "Modal SDK not installed. Run: pnpm add @modal-labs/modal in artifacts/api-server",
    );
  });

  const trainFn = (modal as any).functions.fromName(
    "manuscript-trainer",
    "train_lora",
  ) as {
    spawn: (args: Record<string, unknown>) => Promise<{ object_id: string }>;
  };

  const call = await trainFn.spawn({
    jobId,
    taskType,
    sftSamples: SFT_THRESHOLD,
    dpoPairs: DPO_THRESHOLD,
  });

  return call.object_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// updateRoutingPolicy — deployment payoff
//
// Called after Modal completes training. Writes the new model ID into
// zie_router_policies so executeDoubleDip() uses the fine-tuned fast path.
// ─────────────────────────────────────────────────────────────────────────────

export async function updateRoutingPolicy(params: {
  taskType: string;
  trainedModelId: string;
  provider: string;
  apiKeyEnv: string;
  maxTokens: number;
  timeoutMs: number;
  sourceJobId: number;
}): Promise<void> {
  const { taskType, trainedModelId, provider, apiKeyEnv, maxTokens, timeoutMs, sourceJobId } = params;

  await pool.query(
    `INSERT INTO zie_router_policies
       (task_type, fast_model_id, fast_provider, fast_api_key_env,
        fast_max_tokens, fast_timeout_ms, source_job_id, promoted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (task_type) DO UPDATE SET
       fast_model_id    = EXCLUDED.fast_model_id,
       fast_provider    = EXCLUDED.fast_provider,
       fast_api_key_env = EXCLUDED.fast_api_key_env,
       fast_max_tokens  = EXCLUDED.fast_max_tokens,
       fast_timeout_ms  = EXCLUDED.fast_timeout_ms,
       source_job_id    = EXCLUDED.source_job_id,
       promoted_at      = NOW(),
       updated_at       = NOW()`,
    [taskType, trainedModelId, provider, apiKeyEnv, maxTokens, timeoutMs, sourceJobId],
  );

  logger.info(
    { taskType, trainedModelId, sourceJobId },
    "modalDispatch: routing policy updated — fast path now uses fine-tuned model",
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// checkVerifiedThresholds — fires Modal when any task_type hits 50 judge-verified pairs
//
// Checks per task_type (not per domain) so legal_clause_analysis and
// legal_clause_draft are tracked independently and train on the correct data mix.
// ─────────────────────────────────────────────────────────────────────────────

export async function checkVerifiedThresholds(): Promise<DispatchResult[]> {
  // Count judge-verified pairs per task_type
  const verifiedRes = await pool.query<{ domain: string; task_type: string; verified_count: string }>(
    `SELECT domain, task_type, COUNT(*) AS verified_count
     FROM zie_preference_pairs
     WHERE judge_verified = true
     GROUP BY domain, task_type
     HAVING COUNT(*) >= $1`,
    [VERIFIED_DPO_THRESHOLD],
  );

  if (verifiedRes.rows.length === 0) {
    logger.info({ threshold: VERIFIED_DPO_THRESHOLD }, "modalDispatch: no task_type has reached verified DPO threshold");
    return [];
  }

  const results: DispatchResult[] = [];

  for (const row of verifiedRes.rows) {
    const { domain, task_type, verified_count } = row;
    const verifiedCount = parseInt(verified_count, 10);

    // Check if a training job already exists for this task_type to avoid double-dispatch
    const existingJob = await pool.query<{ id: number }>(
      `SELECT id FROM training_jobs
       WHERE name LIKE $1 AND status IN ('queued', 'running', 'completed')
       ORDER BY id DESC LIMIT 1`,
      [`flywheel-verified-${task_type}%`],
    );

    if (existingJob.rows.length > 0) {
      logger.info({ task_type, existingJobId: existingJob.rows[0].id }, "modalDispatch: verified threshold met but job already exists — skipping");
      continue;
    }

    logger.info({ domain, task_type, verifiedCount, threshold: VERIFIED_DPO_THRESHOLD }, "modalDispatch: verified DPO threshold met — inserting training job");

    const jobRes = await pool.query<{ id: number }>(
      `INSERT INTO training_jobs
         (tenant_id, workspace_id, dataset_id, dataset_version_id,
          name, mode, base_model, hyperparams, status, compute_backend)
       VALUES
         ('system', 1, 1, 1,
          $1, 'fine_tuning', 'liquid/lfm-2.5-1.2b:free',
          $2, 'queued', 'modal')
       RETURNING id`,
      [
        `flywheel-verified-${task_type}-dpo${verifiedCount}-${Date.now()}`,
        JSON.stringify({
          domain,
          task_type,
          trigger: "verified_dpo_threshold",
          verified_dpo_pairs: verifiedCount,
          threshold: VERIFIED_DPO_THRESHOLD,
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
      functionCallId = await dispatchTraining(jobId, task_type, 0, verifiedCount);
    } catch (err: unknown) {
      await pool.query(
        `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
        [err instanceof Error ? err.message : String(err), jobId],
      );
      logger.error({ err, jobId, task_type }, "modalDispatch: verified dispatch failed");
      throw err;
    }

    logger.info({ jobId, functionCallId, task_type, verifiedCount }, "modalDispatch: verified-DPO Modal LoRA job spawned");

    results.push({
      task_type,
      dispatched: true,
      sftCount: 0,
      dpoCount: verifiedCount,
      jobId,
      functionCallId,
      dryRun: !!process.env.DRY_RUN,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkThresholdsAndDispatch — runs for ALL task_types in one pass
// ─────────────────────────────────────────────────────────────────────────────

export async function checkThresholdsAndDispatch(): Promise<DispatchResult[]> {
  // Count unused SFT records grouped by task_type
  const sftRes = await pool.query<{ task_type: string; count: string }>(
    `SELECT task_type, COUNT(*) AS count
     FROM zie_training_records
     WHERE used_for_sft = false
     GROUP BY task_type`,
  );

  // Count unused DPO pairs grouped by task_type
  const dpoRes = await pool.query<{ task_type: string; count: string }>(
    `SELECT task_type, COUNT(*) AS count
     FROM zie_preference_pairs
     WHERE used_for_dpo = false
     GROUP BY task_type`,
  );

  // Build lookup maps
  const sftByType = new Map<string, number>();
  for (const row of sftRes.rows) {
    sftByType.set(row.task_type, parseInt(row.count, 10));
  }

  const dpoByType = new Map<string, number>();
  for (const row of dpoRes.rows) {
    dpoByType.set(row.task_type, parseInt(row.count, 10));
  }

  // Union of all task_types seen in either table
  const allTaskTypes = new Set([...sftByType.keys(), ...dpoByType.keys()]);

  const results: DispatchResult[] = [];

  for (const taskType of allTaskTypes) {
    const sftCount = sftByType.get(taskType) ?? 0;
    const dpoCount = dpoByType.get(taskType) ?? 0;

    logger.info(
      { taskType, sftCount, dpoCount, sftThreshold: SFT_THRESHOLD, dpoThreshold: DPO_THRESHOLD },
      "modalDispatch: threshold check",
    );

    if (sftCount < SFT_THRESHOLD || dpoCount < DPO_THRESHOLD) {
      results.push({ task_type: taskType, dispatched: false, sftCount, dpoCount, dryRun: !!process.env.DRY_RUN });
      continue;
    }

    // Thresholds met — create training_jobs row
    logger.info({ taskType, sftCount, dpoCount }, "modalDispatch: thresholds met — inserting training job");

    const jobRes = await pool.query<{ id: number }>(
      `INSERT INTO training_jobs
         (tenant_id, workspace_id, dataset_id, dataset_version_id,
          name, mode, base_model, hyperparams, status, compute_backend)
       VALUES
         ('system', 1, 1, 1,
          $1, 'fine_tuning', 'liquid/lfm-2.5-1.2b:free',
          $2, 'queued', 'modal')
       RETURNING id`,
      [
        `flywheel-${taskType}-sft${sftCount}-dpo${dpoCount}-${Date.now()}`,
        JSON.stringify({
          task_type: taskType,
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
      functionCallId = await dispatchTraining(jobId, taskType, sftCount, dpoCount);
    } catch (err: unknown) {
      await pool.query(
        `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
        [err instanceof Error ? err.message : String(err), jobId],
      );
      logger.error({ err, jobId, taskType }, "modalDispatch: dispatch failed");
      throw err;
    }

    // Mark consumed records — prevent double-counting on next hourly check
    await Promise.all([
      pool.query(
        `UPDATE zie_training_records
         SET used_for_sft = true
         WHERE id IN (
           SELECT id FROM zie_training_records
           WHERE used_for_sft = false AND task_type = $1
           ORDER BY created_at ASC
           LIMIT $2
         )`,
        [taskType, SFT_THRESHOLD],
      ),
      pool.query(
        `UPDATE zie_preference_pairs
         SET used_for_dpo = true
         WHERE id IN (
           SELECT id FROM zie_preference_pairs
           WHERE used_for_dpo = false AND task_type = $1
           ORDER BY created_at ASC
           LIMIT $2
         )`,
        [taskType, DPO_THRESHOLD],
      ),
    ]);

    logger.info({ jobId, functionCallId, taskType }, "modalDispatch: Modal LoRA job spawned");

    results.push({
      task_type: taskType,
      dispatched: true,
      sftCount,
      dpoCount,
      jobId,
      functionCallId,
      dryRun: !!process.env.DRY_RUN,
    });
  }

  return results;
}
