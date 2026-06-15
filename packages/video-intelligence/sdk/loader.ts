/**
 * loader.ts — Batch insert helpers for loading AACR pipeline outputs into Supabase.
 *
 * Used by the extractor pipeline (Python side calls these via REST directly,
 * but this TypeScript version is available for Node.js-based loaders or
 * for re-loading from the master JSON files).
 *
 * All inserts use ON CONFLICT DO NOTHING (idempotent).
 */

import type { AACRSpeaker, CompetitiveIntel, ClinicalData } from "./types.js";

export interface LoaderConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  chunkSize?: number;
}

async function batchInsert(
  config: LoaderConfig,
  table: string,
  rows: Record<string, unknown>[],
): Promise<{ inserted: number; errors: string[] }> {
  const { supabaseUrl, serviceRoleKey, chunkSize = 100 } = config;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=ignore-duplicates",
  };

  let inserted = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers,
      body: JSON.stringify(chunk),
    });

    if (res.status === 200 || res.status === 201) {
      inserted += chunk.length;
    } else {
      const body = await res.text().catch(() => "");
      errors.push(`chunk ${Math.floor(i / chunkSize)}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
  }

  return { inserted, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public loader functions
// ─────────────────────────────────────────────────────────────────────────────

export async function loadSessions(
  config: LoaderConfig,
  slugs: string[],
): Promise<{ inserted: number; errors: string[] }> {
  const rows = slugs.map((slug) => ({
    slug,
    title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
  return batchInsert(config, "aacr_sessions", rows);
}

export async function loadSpeakers(
  config: LoaderConfig,
  speakers: Partial<AACRSpeaker>[],
): Promise<{ inserted: number; errors: string[] }> {
  return batchInsert(config, "aacr_speakers", speakers as Record<string, unknown>[]);
}

export async function loadCompetitiveIntel(
  config: LoaderConfig,
  records: Partial<CompetitiveIntel>[],
): Promise<{ inserted: number; errors: string[] }> {
  return batchInsert(config, "aacr_competitive_intel", records as Record<string, unknown>[]);
}

export async function loadClinicalData(
  config: LoaderConfig,
  records: Partial<ClinicalData>[],
): Promise<{ inserted: number; errors: string[] }> {
  return batchInsert(config, "aacr_clinical_data", records as Record<string, unknown>[]);
}

export async function loadEmbeddings(
  config: LoaderConfig,
  embeddings: Array<{
    source_table: string;
    source_id: number;
    talk_id: string | null;
    speaker_name: string | null;
    session_slug: string | null;
    field_name: string;
    chunk_text: string;
    embedding: number[];
  }>,
): Promise<{ inserted: number; errors: string[] }> {
  return batchInsert(config, "aacr_embeddings", embeddings as Record<string, unknown>[]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline loader (loads all tables from master JSON files)
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineLoadResult {
  sessions: { inserted: number; errors: string[] };
  speakers: { inserted: number; errors: string[] };
  competitive_intel: { inserted: number; errors: string[] };
  clinical_data: { inserted: number; errors: string[] };
}

/**
 * Load a complete pipeline run from pre-aggregated master JSON files.
 * Expects the same format as schema_a_master.json and schema_b_master.json.
 */
export async function loadPipelineRun(
  config: LoaderConfig,
  schemaA: Record<string, unknown>[],
  schemaB: Record<string, unknown>[],
  clinicalData: Record<string, unknown>[],
): Promise<PipelineLoadResult> {
  // Extract unique slugs
  const slugSet = new Set<string>();
  for (const rec of schemaA) {
    const talkId = String(rec["talk_id"] ?? "");
    const slug = talkId.split("::")[0];
    if (slug) slugSet.add(slug);
  }
  for (const rec of schemaB) {
    const meta = rec["talk_metadata"] as Record<string, unknown> | undefined;
    const slug = String(meta?.["session_title"] ?? "");
    if (slug) slugSet.add(slug);
  }

  const sessions = await loadSessions(config, Array.from(slugSet));
  const speakers = await loadSpeakers(config, schemaA as Partial<AACRSpeaker>[]);
  const competitive_intel = await loadCompetitiveIntel(config, schemaB as Partial<CompetitiveIntel>[]);
  const clinical_data = await loadClinicalData(config, clinicalData as Partial<ClinicalData>[]);

  return { sessions, speakers, competitive_intel, clinical_data };
}
