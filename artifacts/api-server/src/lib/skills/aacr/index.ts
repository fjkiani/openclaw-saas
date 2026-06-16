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
// ─────────────────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
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
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Embedding failed ${res.status}: ${txt}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 1: aacr-semantic-search
// Input:  { query: string, match_count?: number, match_threshold?: number }
// Output: { speakers: AACRSpeaker[], talk_ids: string[] }
// ─────────────────────────────────────────────────────────────────────────────

const acrSemanticSearch: SkillHandler = async (input) => {
  const query = String(input.query ?? "");
  const matchCount = Number(input.match_count ?? 10);
  const matchThreshold = Number(input.match_threshold ?? 0.65);

  if (!query) throw new Error("aacr-semantic-search: query is required");
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("aacr-semantic-search: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  logger.debug({ query, matchCount }, "aacr-semantic-search: generating embedding");
  const embedding = await embed(query);

  // Call match_embeddings RPC
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_embeddings`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: matchCount,
      match_threshold: matchThreshold,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!rpcRes.ok) {
    const txt = await rpcRes.text().catch(() => "");
    throw new Error(`match_embeddings RPC failed ${rpcRes.status}: ${txt}`);
  }

  const matches = (await rpcRes.json()) as Array<{
    id: string;
    talk_id: string;
    field: string;
    similarity: number;
  }>;

  if (!matches.length) {
    logger.info({ query }, "aacr-semantic-search: no matches above threshold");
    return { speakers: [], talk_ids: [] };
  }

  // Deduplicate talk_ids, keep top matches
  const talkIdSet = new Set<string>();
  const topMatches = matches
    .sort((a, b) => b.similarity - a.similarity)
    .filter((m) => {
      if (talkIdSet.has(m.talk_id)) return false;
      talkIdSet.add(m.talk_id);
      return true;
    })
    .slice(0, matchCount);

  const talkIds = topMatches.map((m) => m.talk_id);

  // Fetch speaker records for matched talk_ids
  const speakerRes = await fetch(
    `${SUPABASE_URL}/rest/v1/aacr_speakers?talk_id=in.(${talkIds.map(encodeURIComponent).join(",")})&limit=50`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!speakerRes.ok) {
    const txt = await speakerRes.text().catch(() => "");
    throw new Error(`aacr_speakers fetch failed ${speakerRes.status}: ${txt}`);
  }

  const speakers = await speakerRes.json();

  logger.info(
    { query, matchCount: topMatches.length, speakerCount: speakers.length },
    "aacr-semantic-search: complete"
  );

  return {
    speakers,
    talk_ids: talkIds,
    match_scores: topMatches.map((m) => ({ talk_id: m.talk_id, similarity: m.similarity, field: m.field })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 2: crispro-scorer
// Input:  { speakers?: AACRSpeaker[], talk_ids?: string[] }
// Output: { crispro_opps: CrisPROOpportunity[], scored_count: number }
// ─────────────────────────────────────────────────────────────────────────────

const crisPROScorer: SkillHandler = async (input) => {
  // Accept talk_ids directly or extract from speakers array
  let talkIds: string[] = [];
  if (Array.isArray(input.talk_ids) && input.talk_ids.length > 0) {
    talkIds = input.talk_ids as string[];
  } else if (Array.isArray(input.speakers)) {
    talkIds = (input.speakers as Array<{ talk_id?: string }>)
      .map((s) => s.talk_id ?? "")
      .filter(Boolean);
  }

  if (!talkIds.length) {
    logger.info("crispro-scorer: no talk_ids — returning empty");
    return { crispro_opps: [], scored_count: 0 };
  }

  // Query aacr_crispro_opps view (created in Supabase)
  const encoded = talkIds.map(encodeURIComponent).join(",");
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/aacr_crispro_opps?talk_id=in.(${encoded})&limit=100`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!res.ok) {
    // Fall back to aacr_competitive_intel table if view doesn't exist
    const fallbackRes = await fetch(
      `${SUPABASE_URL}/rest/v1/aacr_competitive_intel?talk_id=in.(${encoded})&crispro_opportunity=not.is.null&limit=100`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
    );
    if (!fallbackRes.ok) {
      const txt = await fallbackRes.text().catch(() => "");
      throw new Error(`crispro fetch failed ${fallbackRes.status}: ${txt}`);
    }
    const rows = await fallbackRes.json() as Array<Record<string, unknown>>;
    const opps = rows
      .filter((r) => r.crispro_opportunity)
      .map((r) => ({
        talk_id: r.talk_id,
        opportunity: r.crispro_opportunity,
        priority: r.crispro_priority ?? "medium",
        evidence_quality: r.data_maturity_assessment ?? null,
      }));
    return { crispro_opps: opps, scored_count: opps.length };
  }

  const opps = await res.json();
  logger.info({ talkIdCount: talkIds.length, oppCount: opps.length }, "crispro-scorer: complete");
  return { crispro_opps: opps, scored_count: opps.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 3: cd-hit-extractor
// Input:  { speakers?: AACRSpeaker[], talk_ids?: string[] }
// Output: { cd_hits: CDHit[], hit_count: number }
// ─────────────────────────────────────────────────────────────────────────────

const cdHitExtractor: SkillHandler = async (input) => {
  let talkIds: string[] = [];
  if (Array.isArray(input.talk_ids) && input.talk_ids.length > 0) {
    talkIds = input.talk_ids as string[];
  } else if (Array.isArray(input.speakers)) {
    talkIds = (input.speakers as Array<{ talk_id?: string }>)
      .map((s) => s.talk_id ?? "")
      .filter(Boolean);
  }

  if (!talkIds.length) {
    logger.info("cd-hit-extractor: no talk_ids — returning empty");
    return { cd_hits: [], hit_count: 0 };
  }

  const encoded = talkIds.map(encodeURIComponent).join(",");

  // Query aacr_cd_hits view
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/aacr_cd_hits?talk_id=in.(${encoded})&limit=100`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) }
  );

  if (!res.ok) {
    // Fall back to aacr_competitive_intel with cognitive_dissonance filter
    const fallbackRes = await fetch(
      `${SUPABASE_URL}/rest/v1/aacr_competitive_intel?talk_id=in.(${encoded})&cognitive_dissonance=not.is.null&limit=100`,
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
        talk_id: r.talk_id,
        cognitive_dissonance: r.cognitive_dissonance,
        vulnerability_identified: r.vulnerability_identified ?? null,
      }));
    return { cd_hits: hits, hit_count: hits.length };
  }

  const hits = await res.json();
  logger.info({ talkIdCount: talkIds.length, hitCount: hits.length }, "cd-hit-extractor: complete");
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

// ─────────────────────────────────────────────────────────────────────────────
// Eval shim — exposes handlers by skill_id for skillEval.ts direct invocation.
// Not called from production routes. Only used by the eval pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import type { SkillHandler } from "../../workflowEngine.js";

const HANDLER_MAP: Record<string, SkillHandler> = {
  "aacr-semantic-search": acrSemanticSearch,
  "crispro-scorer":       crisPROScorer,
  "cd-hit-extractor":     cdHitExtractor,
  "crm-push":             crmPush,
};

export function _getHandler(skillId: string): SkillHandler | undefined {
  return HANDLER_MAP[skillId];
}
