/**
 * skills/aacr/index.ts — AACR skill handler registration.
 *
 * Registers 4 skill handlers for the "Conference Intelligence → CRM Pipeline"
 * workflow definition. Called once at startup after workflowEngine.init(pool).
 *
 * Skill IDs (must match the seeded workflow_definitions.steps[].skill_id):
 *   aacr-semantic-search  — semantic search over AACR 2026 corpus
 *   crispro-scorer        — fetch + score CrisPRO opportunities for matched speakers
 *   cd-hit-extractor      — fetch cognitive dissonance hits for matched speakers
 *   crm-push              — stub: log payload (real CRM push deferred until connector is live)
 *
 * Usage (in index.ts, after workflowEngine.init(pool)):
 *   import { registerAACRSkills } from './lib/skills/aacr/index.js';
 *   registerAACRSkills(workflowEngine);
 */

import { workflowEngine, type SkillHandler } from "../../workflowEngine.js";
import { logger } from "../../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase credentials (server-level env vars, set on Render)
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate embedding via OpenRouter text-embedding-3-small
// Falls back to Gemini embedding-001 (3072-dim truncated to 1536) if OpenRouter has no credits.
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_KEY = process.env.GOOGLE_AI_API_KEY ?? "";

async function embedViaGemini(text: string): Promise<number[]> {
  if (!GEMINI_KEY) throw new Error("GOOGLE_AI_API_KEY not set — Gemini embedding unavailable");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gemini embedding failed ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { embedding: { values: number[] } };
  const full = data.embedding.values; // 3072-dim
  // Truncate to 1536 to match existing corpus (text-embedding-3-small dim)
  // Note: cross-model similarity is approximate but functional for demo
  return full.slice(0, 1536);
}

async function embed(text: string): Promise<number[]> {
  // Try OpenRouter first (requires paid credits for embedding models)
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 402) {
      // No credits — fall through to Gemini
      logger.warn("OpenRouter embedding: 402 no credits — falling back to Gemini embedding");
      return embedViaGemini(text);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Embedding failed ${res.status}: ${txt}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  } catch (err) {
    // If it's a 402 error wrapped in a throw, try Gemini
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("402") || msg.includes("Insufficient credits")) {
      logger.warn("OpenRouter embedding credits exhausted — falling back to Gemini embedding");
      return embedViaGemini(text);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 1: aacr-semantic-search
// Input:  { query: string, match_count?: number, match_threshold?: number }
// Output: { speakers: AACRSpeaker[], talk_ids: string[] }
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Keyword fallback: search aacr_speakers directly using ilike on key fields.
// Used when vector search returns low-quality results (cross-model embedding mismatch)
// or when OpenRouter embedding credits are exhausted.
// ─────────────────────────────────────────────────────────────────────────────
async function keywordSearchSpeakers(
  query: string,
  matchCount: number
): Promise<{ speakers: unknown[]; talk_ids: string[]; match_scores: unknown[] }> {
  // Extract meaningful keywords (skip stop words, keep 2+ char tokens)
  const stopWords = new Set(["in", "of", "the", "and", "or", "a", "an", "to", "for", "with", "on", "at", "by", "from", "is", "are", "was", "were"]);
  const keywords = query
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w.toLowerCase()))
    .slice(0, 4); // top 4 keywords

  if (!keywords.length) {
    return { speakers: [], talk_ids: [], match_scores: [] };
  }

  // Build OR filter across plain-text fields only (ilike doesn't work on text[] arrays)
  // Array fields (key_findings, tumor_types, topic_categories, targets) use cs.{kw} (contains)
  const primaryKw = keywords[0];
  const textFields = ["moa_summary", "talk_title", "speaker_name", "affiliation", "session_title", "novelty_flag", "clinical_stage"];
  const orParts = textFields.map((f) => `${f}.ilike.*${primaryKw}*`);
  // Also search array fields with contains syntax for each keyword
  const arrayFields = ["tumor_types", "topic_categories"];
  for (const f of arrayFields) {
    orParts.push(`${f}.cs.{${primaryKw}}`);
  }
  const orFilter = orParts.join(",");

  const url = `${SUPABASE_URL}/rest/v1/aacr_speakers?or=(${encodeURIComponent(orFilter)})&limit=${matchCount * 3}&select=id,talk_id,speaker_name,affiliation,talk_title,moa_summary,key_findings,targets,tumor_types,topic_categories,clinical_stage,resistance_notes,open_questions,biomarkers,combination_strategies`;

  const res = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`aacr_speakers keyword search failed ${res.status}: ${txt}`);
  }

  const rows = (await res.json()) as Array<Record<string, unknown>>;

  // Score each row by how many keywords appear in its text fields
  // Note: key_findings, tumor_types, topic_categories are arrays — join them
  const scored = rows.map((row) => {
    const arrayToStr = (v: unknown) => Array.isArray(v) ? v.join(" ") : (v ?? "");
    const text = [
      row.moa_summary,
      arrayToStr(row.key_findings),
      row.talk_title,
      arrayToStr(row.targets),
      arrayToStr(row.topic_categories),
      arrayToStr(row.tumor_types),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const score = keywords.reduce((acc, kw) => acc + (text.includes(kw.toLowerCase()) ? 1 : 0), 0);
    return { row, score };
  });

  const topRows = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, matchCount)
    .map(({ row, score }) => ({ row, score }));

  const speakers = topRows.map(({ row }) => row);
  const talkIds = [...new Set(speakers.map((s) => String(s.talk_id ?? "")).filter(Boolean))];
  const matchScores = topRows.map(({ row, score }) => ({
    talk_id: row.talk_id,
    similarity: score / keywords.length, // normalize 0-1
    field: "keyword",
  }));

  return { speakers, talk_ids: talkIds, match_scores: matchScores };
}

