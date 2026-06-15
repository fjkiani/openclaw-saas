/**
 * search.ts — Semantic search wrapper for the AACR intelligence corpus.
 *
 * Handles embedding generation (via OpenRouter) and proxies to the
 * match_embeddings Supabase RPC function.
 *
 * The double-dip flywheel hook is here: every search call that uses the
 * slow path (GPT-4o re-ranking) generates a preference pair that feeds
 * the competitive_intel_extraction training task_type.
 */

import type { SemanticSearchRequest, SemanticSearchResult, EmbeddingField } from "./types.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

// ─────────────────────────────────────────────────────────────────────────────
// Embedding generation
// ─────────────────────────────────────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  apiKey?: string,
): Promise<number[]> {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding generation failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-ranking prompt (slow path for double-dip)
// ─────────────────────────────────────────────────────────────────────────────

const RERANK_SYSTEM_PROMPT = `You are a competitive intelligence analyst reviewing conference presentation excerpts.
Given a search query and a list of candidate results, re-rank them by relevance to the query.
Return a JSON array of result IDs in order from most to least relevant.
Respond with valid JSON only. No markdown, no prose.`;

export async function rerankResults(
  query: string,
  results: SemanticSearchResult[],
  apiKey?: string,
): Promise<SemanticSearchResult[]> {
  if (results.length <= 1) return results;

  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) return results; // graceful degradation

  try {
    const candidates = results.map((r, i) => ({
      index: i,
      id: r.id,
      field: r.field_name,
      text: r.chunk_text.slice(0, 300),
      similarity: r.similarity,
    }));

    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          { role: "system", content: RERANK_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Query: "${query}"\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nReturn a JSON array of indices (0-based) in order from most to least relevant.`,
          },
        ],
        temperature: 0,
        max_tokens: 256,
      }),
    });

    if (!res.ok) return results;

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const indices = JSON.parse(cleaned) as number[];

    if (!Array.isArray(indices)) return results;

    const reranked: SemanticSearchResult[] = [];
    for (const idx of indices) {
      if (typeof idx === "number" && idx >= 0 && idx < results.length) {
        reranked.push(results[idx]);
      }
    }
    // Append any results not in the reranked list
    for (let i = 0; i < results.length; i++) {
      if (!indices.includes(i)) reranked.push(results[i]);
    }
    return reranked;
  } catch {
    return results; // graceful degradation
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level search function (used by intelligence.ts route)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  field?: EmbeddingField;
  matchCount?: number;
  matchThreshold?: number;
  rerank?: boolean;
  apiKey?: string;
}

export interface SearchResponse {
  results: SemanticSearchResult[];
  query: string;
  field: EmbeddingField | null;
  reranked: boolean;
  embedding_dims: number;
}

/**
 * Full search pipeline:
 * 1. Generate embedding for query
 * 2. Call match_embeddings RPC via AACRClient
 * 3. Optionally re-rank with GPT-4o (slow path — generates DPO training data)
 */
export async function searchCorpus(
  client: { semanticSearch: (req: SemanticSearchRequest, emb: number[]) => Promise<SemanticSearchResult[]> },
  options: SearchOptions,
): Promise<SearchResponse> {
  const embedding = await generateEmbedding(options.query, options.apiKey);

  const results = await client.semanticSearch(
    {
      query: options.query,
      field: options.field,
      match_count: options.matchCount ?? 10,
      match_threshold: options.matchThreshold ?? 0.65,
    },
    embedding,
  );

  let finalResults = results;
  let reranked = false;

  if (options.rerank && results.length > 1) {
    finalResults = await rerankResults(options.query, results, options.apiKey);
    reranked = true;
  }

  return {
    results: finalResults,
    query: options.query,
    field: options.field ?? null,
    reranked,
    embedding_dims: embedding.length,
  };
}
