/**
 * draftVault.ts — synchronous ZIE vault writes with DB receipt (not hardcoded).
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import { scheduleAutoJudge } from "./vaultAutoJudge.js";

export interface VaultWriteReceipt {
  vault_written: boolean;
  prompt_hash: string;
  pair_id: string | null;
  sft_inserted: boolean;
  dpo_inserted: boolean;
  task_type: string;
  domain: string;
}

export async function persistDraftVault(params: {
  domain: string;
  taskType: string;
  sourceKind: string;
  preferenceSource: string;
  promptHash: string;
  promptJson: string;
  responseJson: string;
  qualityScore: number;
  chosenJson: string;
  rejectedJson: string;
}): Promise<VaultWriteReceipt> {
  const {
    domain,
    taskType,
    sourceKind,
    preferenceSource,
    promptHash,
    promptJson,
    responseJson,
    qualityScore,
    chosenJson,
    rejectedJson,
  } = params;

  const sftResult = await pool.query<{ id: string }>(
    `INSERT INTO zie_training_records
       (domain, task_type, source_kind, quality_score, prompt_hash,
        prompt_json, remote_response_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (prompt_hash) DO NOTHING
     RETURNING id`,
    [domain, taskType, sourceKind, qualityScore, promptHash, promptJson, responseJson],
  );

  let pairId: string | null = null;
  try {
    const pairResult = await pool.query<{ id: string }>(
      `INSERT INTO zie_preference_pairs
         (domain, task_type, preference_source,
          prompt_hash, chosen_response_json, rejected_response_json,
          source_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [domain, taskType, preferenceSource, promptHash, chosenJson, rejectedJson, sourceKind],
    );
    pairId = pairResult.rows[0]?.id ?? null;
  } catch (err: unknown) {
    logger.warn({ err, promptHash, taskType }, "draftVault: pair insert failed — looking up existing");
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM zie_preference_pairs
       WHERE prompt_hash = $1 AND task_type = $2
       ORDER BY created_at DESC LIMIT 1`,
      [promptHash, taskType],
    );
    pairId = existing.rows[0]?.id ?? null;
    if (!pairId) throw err;
  }
  const dpoInserted = pairId !== null;

  if (pairId) {
    scheduleAutoJudge(pairId, taskType);
  }

  return {
    vault_written: dpoInserted,
    prompt_hash: promptHash,
    pair_id: pairId,
    sft_inserted: sftResult.rowCount !== null && sftResult.rowCount > 0,
    dpo_inserted: dpoInserted,
    task_type: taskType,
    domain,
  };
}
