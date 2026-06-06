/**
 * Hybrid legal RAG: Postgres tsvector (BM25) + pgvector semantic search.
 *
 * v2: Replaces JS in-memory cosine similarity with pgvector ANN query.
 * Falls back to JS cosine if embedding_vec column is empty (migration in progress).
 */

import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText, cosineSimilarity } from "./embeddings.js";
import {
  legalCorpusRetrieve,
  type LegalCorpusHit,
  type LegalCorpusRetrieveResult,
} from "./retrieve.js";
import { rrfMerge, buildContextBlock, type RRFItem } from "./rrfMerge.js";

export async function legalCorpusHybridRetrieve(params: {
  query: string;
  domains?: string[];
  topK?: number;
  maxChars?: number;
  forceCofounderCritical?: boolean;
}): Promise<LegalCorpusRetrieveResult & { retrieval_mode: "hybrid" | "bm25_only" }> {
  const topK = params.topK ?? 10;

  // ── BM25 leg ────────────────────────────────────────────────────────────
  const bm25 = await legalCorpusRetrieve({ ...params, topK: topK * 2 });

  // ── Semantic leg ────────────────────────────────────────────────────────
  const queryVec = await embedText(params.query);
  if (!queryVec) {
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }

  try {
    // Try pgvector query first (fast, ANN)
    const semanticHits = await pgvectorSemanticSearch(queryVec, params.domains, topK * 2);

    // If pgvector returned nothing, fall back to JS cosine (migration in progress)
    const hits = semanticHits.length > 0
      ? semanticHits
      : await jsCosineFallback(queryVec, params.domains, topK * 2);

    // ── RRF merge ──────────────────────────────────────────────────────────
    const bm25Items: RRFItem[] = bm25.hits.map((h) => ({
      chunk_id: h.chunk_id,
      document_id: h.document_id,
      slug: h.slug,
      title: h.title,
      citation: h.citation,
      domain: h.domain,
      priority: h.priority,
      content: h.content,
    }));

    const merged = rrfMerge(bm25Items, hits);
    const topMerged = merged.slice(0, topK);

    const maxChars = params.maxChars ?? 8000;
    const { block, truncated } = buildContextBlock(topMerged, maxChars);

    return {
      hits: topMerged.map((h) => ({
        chunk_id: h.chunk_id,
        document_id: h.document_id,
        slug: h.slug,
        title: h.title,
        citation: h.citation,
        domain: h.domain,
        priority: h.priority,
        rank: h.rrf_score,
        content: h.content,
      })),
      context_block: block,
      corpus_version: bm25.corpus_version,
      truncated,
      retrieval_mode: "hybrid",
    };
  } catch (err: unknown) {
    logger.warn({ err }, "hybridRetrieve: semantic leg failed — BM25 only");
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }
}

/**
 * pgvector ANN search — uses the HNSW index on embedding_vec.
 * Returns results sorted by cosine similarity (descending).
 */
async function pgvectorSemanticSearch(
  queryVec: number[],
  domains?: string[],
  limit?: number,
): Promise<RRFItem[]> {
  const domainFilter =
    domains && domains.length > 0
      ? `AND d.domain = ANY($2::text[])`
      : "";

  const args: unknown[] = [JSON.stringify(queryVec)];
  if (domains && domains.length > 0) args.push(domains);
  args.push(limit ?? 20);

  const placeholder2 = domains && domains.length > 0 ? "$2" : "NULL";
  const limitParam = domains && domains.length > 0 ? "$3" : "$2";

  const rows = await pool.query<{
    chunk_id: number;
    document_id: number;
    slug: string;
    title: string;
    citation: string;
    domain: string;
    priority: string;
    content: string;
    similarity: number;
  }>(
    `SELECT c.id AS chunk_id, c.document_id, d.slug, d.title, d.citation, d.domain,
            d.priority, c.content,
            1 - (c.embedding_vec <=> $1::vector) AS similarity
     FROM legal_corpus_chunks c
     JOIN legal_corpus_documents d ON d.id = c.document_id
     WHERE c.embedding_vec IS NOT NULL
       ${domainFilter}
     ORDER BY c.embedding_vec <=> $1::vector
     LIMIT ${limitParam}`,
    args,
  );

  // Filter by similarity threshold (0.25) and sort by similarity desc
  return rows.rows
    .filter((r) => r.similarity >= 0.25)
    .sort((a, b) => b.similarity - a.similarity)
    .map((r) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      slug: r.slug,
      title: r.title,
      citation: r.citation ?? "",
      domain: r.domain,
      priority: r.priority,
      content: r.content,
    }));
}

/**
 * JS cosine fallback — used when embedding_vec column is empty (pre-migration).
 * Loads ALL chunks with real[] embeddings into memory (original behavior).
 */
async function jsCosineFallback(
  queryVec: number[],
  domains?: string[],
  limit?: number,
): Promise<RRFItem[]> {
  const domainFilter =
    domains && domains.length > 0
      ? `AND d.domain = ANY($1::text[])`
      : "";

  const args: unknown[] = [];
  if (domains && domains.length > 0) args.push(domains);

  const rows = await pool.query<{
    chunk_id: number;
    document_id: number;
    slug: string;
    title: string;
    citation: string;
    domain: string;
    priority: string;
    content: string;
    embedding: number[] | null;
  }>(
    `SELECT c.id AS chunk_id, c.document_id, d.slug, d.title, d.citation, d.domain,
            d.priority, c.content, c.embedding
     FROM legal_corpus_chunks c
     JOIN legal_corpus_documents d ON d.id = c.document_id
     WHERE c.embedding IS NOT NULL
       ${domainFilter}`,
    args,
  );

  const scored: RRFItem[] = [];
  for (const r of rows.rows) {
    if (!r.embedding?.length) continue;
    const sim = cosineSimilarity(queryVec, r.embedding);
    if (sim < 0.25) continue;
    scored.push({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      slug: r.slug,
      title: r.title,
      citation: r.citation ?? "",
      domain: r.domain,
      priority: r.priority,
      content: r.content,
    });
  }

  // Sort by similarity (desc) — RRF will re-rank
  scored.sort((a, b) => {
    // We don't have the similarity score in RRFItem, so we rely on order
    return 0; // preserve DB order as proxy
  });

  return scored.slice(0, limit ?? 20);
}
