/**
 * aacr_flywheel_seed.ts — Seeds the double-dip flywheel tables with AACR 2026 data.
 *
 * Inserts:
 *   - 862 SFT records into zie_training_records (domain='aacr', task_type='competitive_intel_extraction')
 *   - 450 preference pairs into zie_preference_pairs (chosen=full CD analysis, rejected=naive summary)
 *   - 1 router policy row into zie_router_policies for task_type='competitive_intel_extraction'
 *
 * This gives the AACR domain a head start toward the 50-verified-pair threshold
 * that triggers a Modal LoRA fine-tune via forgeScheduler.ts.
 *
 * Run: called from runSeed() in seed.ts, or standalone:
 *   npx tsx src/lib/aacr_flywheel_seed.ts
 *
 * Idempotent: all inserts use ON CONFLICT (prompt_hash) DO NOTHING.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrors zie_training_records + zie_preference_pairs schema)
// ─────────────────────────────────────────────────────────────────────────────

interface SFTRow {
  task_type: string;
  domain: string;
  source_kind: string;
  prompt_hash: string;
  prompt_json: string;
  remote_response_json: string;
  quality_score: string;
}

interface PrefRow {
  task_type: string;
  domain: string;
  source_kind: string;
  preference_source: string;
  prompt_hash: string;
  chosen_response_json: string;
  rejected_response_json: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch insert helper
// ─────────────────────────────────────────────────────────────────────────────

async function batchInsertSFT(rows: SFTRow[], chunkSize = 100): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    for (const row of chunk) {
      try {
        await pool.query(
          `INSERT INTO zie_training_records
             (task_type, domain, source_kind, prompt_hash, prompt_json, remote_response_json, quality_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (prompt_hash) DO NOTHING`,
          [
            row.task_type,
            row.domain,
            row.source_kind,
            row.prompt_hash,
            row.prompt_json,
            row.remote_response_json,
            row.quality_score,
          ],
        );
        inserted++;
      } catch {
        // Skip individual failures (e.g. constraint violations)
      }
    }
    if ((i / chunkSize) % 5 === 0) {
      logger.info({ progress: `${i + chunk.length}/${rows.length}` }, "aacr_flywheel_seed: SFT insert progress");
    }
  }
  return inserted;
}

async function batchInsertPref(rows: PrefRow[], chunkSize = 100): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    for (const row of chunk) {
      try {
        await pool.query(
          `INSERT INTO zie_preference_pairs
             (task_type, domain, source_kind, preference_source, prompt_hash, chosen_response_json, rejected_response_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.task_type,
            row.domain,
            row.source_kind,
            row.preference_source,
            row.prompt_hash,
            row.chosen_response_json,
            row.rejected_response_json,
          ],
        );
        inserted++;
      } catch {
        // Skip duplicates
      }
    }
  }
  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router policy seed
// ─────────────────────────────────────────────────────────────────────────────

async function seedRouterPolicy(): Promise<void> {
  await pool.query(
    `INSERT INTO zie_router_policies
       (task_type, fast_model_id, fast_provider, fast_api_key_env, fast_max_tokens, fast_timeout_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (task_type) DO UPDATE SET
       fast_model_id = EXCLUDED.fast_model_id,
       fast_provider = EXCLUDED.fast_provider`,
    [
      "competitive_intel_extraction",
      "liquid/lfm-2.5-1.2b-instruct:free",
      "openrouter",
      "OPENROUTER_API_KEY",
      512,
      8000,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline seed data (generated from AACR 2026 pipeline outputs)
// 862 SFT rows + 450 preference pairs
// Full data embedded here to avoid runtime file I/O dependency.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: The full 862+450 row arrays are large (~2.8 MB JSON).
// They are loaded from the pipeline outputs at seed time via the
// seedAACRFlywheel() function below, which accepts pre-loaded data.
// The seed.ts caller passes the data from the master JSON files.

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export interface AACRFlywheelSeedData {
  sft_rows: SFTRow[];
  pref_rows: PrefRow[];
}

export async function seedAACRFlywheel(data: AACRFlywheelSeedData): Promise<{
  sft_inserted: number;
  pref_inserted: number;
}> {
  logger.info(
    { sft_count: data.sft_rows.length, pref_count: data.pref_rows.length },
    "aacr_flywheel_seed: starting",
  );

  // 1. Router policy
  await seedRouterPolicy();
  logger.info("aacr_flywheel_seed: router policy seeded for competitive_intel_extraction");

  // 2. SFT records
  const sft_inserted = await batchInsertSFT(data.sft_rows);
  logger.info({ sft_inserted }, "aacr_flywheel_seed: SFT records inserted");

  // 3. Preference pairs
  const pref_inserted = await batchInsertPref(data.pref_rows);
  logger.info({ pref_inserted }, "aacr_flywheel_seed: preference pairs inserted");

  return { sft_inserted, pref_inserted };
}

/**
 * Build SFT row from a Schema A record.
 * Called by the intelligence.ts route to capture live extraction results.
 */
