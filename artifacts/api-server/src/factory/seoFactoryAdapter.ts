/**
 * seoFactoryAdapter.ts
 *
 * Maps a completed SEO double-dip result into the ZIE flywheel tables:
 *   - zie_training_records  (SFT vault — 120B gold output)
 *   - zie_preference_pairs  (DPO vault — remote beats local)
 *
 * Design constraints:
 *   1. Raw pool.query() only — no Drizzle ORM (matches doubleDipRouter.ts pattern)
 *   2. SFT record inserted first; its returned UUID is used as chosenTrainingRecordId
 *   3. A separate SFT record is inserted for the local (1.2B) response and used as
 *      rejectedTrainingRecordId — enforces chosen ≠ rejected at the FK level
 *   4. ON CONFLICT (prompt_hash) DO NOTHING on SFT inserts — idempotent re-runs
 *   5. Returns { sftRecordId, localRecordId, dpoRecordId } for acceptance-gate queries
 *   6. All new factory columns from migration 0004 are populated
 */

import { randomUUID } from "crypto";
import { pool } from "@workspace/db";
import type { SeoSynthesis } from "../lib/seoAgent";

// ── Input / Output types ──────────────────────────────────────────────────────

export interface SeoFactoryInput {
  /** SHA-256 hex digest of the deterministic prompt pre-image */
  promptHash: string;
  /** Full prompt payload sent to both dips */
  promptJson: unknown;
  /** 120B remote result (chosen — SFT gold) */
  remoteResult: SeoSynthesis;
  /** 1.2B local result (rejected — DPO negative) */
  localResult: { data: SeoSynthesis; confidence: number };
  /** Multi-tenant context */
  tenantId?: string | null;
  workspaceId?: number | null;
  datasetVersionId?: number | null;
  modelVersionId?: number | null;
}