const acrSemanticSearch: SkillHandler = async (input) => {
  const query = String(input.query ?? "");
  const matchCount = Number(input.match_count ?? 10);
  const matchThreshold = Number(input.match_threshold ?? 0.65);
  const MIN_VECTOR_SIMILARITY = 0.25; // below this, fall back to keyword search

  if (!query) throw new Error("aacr-semantic-search: query is required");
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("aacr-semantic-search: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  // ── Attempt 1: vector search ──────────────────────────────────────────────
  let useKeywordFallback = false;
  let speakers: unknown[] = [];
  let talkIds: string[] = [];
  let matchScores: unknown[] = [];

  try {
    logger.debug({ query, matchCount }, "aacr-semantic-search: generating embedding");
    const embedding = await embed(query);

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_embeddings`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: matchCount * 3,
        match_threshold: 0.0, // always fetch, filter by quality below
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!rpcRes.ok) {
      const txt = await rpcRes.text().catch(() => "");
      throw new Error(`match_embeddings RPC failed ${rpcRes.status}: ${txt}`);
    }

    const matches = (await rpcRes.json()) as Array<{
      id: string; talk_id: string; field: string; similarity: number;
    }>;

    // Check if vector results are meaningful
    const maxSim = matches.length ? Math.max(...matches.map((m) => m.similarity)) : 0;
    if (maxSim < MIN_VECTOR_SIMILARITY) {
      logger.warn(
        { maxSim, query },
        "aacr-semantic-search: vector similarity too low (cross-model mismatch) — using keyword fallback"
      );
      useKeywordFallback = true;
    } else {
      // Good vector results — deduplicate and fetch speakers
      const talkIdSet = new Set<string>();
      const topMatches = matches
        .filter((m) => m.similarity >= matchThreshold)
        .sort((a, b) => b.similarity - a.similarity)
        .filter((m) => { if (talkIdSet.has(m.talk_id)) return false; talkIdSet.add(m.talk_id); return true; })
        .slice(0, matchCount);

      talkIds = topMatches.map((m) => m.talk_id);
      matchScores = topMatches.map((m) => ({ talk_id: m.talk_id, similarity: m.similarity, field: m.field }));

      if (talkIds.length) {
        const speakerRes = await fetch(
          `${SUPABASE_URL}/rest/v1/aacr_speakers?talk_id=in.(${talkIds.map(encodeURIComponent).join(",")})&limit=50`,
          { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
        );
        if (!speakerRes.ok) {
          const txt = await speakerRes.text().catch(() => "");
          throw new Error(`aacr_speakers fetch failed ${speakerRes.status}: ${txt}`);
        }
        speakers = await speakerRes.json();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("402") || msg.includes("Insufficient credits") || msg.includes("cross-model")) {
      logger.warn({ err: msg }, "aacr-semantic-search: embedding unavailable — using keyword fallback");
      useKeywordFallback = true;
    } else {
      throw err;
    }
  }

  // ── Attempt 2: keyword fallback ───────────────────────────────────────────
  if (useKeywordFallback || (!speakers.length && !talkIds.length)) {
    logger.info({ query }, "aacr-semantic-search: running keyword search fallback");
    const kwResult = await keywordSearchSpeakers(query, matchCount);
    speakers = kwResult.speakers;
    talkIds = kwResult.talk_ids;
    matchScores = kwResult.match_scores;
  }

  logger.info(
    { query, speakerCount: speakers.length, talkIdCount: talkIds.length, useKeywordFallback },
    "aacr-semantic-search: complete"
  );

  return { speakers, talk_ids: talkIds, match_scores: matchScores };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 2: crispro-scorer
// Input:  { speakers?: AACRSpeaker[], talk_ids?: string[] }
// Output: { crispro_opps: CrisPROOpportunity[], scored_count: number }
// ─────────────────────────────────────────────────────────────────────────────

// Helper: unwrap step output — the workflow engine passes the full step-N output
// object as input.speakers (because output_key='speakers', input_mapping={'speakers':'speakers'}).
// So input.speakers may be { speakers: [...], talk_ids: [...] } instead of an array.
function unwrapStepOutput(raw: unknown): { speakers: Array<{ talk_id?: string; session_slug?: string }>; talkIds: string[] } {
  if (Array.isArray(raw)) {
    return { speakers: raw as Array<{ talk_id?: string; session_slug?: string }>, talkIds: [] };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const speakers = Array.isArray(obj.speakers) ? obj.speakers as Array<{ talk_id?: string; session_slug?: string }> : [];
    const talkIds = Array.isArray(obj.talk_ids) ? obj.talk_ids as string[] : [];
    return { speakers, talkIds };
  }
  return { speakers: [], talkIds: [] };
}

const crisPROScorer: SkillHandler = async (input) => {
  // aacr_crispro_opps is keyed by session_slug (not talk_id).
  // Extract session_slugs from speakers array; fall back to parsing talk_ids.
  const { speakers, talkIds: unwrappedTalkIds } = unwrapStepOutput(input.speakers);
  const talkIds = [...unwrappedTalkIds, ...((input.talk_ids as string[]) ?? [])];

  // Collect session_slugs from speakers
  const slugSet = new Set<string>();
  for (const s of speakers) {
    if (s.session_slug) slugSet.add(s.session_slug);
    // talk_id format: "session-slug::speaker::N" — extract slug from prefix
    else if (s.talk_id) {
      const slug = s.talk_id.split("::")[0];
      if (slug) slugSet.add(slug);
    }
  }
  // Also parse slugs from raw talk_ids input
  for (const tid of talkIds) {
    const slug = tid.split("::")[0];
    if (slug) slugSet.add(slug);
  }

  if (!slugSet.size) {
    logger.info("crispro-scorer: no session_slugs — returning empty");
    return { crispro_opps: [], scored_count: 0 };
  }

  // Query aacr_crispro_opps by session_slug
  const encodedSlugs = [...slugSet].map(encodeURIComponent).join(",");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/aacr_crispro_opps?session_slug=in.(${encodedSlugs})&limit=100`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // Fall back to aacr_competitive_intel (has talk_id + crispro_opportunity)
    if (talkIds.length || speakers.length) {
      const allTalkIds = [
        ...talkIds,
        ...speakers.map((s) => s.talk_id ?? "").filter(Boolean),
      ];
      const encodedTids = [...new Set(allTalkIds)].map(encodeURIComponent).join(",");
      const fallbackRes = await fetch(
        `${SUPABASE_URL}/rest/v1/aacr_competitive_intel?talk_id=in.(${encodedTids})&crispro_opportunity=not.is.null&limit=100`,
        { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
      );
      if (!fallbackRes.ok) {
        const ftxt = await fallbackRes.text().catch(() => "");
        throw new Error(`crispro fetch failed ${fallbackRes.status}: ${ftxt}`);
      }
      const rows = await fallbackRes.json() as Array<Record<string, unknown>>;
      const opps = rows
        .filter((r) => r.crispro_opportunity)
        .map((r) => ({
          session_slug: r.session_slug ?? r.talk_id,
          speaker_name: r.speaker_name,
          opportunity: r.crispro_opportunity,
          priority: r.crispro_priority ?? "medium",
        }));
      return { crispro_opps: opps, scored_count: opps.length };
    }
    throw new Error(`crispro fetch failed ${res.status}: ${txt}`);
  }

  const opps = await res.json() as Array<Record<string, unknown>>;
  logger.info({ slugCount: slugSet.size, oppCount: opps.length }, "crispro-scorer: complete");
  return { crispro_opps: opps, scored_count: opps.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 3: cd-hit-extractor
// Input:  { speakers?: AACRSpeaker[], talk_ids?: string[] }
// Output: { cd_hits: CDHit[], hit_count: number }
// ─────────────────────────────────────────────────────────────────────────────

const cdHitExtractor: SkillHandler = async (input) => {
  // aacr_cd_hits is keyed by session_slug (not talk_id).
  // Unwrap step output object if needed (same pattern as crisPROScorer).
  const { speakers, talkIds: unwrappedTalkIds } = unwrapStepOutput(input.speakers);
  const talkIds = [...unwrappedTalkIds, ...((input.talk_ids as string[]) ?? [])];

  const slugSet = new Set<string>();
  for (const s of speakers) {
    if (s.session_slug) slugSet.add(s.session_slug);
    else if (s.talk_id) { const slug = s.talk_id.split("::")[0]; if (slug) slugSet.add(slug); }
  }
  for (const tid of talkIds) {
    const slug = tid.split("::")[0];
    if (slug) slugSet.add(slug);
  }

  if (!slugSet.size) {
    logger.info("cd-hit-extractor: no session_slugs — returning empty");
    return { cd_hits: [], hit_count: 0 };
  }

  const encodedSlugs = [...slugSet].map(encodeURIComponent).join(",");

  // Query aacr_cd_hits by session_slug
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/aacr_cd_hits?session_slug=in.(${encodedSlugs})&limit=100`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!res.ok) {
    // Fall back to aacr_competitive_intel with cognitive_dissonance filter
    const allTalkIds = [...talkIds, ...speakers.map((s) => s.talk_id ?? "").filter(Boolean)];
    const encodedTids = [...new Set(allTalkIds)].map(encodeURIComponent).join(",");
    const fallbackRes = await fetch(
      `${SUPABASE_URL}/rest/v1/aacr_competitive_intel?talk_id=in.(${encodedTids})&cognitive_dissonance=not.is.null&limit=100`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
    );
    if (!fallbackRes.ok) {
      const txt = await fallbackRes.text().catch(() => "");
      throw new Error(`cd-hit fetch failed ${fallbackRes.status}: ${txt}`);
    }
    const rows = await fallbackRes.json() as Array<Record<string, unknown>>;
    const hits = rows
      .filter((r) => r.cognitive_dissonance)
      .map((r) => ({
        session_slug: r.session_slug ?? r.talk_id,
        speaker_name: r.speaker_name,
        cognitive_dissonance: r.cognitive_dissonance,
        vulnerability_identified: r.vulnerability_identified ?? null,
      }));
    return { cd_hits: hits, hit_count: hits.length };
  }

  const hits = await res.json();
  logger.info({ slugCount: slugSet.size, hitCount: hits.length }, "cd-hit-extractor: complete");
  return { cd_hits: hits, hit_count: hits.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 4: crm-push (stub — logs payload, returns receipt)
// Input:  { opportunities?: CrisPROOpportunity[], cd_hits?: CDHit[], ... }
// Output: { pushed: number, crm_record_ids: string[], status: 'stub' }
// ─────────────────────────────────────────────────────────────────────────────

const crmPush: SkillHandler = async (input) => {
  const opps = Array.isArray(input.opportunities) ? input.opportunities : [];
  const cdHits = Array.isArray(input.cd_hits) ? input.cd_hits : [];

  logger.info(
    {
      opp_count: opps.length,
      cd_hit_count: cdHits.length,
      note: "crm-push is a stub — real CRM push deferred until Crunchbase/HubSpot connector is live",
    },
    "crm-push: stub invoked"
  );

  // Return a stub receipt so the workflow run completes successfully
  return {
    pushed: opps.length,
    crm_record_ids: opps.map((_, i) => `stub-crm-${Date.now()}-${i}`),
    cd_hits_logged: cdHits.length,
    status: "stub" as const,
    message: "CRM push is a stub. Replace connectors/crunchbase.ts mock with real OAuth flow to activate.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerAACRSkills(): void {
  workflowEngine.registerSkill("aacr-semantic-search", acrSemanticSearch);
  workflowEngine.registerSkill("crispro-scorer", crisPROScorer);
  workflowEngine.registerSkill("cd-hit-extractor", cdHitExtractor);
  workflowEngine.registerSkill("crm-push", crmPush);

  logger.info(
    { skills: ["aacr-semantic-search", "crispro-scorer", "cd-hit-extractor", "crm-push"] },
    "AACR skill handlers registered"
  );
}
