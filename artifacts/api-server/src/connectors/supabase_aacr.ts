/**
 * supabase_aacr.ts — Supabase AACR Intelligence connector
 *
 * A real (non-mock) connector that exposes the AACR 2026 corpus stored in
 * Supabase project xfhiwodulrbbtfcqneqt as a named connector in the
 * openclaw-saas connector registry.
 *
 * Structured data (speakers, CD hits, CrisPRO) comes from Supabase REST API.
 * Semantic search uses Qdrant (openclaw_aacr collection, 1536-dim) instead of
 * Supabase pgvector. Embeddings generated via Gemini gemini-embedding-001
 * (3072-dim truncated to 1536-dim).
 *
 * Connector slug: 'supabase-aacr'
 * Category: 'research_intelligence'
 *
 * Installed via: POST /api/tenants/:id/connectors
 * Credentials stored encrypted in tenant_connectors.encrypted_credentials
 *
 * Required credentials (stored per-tenant):
 *   supabase_url          — https://xfhiwodulrbbtfcqneqt.supabase.co
 *   service_role_key      — JWT for the project
 *
 * If credentials are not provided per-tenant, falls back to server-level env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_API_KEY, QDRANT_URL, QDRANT_API_KEY
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AACRConnectorCredentials {
  supabase_url?: string;
  service_role_key?: string;
}

export interface AACRSpeakerSummary {
  talk_id: string;
  session_slug: string | null;
  speaker_name: string | null;
  affiliation: string | null;
  tumor_types: string[];
  clinical_stage: string | null;
  novelty_flag: string | null;
  moa_summary: string | null;
}

export interface AACRCDHit {
  id: number;
  talk_id: string;
  speaker_name: string | null;
  institution: string | null;
  presentation_type: string | null;
  cognitive_dissonance: string[];
  crispro_opportunity: Array<{
    opportunity_type: string;
    priority: string;
    description: string;
    crispro_angle: string;
  }>;
}

export interface AACRSearchResult {
  id: number;
  source_table: string;
  talk_id: string | null;
  speaker_name: string | null;
  session_slug: string | null;
  field_name: string;
  chunk_text: string;
  similarity: number;
}

export interface AACRConnectorResult<T> {
  data: T[];
  count: number;
  connector: "supabase-aacr";
  project_ref: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveCredentials(creds?: AACRConnectorCredentials): {
  url: string;
  key: string;
} {
  const url = (
    creds?.supabase_url ??
    process.env.SUPABASE_URL ??
    ""
  ).replace(/\/$/, "");

  const key =
    creds?.service_role_key ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "";

  if (!url) throw new Error("supabase-aacr connector: supabase_url not configured");
  if (!key) throw new Error("supabase-aacr connector: service_role_key not configured");

  return { url, key };
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level REST helpers
// ─────────────────────────────────────────────────────────────────────────────

async function get<T>(
  url: string,
  key: string,
  table: string,
  params: Record<string, string>,
  countExact = false,
): Promise<{ data: T[]; count: number }> {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${url}/rest/v1/${table}${qs ? "?" + qs : ""}`;
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (countExact) headers["Prefer"] = "count=exact";

  const res = await fetch(fullUrl, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`supabase-aacr GET ${table}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as T[];
  const cr = res.headers.get("content-range");
  const count = cr ? parseInt(cr.split("/")[1] ?? "0", 10) : data.length;
  return { data, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding generation — Gemini gemini-embedding-001 (3072-dim, truncated to 1536)
// ─────────────────────────────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) throw new Error("supabase-aacr connector: GOOGLE_API_KEY not configured for embedding");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text: text.slice(0, 8192) }] },
        taskType: "RETRIEVAL_QUERY",
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini embedding failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const vec = data.embedding?.values;
  if (!vec?.length) throw new Error("Gemini embedding returned empty vector");

  // Truncate to 1536-dim to match the openclaw_aacr Qdrant collection
  return vec.slice(0, 1536);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public connector API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search speakers by tumor type, clinical stage, or novelty flag.
 */
export async function searchSpeakers(
  query: {
    tumor_type?: string;
    clinical_stage?: string;
    novelty_flag?: string;
    session_slug?: string;
    limit?: number;
    offset?: number;
  },
  creds?: AACRConnectorCredentials,
): Promise<AACRConnectorResult<AACRSpeakerSummary>> {
  const { url, key } = resolveCredentials(creds);
  const params: Record<string, string> = {
    select: "talk_id,session_slug,speaker_name,affiliation,tumor_types,clinical_stage,novelty_flag,moa_summary",
    limit: String(query.limit ?? 50),
    offset: String(query.offset ?? 0),
    order: "id.asc",
  };
  if (query.clinical_stage) params["clinical_stage"] = `eq.${query.clinical_stage}`;
  if (query.novelty_flag) params["novelty_flag"] = `eq.${query.novelty_flag}`;
  if (query.session_slug) params["session_slug"] = `eq.${query.session_slug}`;
  if (query.tumor_type) params["tumor_types"] = `cs.{${query.tumor_type}}`;

  const { data, count } = await get<AACRSpeakerSummary>(url, key, "aacr_speakers", params, true);
  return { data, count, connector: "supabase-aacr", project_ref: "xfhiwodulrbbtfcqneqt" };
}