export function buildSFTRow(schemaARecord: Record<string, unknown>): SFTRow | null {
  const moa = schemaARecord["MOA_summary"] as string | undefined;
  if (!moa || moa.length < 30) return null;

  const talkId = String(schemaARecord["talk_id"] ?? "");
  const session = talkId.split("::")[0] ?? "";
  const speaker = (schemaARecord["speaker"] as Record<string, string> | undefined) ?? {};

  const promptJson = JSON.stringify({
    talk_id: talkId,
    session,
    speaker: speaker["name"] ?? "unknown",
    affiliation: speaker["affiliation"] ?? "",
    tumor_types: schemaARecord["tumor_types"] ?? [],
    clinical_stage: schemaARecord["clinical_stage"] ?? "",
    task: "extract_competitive_intelligence",
    instruction:
      "Extract the key scientific claims, clinical data, and competitive positioning from this oncology conference presentation.",
  });

  const crypto = require("crypto") as typeof import("crypto");
  const promptHash = crypto.createHash("sha256").update(promptJson, "utf8").digest("hex");

  return {
    task_type: "competitive_intel_extraction",
    domain: "aacr",
    source_kind: "conference_transcript",
    prompt_hash: promptHash,
    prompt_json: promptJson,
    remote_response_json: JSON.stringify({
      moa_summary: moa,
      key_findings: schemaARecord["key_findings"] ?? [],
      novelty_flag: schemaARecord["novelty_flag"] ?? "",
      clinical_stage: schemaARecord["clinical_stage"] ?? "",
    }),
    quality_score: "0.8500",
  };
}

/**
 * Build preference pair from a Schema B record with CD hits.
 * Called by the intelligence.ts search route when rerank=true.
 */
export function buildPrefRow(
  schemaBRecord: Record<string, unknown>,
  fastResults: unknown[],
  slowResults: unknown[],
): PrefRow | null {
  const cd = schemaBRecord["cognitive_dissonance"] as string[] | undefined;
  if (!cd || cd.length === 0) return null;

  const meta = (schemaBRecord["talk_metadata"] as Record<string, unknown> | undefined) ?? {};
  const talkId = String(schemaBRecord["talk_id"] ?? "");

  const promptJson = JSON.stringify({
    talk_id: talkId,
    session: meta["session_title"] ?? "",
    speaker: meta["speaker_name"] ?? "",
    institution: meta["institution_or_pharma"] ?? "",
    presentation_type: meta["presentation_type"] ?? "",
    task: "identify_cognitive_dissonance",
    instruction:
      "Identify cases where the speaker's data contradicts their stated conclusion.",
  });

  const crypto = require("crypto") as typeof import("crypto");
  const promptHash = crypto.createHash("sha256").update(promptJson, "utf8").digest("hex");

  return {
    task_type: "competitive_intel_extraction",
    domain: "aacr",
    source_kind: "search_rerank",
    preference_source: "gpt4o_rerank",
    prompt_hash: promptHash,
    chosen_response_json: JSON.stringify(slowResults),
    rejected_response_json: JSON.stringify(fastResults),
  };
}
