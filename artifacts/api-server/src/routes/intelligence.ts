/**
 * intelligence.ts — AACR 2026 Conference Intelligence API
 *
 * Exposes the AACR corpus stored in Supabase (project xfhiwodulrbbtfcqneqt)
 * via REST endpoints. Semantic search feeds the double-dip flywheel:
 * every reranked search generates a DPO preference pair for
 * task_type='competitive_intel_extraction'.
 *
 * Routes:
 *   GET  /api/intelligence/sessions          — list sessions (paginated)
 *   GET  /api/intelligence/speakers          — search speakers (filter by tumor_type, stage, novelty)
 *   GET  /api/intelligence/cd-hits           — cognitive dissonance hits (ranked)
 *   GET  /api/intelligence/crispro           — CrisPRO opportunities (filter by type, priority)
 *   POST /api/intelligence/search            — semantic search (proxies match_embeddings)
 *   GET  /api/intelligence/stats             — corpus statistics
 *   GET  /api/intelligence/flywheel          — AACR domain flywheel status
 *
 * Auth: Clerk JWT required on all routes except /stats (public).
 * Supabase env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * OpenRouter env var: OPENROUTER_API_KEY (for embedding generation)
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_KEY_2 = process.env.OPENROUTER_API_KEY_2 ?? "";

function getSupabaseHeaders(prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: () => void): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase REST helpers
// ─────────────────────────────────────────────────────────────────────────────

async function supabaseGet<T>(
  table: string,
  params: Record<string, string>,
  countExact = false,
): Promise<{ data: T[]; count: number | null }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: getSupabaseHeaders(countExact ? "count=exact" : undefined) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase GET ${table}: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as T[];
  const cr = res.headers.get("content-range");
  const count = cr ? parseInt(cr.split("/")[1] ?? "0", 10) : null;
  return { data, count };
}

async function supabaseRpc<T>(fn: string, body: Record<string, unknown>): Promise<T[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: getSupabaseHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body2 = await res.text().catch(() => "");
    throw new Error(`Supabase RPC ${fn}: HTTP ${res.status} — ${body2.slice(0, 200)}`);
  }
  return (await res.json()) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const key = OPENROUTER_KEY || OPENROUTER_KEY_2;
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding generation failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Double-dip vault capture (async, non-blocking)
// ─────────────────────────────────────────────────────────────────────────────

function captureSearchPreferencePair(
  query: string,
  fastResults: unknown[],
  slowResults: unknown[],
): void {
  const promptHash = Buffer.from(query).toString("base64").slice(0, 64);
  void pool
    .query(
      `INSERT INTO zie_preference_pairs
         (task_type, domain, source_kind, preference_source, prompt_hash, chosen_response_json, rejected_response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        "competitive_intel_extraction",
        "aacr",
        "search_rerank",
        "gpt4o_rerank",
        promptHash,
        JSON.stringify(slowResults),
        JSON.stringify(fastResults),
      ],
    )
    .catch((err: unknown) => {
      logger.warn({ err }, "intelligence: vault capture failed (non-blocking)");
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/intelligence/sessions
router.get(
  "/api/intelligence/sessions",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(parseInt(req.query["limit"] as string ?? "50", 10), 200);
      const offset = parseInt(req.query["offset"] as string ?? "0", 10);
      const { data, count } = await supabaseGet<{ id: number; slug: string; title: string }>(
        "aacr_sessions",
        { select: "id,slug,title,created_at", limit: String(limit), offset: String(offset), order: "slug.asc" },
        true,
      );
      res.json({ sessions: data, total: count, limit, offset });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /sessions failed");
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  },
);

// GET /api/intelligence/speakers
router.get(
  "/api/intelligence/speakers",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(parseInt(req.query["limit"] as string ?? "50", 10), 200);
      const offset = parseInt(req.query["offset"] as string ?? "0", 10);
      const params: Record<string, string> = {
        select: "id,talk_id,session_slug,speaker_name,affiliation,tumor_types,clinical_stage,novelty_flag,moa_summary,key_findings",
        limit: String(limit),
        offset: String(offset),
        order: "id.asc",
      };
      if (req.query["clinical_stage"]) params["clinical_stage"] = `eq.${req.query["clinical_stage"]}`;
      if (req.query["novelty_flag"]) params["novelty_flag"] = `eq.${req.query["novelty_flag"]}`;
      if (req.query["session_slug"]) params["session_slug"] = `eq.${req.query["session_slug"]}`;
      if (req.query["tumor_type"]) params["tumor_types"] = `cs.{${req.query["tumor_type"]}}`;

      const { data, count } = await supabaseGet(
        "aacr_speakers",
        params,
        true,
      );
      res.json({ speakers: data, total: count, limit, offset });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /speakers failed");
      res.status(500).json({ error: "Failed to fetch speakers" });
    }
  },
);

// GET /api/intelligence/cd-hits
router.get(
  "/api/intelligence/cd-hits",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(parseInt(req.query["limit"] as string ?? "50", 10), 200);
      const offset = parseInt(req.query["offset"] as string ?? "0", 10);
      const params: Record<string, string> = {
        select: "id,talk_id,speaker_name,institution,session_slug,presentation_type,data_maturity,cognitive_dissonance,crispro_opportunity",
        limit: String(limit),
        offset: String(offset),
        order: "id.asc",
      };
      if (req.query["presentation_type"]) params["presentation_type"] = `eq.${req.query["presentation_type"]}`;
      if (req.query["data_maturity"]) params["data_maturity"] = `eq.${req.query["data_maturity"]}`;

      const { data, count } = await supabaseGet(
        "aacr_competitive_intel",
        params,
        true,
      );

      // Filter to records with at least 1 CD hit
      const minCd = parseInt(req.query["min_cd_count"] as string ?? "1", 10);
      const filtered = (data as Array<{ cognitive_dissonance: string[] }>).filter(
        (r) => Array.isArray(r.cognitive_dissonance) && r.cognitive_dissonance.length >= minCd,
      );

      res.json({ cd_hits: filtered, total: count, limit, offset });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /cd-hits failed");
      res.status(500).json({ error: "Failed to fetch CD hits" });
    }
  },
);

// GET /api/intelligence/crispro
router.get(
  "/api/intelligence/crispro",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(parseInt(req.query["limit"] as string ?? "100", 10), 500);
      const offset = parseInt(req.query["offset"] as string ?? "0", 10);
      const params: Record<string, string> = {
        select: "id,talk_id,speaker_name,institution,session_slug,presentation_type,crispro_opportunity",
        limit: String(limit),
        offset: String(offset),
        order: "id.asc",
      };
      if (req.query["presentation_type"]) params["presentation_type"] = `eq.${req.query["presentation_type"]}`;

      const { data, count } = await supabaseGet(
        "aacr_competitive_intel",
        params,
        true,
      );

      // Filter by opportunity_type and priority
      const oppType = req.query["opportunity_type"] as string | undefined;
      const priority = req.query["priority"] as string | undefined;

      const filtered = (data as Array<{ crispro_opportunity: Array<{ opportunity_type: string; priority: string }> }>).filter((r) => {
        if (!Array.isArray(r.crispro_opportunity) || r.crispro_opportunity.length === 0) return false;
        if (oppType) return r.crispro_opportunity.some((o) => o.opportunity_type === oppType);
        if (priority) return r.crispro_opportunity.some((o) => o.priority === priority);
        return true;
      });

      res.json({ opportunities: filtered, total: count, limit, offset });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /crispro failed");
      res.status(500).json({ error: "Failed to fetch CrisPRO opportunities" });
    }
  },
);

// POST /api/intelligence/search
router.post(
  "/api/intelligence/search",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, field, match_count = 10, match_threshold = 0.65, rerank = false } = req.body as {
        query: string;
        field?: string;
        match_count?: number;
        match_threshold?: number;
        rerank?: boolean;
      };

      if (!query || typeof query !== "string" || query.trim().length === 0) {
        res.status(400).json({ error: "query is required" });
        return;
      }

      // Generate embedding
      const embedding = await generateEmbedding(query.trim());

      // Semantic search via match_embeddings RPC
      const fastResults = await supabaseRpc<{
        id: number;
        source_table: string;
        source_id: number;
        talk_id: string;
        speaker_name: string;
        session_slug: string;
        field_name: string;
        chunk_text: string;
        similarity: number;
      }>("match_embeddings", {
        query_embedding: embedding,
        match_field: field ?? null,
        match_count: Math.min(match_count, 50),
        match_threshold,
      });

      let finalResults = fastResults;
      let reranked = false;

      // Slow path: GPT-4o re-ranking (feeds double-dip flywheel)
      if (rerank && fastResults.length > 1) {
        const key = OPENROUTER_KEY || OPENROUTER_KEY_2;
        if (key) {
          try {
            const candidates = fastResults.map((r, i) => ({
              index: i,
              field: r.field_name,
              speaker: r.speaker_name,
              text: r.chunk_text.slice(0, 300),
              similarity: r.similarity,
            }));

            const rerankRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "openai/gpt-4o",
                messages: [
                  {
                    role: "system",
                    content:
                      "You are a competitive intelligence analyst. Re-rank these conference presentation excerpts by relevance to the query. Return a JSON array of 0-based indices from most to least relevant. JSON only, no prose.",
                  },
                  {
                    role: "user",
                    content: `Query: "${query}"\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}`,
                  },
                ],
                temperature: 0,
                max_tokens: 256,
              }),
            });

            if (rerankRes.ok) {
              const rerankData = (await rerankRes.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
              };
              const raw = rerankData.choices?.[0]?.message?.content ?? "";
              const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
              const indices = JSON.parse(cleaned) as number[];
              if (Array.isArray(indices)) {
                const rerankedResults = indices
                  .filter((i) => typeof i === "number" && i >= 0 && i < fastResults.length)
                  .map((i) => fastResults[i]);
                // Append any not in reranked list
                for (let i = 0; i < fastResults.length; i++) {
                  if (!indices.includes(i)) rerankedResults.push(fastResults[i]);
                }
                finalResults = rerankedResults;
                reranked = true;

                // Capture preference pair for double-dip flywheel (non-blocking)
                captureSearchPreferencePair(query, fastResults, finalResults);
              }
            }
          } catch (rerankErr: unknown) {
            logger.warn({ err: rerankErr }, "intelligence: rerank failed, using fast results");
          }
        }
      }

      res.json({
        results: finalResults,
        query,
        field: field ?? null,
        reranked,
        embedding_dims: embedding.length,
        match_count: finalResults.length,
      });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: POST /search failed");
      res.status(500).json({ error: "Search failed" });
    }
  },
);

// GET /api/intelligence/stats — public, no auth
router.get(
  "/api/intelligence/stats",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const tables = [
        "aacr_sessions",
        "aacr_speakers",
        "aacr_competitive_intel",
        "aacr_clinical_data",
        "aacr_embeddings",
      ];

      const counts = await Promise.all(
        tables.map(async (t) => {
          const { count } = await supabaseGet(t, { select: "count" }, true);
          return { table: t, count: count ?? 0 };
        }),
      );

      const countMap = Object.fromEntries(counts.map((c) => [c.table, c.count]));

      // Embedding breakdown by field
      const { data: embFields } = await supabaseGet<{ field_name: string }>(
        "aacr_embeddings",
        { select: "field_name", limit: "5000" },
      );
      const embByField: Record<string, number> = {};
      for (const row of embFields) {
        embByField[row.field_name] = (embByField[row.field_name] ?? 0) + 1;
      }

      // Presentation type distribution
      const { data: ptRows } = await supabaseGet<{ presentation_type: string }>(
        "aacr_competitive_intel",
        { select: "presentation_type", limit: "1000" },
      );
      const ptDist: Record<string, number> = {};
      for (const row of ptRows) {
        const pt = row.presentation_type ?? "unknown";
        ptDist[pt] = (ptDist[pt] ?? 0) + 1;
      }

      res.json({
        sessions: countMap["aacr_sessions"],
        speakers: countMap["aacr_speakers"],
        competitive_intel_records: countMap["aacr_competitive_intel"],
        clinical_data_entries: countMap["aacr_clinical_data"],
        embeddings: countMap["aacr_embeddings"],
        embeddings_by_field: embByField,
        presentation_type_distribution: ptDist,
      });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /stats failed");
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  },
);

// GET /api/intelligence/flywheel — AACR domain flywheel status
router.get(
  "/api/intelligence/flywheel",
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const VERIFIED_DPO_THRESHOLD = 50;

      const pairsRes = await pool.query<{
        task_type: string;
        total_pairs: string;
        verified_pairs: string;
      }>(
        `SELECT
           task_type,
           COUNT(*) AS total_pairs,
           SUM(CASE WHEN judge_verified THEN 1 ELSE 0 END) AS verified_pairs
         FROM zie_preference_pairs
         WHERE domain = 'aacr'
         GROUP BY task_type
         ORDER BY task_type`,
      );

      const sftRes = await pool.query<{
        task_type: string;
        sft_records: string;
      }>(
        `SELECT task_type, COUNT(*) AS sft_records
         FROM zie_training_records
         WHERE domain = 'aacr'
         GROUP BY task_type
         ORDER BY task_type`,
      );

      const sftByTaskType = new Map<string, number>();
      for (const row of sftRes.rows) {
        sftByTaskType.set(row.task_type, parseInt(row.sft_records, 10));
      }

      const domains = pairsRes.rows.map((row) => {
        const verifiedPairs = parseInt(row.verified_pairs, 10);
        const totalPairs = parseInt(row.total_pairs, 10);
        const sftRecords = sftByTaskType.get(row.task_type) ?? 0;
        const pct = Math.min(100, Math.round((verifiedPairs / VERIFIED_DPO_THRESHOLD) * 100));

        let trainingStatus: "accumulating" | "threshold_met" | "training" | "deployed";
        if (verifiedPairs >= VERIFIED_DPO_THRESHOLD) {
          trainingStatus = "threshold_met";
        } else {
          trainingStatus = "accumulating";
        }

        return {
          domain: "aacr",
          task_type: row.task_type,
          sft_records: sftRecords,
          total_pairs: totalPairs,
          verified_pairs: verifiedPairs,
          pct,
          training_status: trainingStatus,
        };
      });

      // Zero-state if no data yet
      if (domains.length === 0) {
        res.json({
          threshold: VERIFIED_DPO_THRESHOLD,
          domains: [
            {
              domain: "aacr",
              task_type: "competitive_intel_extraction",
              sft_records: 0,
              total_pairs: 0,
              verified_pairs: 0,
              pct: 0,
              training_status: "accumulating",
            },
          ],
        });
        return;
      }

      res.json({ threshold: VERIFIED_DPO_THRESHOLD, domains });
    } catch (err: unknown) {
      logger.error({ err }, "intelligence: GET /flywheel failed");
      res.status(500).json({ error: "Flywheel status query failed" });
    }
  },
);

export default router;