/**
 * Get cognitive dissonance hits, optionally filtered by presentation type.
 */
export async function getCDHits(
  query: {
    presentation_type?: string;
    data_maturity?: string;
    limit?: number;
    offset?: number;
  },
  creds?: AACRConnectorCredentials,
): Promise<AACRConnectorResult<AACRCDHit>> {
  const { url, key } = resolveCredentials(creds);
  const params: Record<string, string> = {
    select: "id,talk_id,speaker_name,institution,presentation_type,cognitive_dissonance,crispro_opportunity",
    limit: String(query.limit ?? 50),
    offset: String(query.offset ?? 0),
    order: "id.asc",
  };
  if (query.presentation_type) params["presentation_type"] = `eq.${query.presentation_type}`;
  if (query.data_maturity) params["data_maturity"] = `eq.${query.data_maturity}`;

  const { data, count } = await get<AACRCDHit>(url, key, "aacr_competitive_intel", params, true);
  const filtered = data.filter(
    (r) => Array.isArray(r.cognitive_dissonance) && r.cognitive_dissonance.length > 0,
  );
  return { data: filtered, count, connector: "supabase-aacr", project_ref: "xfhiwodulrbbtfcqneqt" };
}

/**
 * Get CrisPRO opportunities, optionally filtered by type and priority.
 */
export async function getCrisPROOpps(
  query: {
    opportunity_type?: string;
    priority?: string;
    presentation_type?: string;
    limit?: number;
    offset?: number;
  },
  creds?: AACRConnectorCredentials,
): Promise<AACRConnectorResult<AACRCDHit>> {
  const { url, key } = resolveCredentials(creds);
  const params: Record<string, string> = {
    select: "id,talk_id,speaker_name,institution,presentation_type,crispro_opportunity",
    limit: String(query.limit ?? 100),
    offset: String(query.offset ?? 0),
    order: "id.asc",
  };
  if (query.presentation_type) params["presentation_type"] = `eq.${query.presentation_type}`;

  const { data, count } = await get<AACRCDHit>(url, key, "aacr_competitive_intel", params, true);
  const filtered = data.filter((r) => {
    if (!Array.isArray(r.crispro_opportunity) || r.crispro_opportunity.length === 0) return false;
    if (query.opportunity_type) return r.crispro_opportunity.some((o) => o.opportunity_type === query.opportunity_type);
    if (query.priority) return r.crispro_opportunity.some((o) => o.priority === query.priority);
    return true;
  });
  return { data: filtered, count, connector: "supabase-aacr", project_ref: "xfhiwodulrbbtfcqneqt" };
}

/**
 * Semantic search across all embeddings via Qdrant.
 * Uses Gemini for query embedding, Qdrant openclaw_aacr collection for retrieval.
 */
export async function semanticSearch(
  query: {
    text: string;
    field?: string;
    match_count?: number;
    match_threshold?: number;
  },
  _creds?: AACRConnectorCredentials,
): Promise<AACRConnectorResult<AACRSearchResult>> {
  const embedding = await generateEmbedding(query.text);

  // Import Qdrant client dynamically to avoid circular deps
  const { search: qdrantSearch, ensureCollection, AACR_COLLECTION, AACR_EMBED_DIM } = await import("../lib/qdrantClient.js");

  await ensureCollection(AACR_COLLECTION, AACR_EMBED_DIM, "Cosine");

  const qdrantFilter = query.field
    ? { must: [{ key: "field_name", match: { value: query.field } }] }
    : undefined;

  const hits = await qdrantSearch(AACR_COLLECTION, embedding, {
    limit: query.match_count ?? 10,
    scoreThreshold: query.match_threshold ?? 0.65,
    filter: qdrantFilter,
  });

  const results: AACRSearchResult[] = hits.map((h) => ({
    id: Number(h.payload.id ?? h.id),
    source_table: String(h.payload.source_table ?? "aacr_embeddings"),
    talk_id: String(h.payload.talk_id ?? null),
    speaker_name: String(h.payload.speaker_name ?? null),
    session_slug: String(h.payload.session_slug ?? null),
    field_name: String(h.payload.field_name ?? ""),
    chunk_text: String(h.payload.chunk_text ?? ""),
    similarity: h.score,
  }));

  return {
    data: results,
    count: results.length,
    connector: "supabase-aacr",
    project_ref: "xfhiwodulrbbtfcqneqt",
  };
}

/**
 * Health check — verifies connectivity to the Supabase project.
 */
export async function healthCheck(creds?: AACRConnectorCredentials): Promise<{
  ok: boolean;
  tables: Record<string, number>;
  project_ref: string;
}> {
  const { url, key } = resolveCredentials(creds);
  const tables = ["aacr_sessions", "aacr_speakers", "aacr_competitive_intel", "aacr_clinical_data", "aacr_embeddings"];
  const counts: Record<string, number> = {};

  for (const table of tables) {
    try {
      const { count } = await get(url, key, table, { select: "count" }, true);
      counts[table] = count;
    } catch {
      counts[table] = -1;
    }
  }

  const ok = Object.values(counts).every((c) => c >= 0);
  return { ok, tables: counts, project_ref: "xfhiwodulrbbtfcqneqt" };
}