export interface SeoFactoryResult {
  /** UUID of the zie_training_records row for the 120B (chosen) response */
  sftRecordId: string;
  /** UUID of the zie_training_records row for the 1.2B (local/rejected) response */
  localRecordId: string;
  /** UUID of the zie_preference_pairs row */
  dpoRecordId: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_TYPE = "seo_audit" as const;
const DOMAIN = "seo" as const;
const SOURCE_KIND_REMOTE = "remote_promoted" as const;
const SOURCE_KIND_LOCAL = "local_rejected" as const;
const PREFERENCE_SOURCE = "remote_beats_local" as const;
const QUALITY_SCORE_REMOTE = "1.0000" as const;
const QUALITY_SCORE_LOCAL = "0.5000" as const;

// ── Main adapter function ─────────────────────────────────────────────────────

/**
 * Persists one double-dip SEO audit result into the ZIE flywheel.
 *
 * Execution order (must be sequential — DPO FKs depend on SFT UUIDs):
 *   1. INSERT remote (120B) → zie_training_records  → capture sftRecordId
 *   2. INSERT local  (1.2B) → zie_training_records  → capture localRecordId
 *   3. INSERT DPO pair      → zie_preference_pairs  → capture dpoRecordId
 *
 * Steps 1 and 2 use ON CONFLICT DO NOTHING so re-runs are safe.
 * Step 3 always inserts a new DPO row (preference pairs are append-only).
 */
export async function persistSeoFlywheelData(
  input: SeoFactoryInput,
): Promise<SeoFactoryResult> {
  const {
    promptHash,
    promptJson,
    remoteResult,
    localResult,
    tenantId = null,
    workspaceId = null,
    datasetVersionId = null,
    modelVersionId = null,
  } = input;

  // One UUID per audit run — ties both SFT rows and the DPO row to the same request
  const sourceRunId = randomUUID();
  // source_analysis_ref = the prompt hash (human-readable audit trail)
  const sourceAnalysisRef = promptHash;

  // ── Step 1: Insert remote (120B) SFT record ───────────────────────────────
  //
  // ON CONFLICT (prompt_hash) DO NOTHING means:
  //   - First call: inserts and returns the new UUID
  //   - Subsequent calls with same hash: no-op, returns existing UUID via SELECT
  //
  const sftInsertResult = await pool.query<{ id: string }>(
    `INSERT INTO zie_training_records
       (task_type, prompt_hash, prompt_json, remote_response_json, quality_score,
        domain, tenant_id, workspace_id, dataset_version_id, model_version_id,
        source_kind, source_run_id, source_analysis_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (prompt_hash) DO NOTHING
     RETURNING id`,
    [
      TASK_TYPE,
      promptHash,
      JSON.stringify(promptJson),
      JSON.stringify(remoteResult),
      QUALITY_SCORE_REMOTE,
      DOMAIN,
      tenantId,
      workspaceId,
      datasetVersionId,
      modelVersionId,
      SOURCE_KIND_REMOTE,
      sourceRunId,
      sourceAnalysisRef,
    ],
  );

  // If ON CONFLICT fired (duplicate prompt_hash), fetch the existing UUID
  let sftRecordId: string;
  if (sftInsertResult.rows.length > 0) {
    sftRecordId = sftInsertResult.rows[0].id;
  } else {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM zie_training_records WHERE prompt_hash = $1 AND source_kind = $2 LIMIT 1`,
      [promptHash, SOURCE_KIND_REMOTE],
    );
    if (existing.rows.length === 0) {
      throw new Error(
        `seoFactoryAdapter: SFT remote record not found after conflict for hash=${promptHash}`,
      );
    }
    sftRecordId = existing.rows[0].id;
  }

  // ── Step 2: Insert local (1.2B) SFT record ────────────────────────────────
  //
  // The local response gets its own prompt_hash variant to avoid collision with
  // the remote record's unique constraint. We suffix with ":local" to distinguish.
  //
  const localPromptHash = `${promptHash}:local`;

  const localInsertResult = await pool.query<{ id: string }>(
    `INSERT INTO zie_training_records
       (task_type, prompt_hash, prompt_json, remote_response_json, quality_score,
        domain, tenant_id, workspace_id, dataset_version_id, model_version_id,
        source_kind, source_run_id, source_analysis_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (prompt_hash) DO NOTHING
     RETURNING id`,
    [
      TASK_TYPE,
      localPromptHash,
      JSON.stringify(promptJson),
      JSON.stringify(localResult.data),
      QUALITY_SCORE_LOCAL,
      DOMAIN,
      tenantId,
      workspaceId,
      datasetVersionId,
      modelVersionId,
      SOURCE_KIND_LOCAL,
      sourceRunId,
      sourceAnalysisRef,
    ],
  );

  let localRecordId: string;
  if (localInsertResult.rows.length > 0) {
    localRecordId = localInsertResult.rows[0].id;
  } else {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM zie_training_records WHERE prompt_hash = $1 AND source_kind = $2 LIMIT 1`,
      [localPromptHash, SOURCE_KIND_LOCAL],
    );
    if (existing.rows.length === 0) {
      throw new Error(
        `seoFactoryAdapter: SFT local record not found after conflict for hash=${localPromptHash}`,
      );
    }
    localRecordId = existing.rows[0].id;
  }

  // ── Invariant: chosen ≠ rejected ─────────────────────────────────────────
  if (sftRecordId === localRecordId) {
    throw new Error(
      `seoFactoryAdapter: chosen_training_record_id === rejected_training_record_id (${sftRecordId}). ` +
        "This violates the DPO pair invariant. Check prompt_hash collision logic.",
    );
  }

  // ── Step 3: Insert DPO preference pair ───────────────────────────────────
  const dpoInsertResult = await pool.query<{ id: string }>(
    `INSERT INTO zie_preference_pairs
       (task_type, prompt_hash, chosen_response_json, rejected_response_json,
        domain, tenant_id, workspace_id,
        chosen_training_record_id, rejected_training_record_id, preference_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      TASK_TYPE,
      promptHash,
      JSON.stringify(remoteResult),
      JSON.stringify(localResult.data),
      DOMAIN,
      tenantId,
      workspaceId,
      sftRecordId,
      localRecordId,
      PREFERENCE_SOURCE,
    ],
  );

  if (dpoInsertResult.rows.length === 0) {
    throw new Error(
      `seoFactoryAdapter: DPO insert returned no rows for hash=${promptHash}`,
    );
  }

  const dpoRecordId = dpoInsertResult.rows[0].id;

  return { sftRecordId, localRecordId, dpoRecordId };
}
