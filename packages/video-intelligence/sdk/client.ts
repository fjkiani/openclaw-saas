/**
 * client.ts — Supabase REST client for the AACR 2026 Intelligence corpus.
 *
 * Uses the Supabase REST API (no direct DB connection needed).
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 *
 * Usage:
 *   import { createAACRClient } from '@workspace/video-intelligence/sdk/client';
 *   const aacr = createAACRClient();
 *   const speakers = await aacr.getSpeakers({ tumor_type: 'colorectal cancer', limit: 20 });
 */

import type {
  AACRSession,
  AACRSpeaker,
  CompetitiveIntel,
  ClinicalData,
  SpeakerFilter,
  CDHitFilter,
  CrisPROFilter,
  SemanticSearchRequest,
  SemanticSearchResult,
  CorpusStats,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface AACRClientConfig {
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

function resolveConfig(config?: AACRClientConfig) {
  const url = config?.supabaseUrl ?? process.env.SUPABASE_URL ?? process.env.AACR_SUPABASE_URL;
  const key =
    config?.serviceRoleKey ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.AACR_SERVICE_ROLE_KEY;

  if (!url) throw new Error("AACR client: SUPABASE_URL is not set");
  if (!key) throw new Error("AACR client: SUPABASE_SERVICE_ROLE_KEY is not set");

  return { url: url.replace(/\/$/, ""), key };
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level fetch
// ─────────────────────────────────────────────────────────────────────────────

async function supabaseGet<T>(
  url: string,
  key: string,
  path: string,
  params: Record<string, string> = {},
  countExact = false,
): Promise<{ data: T[]; count: number | null }> {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${url}/rest/v1/${path}${qs ? "?" + qs : ""}`;

  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (countExact) headers["Prefer"] = "count=exact";

  const res = await fetch(fullUrl, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AACR client GET ${path}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as T[];
  const contentRange = res.headers.get("content-range");
  let count: number | null = null;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) count = parseInt(match[1], 10);
  }
  return { data, count };
}

async function supabaseRpc<T>(
  url: string,
  key: string,
  fn: string,
  body: Record<string, unknown>,
): Promise<T[]> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AACR client RPC ${fn}: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAACRClient(config?: AACRClientConfig) {
  const { url, key } = resolveConfig(config);

  return {
    // ── Sessions ──────────────────────────────────────────────────────────────
    async getSessions(limit = 50, offset = 0): Promise<AACRSession[]> {
      const { data } = await supabaseGet<AACRSession>(url, key, "aacr_sessions", {
        select: "id,slug,title,created_at",
        limit: String(limit),
        offset: String(offset),
        order: "slug.asc",
      });
      return data;
    },

    // ── Speakers (Schema A) ───────────────────────────────────────────────────
    async getSpeakers(filter: SpeakerFilter = {}): Promise<AACRSpeaker[]> {
      const params: Record<string, string> = {
        select: "*",
        limit: String(filter.limit ?? 50),
        offset: String(filter.offset ?? 0),
        order: "id.asc",
      };
      if (filter.clinical_stage) params["clinical_stage"] = `eq.${filter.clinical_stage}`;
      if (filter.novelty_flag) params["novelty_flag"] = `eq.${filter.novelty_flag}`;
      if (filter.session_slug) params["session_slug"] = `eq.${filter.session_slug}`;
      if (filter.tumor_type) params["tumor_types"] = `cs.{${filter.tumor_type}}`;

      const { data } = await supabaseGet<AACRSpeaker>(url, key, "aacr_speakers", params);
      return data;
    },

    async getSpeakerByTalkId(talkId: string): Promise<AACRSpeaker | null> {
      const { data } = await supabaseGet<AACRSpeaker>(url, key, "aacr_speakers", {
        select: "*",
        talk_id: `eq.${talkId}`,
        limit: "1",
      });
      return data[0] ?? null;
    },

    // ── Competitive Intel (Schema B) ──────────────────────────────────────────
    async getCDHits(filter: CDHitFilter = {}): Promise<CompetitiveIntel[]> {
      const params: Record<string, string> = {
        select: "id,talk_id,speaker_name,institution,session_slug,presentation_type,data_maturity,cognitive_dissonance,crispro_opportunity",
        limit: String(filter.limit ?? 50),
        offset: String(filter.offset ?? 0),
        order: "id.asc",
      };
      if (filter.presentation_type) params["presentation_type"] = `eq.${filter.presentation_type}`;
      if (filter.data_maturity) params["data_maturity"] = `eq.${filter.data_maturity}`;

      const { data } = await supabaseGet<CompetitiveIntel>(url, key, "aacr_competitive_intel", params);

      // Filter by min CD count client-side (array length filter not supported in REST)
      if (filter.min_cd_count && filter.min_cd_count > 0) {
        return data.filter(
          (r) => Array.isArray(r.cognitive_dissonance) && r.cognitive_dissonance.length >= filter.min_cd_count!,
        );
      }
      return data;
    },

    async getCrisPROOpportunities(filter: CrisPROFilter = {}): Promise<CompetitiveIntel[]> {
      const params: Record<string, string> = {
        select: "id,talk_id,speaker_name,institution,session_slug,presentation_type,crispro_opportunity",
        limit: String(filter.limit ?? 100),
        offset: String(filter.offset ?? 0),
      };
      if (filter.presentation_type) params["presentation_type"] = `eq.${filter.presentation_type}`;

      const { data } = await supabaseGet<CompetitiveIntel>(url, key, "aacr_competitive_intel", params);

      // Filter by opportunity_type and priority client-side
      return data.filter((r) => {
        if (!Array.isArray(r.crispro_opportunity) || r.crispro_opportunity.length === 0) return false;
        if (filter.opportunity_type) {
          return r.crispro_opportunity.some((o) => o.opportunity_type === filter.opportunity_type);
        }
        if (filter.priority) {
          return r.crispro_opportunity.some((o) => o.priority === filter.priority);
        }
        return true;
      });
    },

    // ── Clinical Data ─────────────────────────────────────────────────────────
    async getClinicalData(
      talkId?: string,
      metric?: string,
      limit = 100,
    ): Promise<ClinicalData[]> {
      const params: Record<string, string> = {
        select: "*",
        limit: String(limit),
        order: "id.asc",
      };
      if (talkId) params["talk_id"] = `eq.${talkId}`;
      if (metric) params["metric"] = `eq.${metric}`;

      const { data } = await supabaseGet<ClinicalData>(url, key, "aacr_clinical_data", params);
      return data;
    },

    // ── Semantic Search ───────────────────────────────────────────────────────
    async semanticSearch(
      request: SemanticSearchRequest,
      embeddingVector: number[],
    ): Promise<SemanticSearchResult[]> {
      return supabaseRpc<SemanticSearchResult>(url, key, "match_embeddings", {
        query_embedding: embeddingVector,
        match_field: request.field ?? null,
        match_count: request.match_count ?? 10,
        match_threshold: request.match_threshold ?? 0.65,
      });
    },

    // ── Corpus Stats ──────────────────────────────────────────────────────────
    async getStats(): Promise<CorpusStats> {
      const [sessions, speakers, ci, clinical, embeddings] = await Promise.all([
        supabaseGet<{ count: string }>(url, key, "aacr_sessions", { select: "count" }, true),
        supabaseGet<{ count: string }>(url, key, "aacr_speakers", { select: "count" }, true),
        supabaseGet<{ count: string }>(url, key, "aacr_competitive_intel", { select: "count" }, true),
        supabaseGet<{ count: string }>(url, key, "aacr_clinical_data", { select: "count" }, true),
        supabaseGet<{ field_name: string }>(url, key, "aacr_embeddings", { select: "field_name" }),
      ]);

      const embByField: Record<string, number> = {};
      for (const row of embeddings.data) {
        embByField[row.field_name] = (embByField[row.field_name] ?? 0) + 1;
      }

      return {
        sessions: sessions.count ?? 0,
        speakers: speakers.count ?? 0,
        competitive_intel_records: ci.count ?? 0,
        clinical_data_entries: clinical.count ?? 0,
        embeddings: embeddings.data.length,
        embeddings_by_field: embByField as CorpusStats["embeddings_by_field"],
        presentation_type_distribution: {},
        clinical_stage_distribution: {},
        top_companies: [],
      };
    },
  };
}

export type AACRClient = ReturnType<typeof createAACRClient>;
