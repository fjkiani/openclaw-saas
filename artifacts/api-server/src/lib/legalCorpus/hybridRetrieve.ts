/**
 * Hybrid legal RAG: Postgres tsvector (BM25) + Qdrant semantic search.
 *
 * v3: Replaces pgvector ANN + JS cosine fallback with Qdrant vector search.
 * BM25 leg stays in Postgres (tsvector). Semantic leg uses Qdrant collection
 * openclaw_legal_corpus (3072-dim, Cosine, Gemini embedding-001).
 * RRF merge combines both legs.
 */

import { logger } from "../logger.js";
import { embedText } from "./embeddings.js";
import {
  legalCorpusRetrieve,
  type LegalCorpusHit,
  type LegalCorpusRetrieveResult,
} from "./retrieve.js";
import { rrfMerge, buildContextBlock, type RRFItem } from "./rrfMerge.js";
import { search as qdrantSearch, LEGAL_CORPUS_COLLECTION } from "../qdrantClient.js";

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

  // ── Semantic leg via Qdrant ─────────────────────────────────────────────
  const queryVec = await embedText(params.query);
  if (!queryVec) {
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }

  try {
    // Build Qdrant filter for domain filtering
    const qdrantFilter = params.domains && params.domains.length > 0
      ? { must: [{ key: "domain", match: { any: params.domains } }] }
      : undefined;

    const qdrantHits = await qdrantSearch(LEGAL_CORPUS_COLLECTION, queryVec, {
      limit: topK * 2,
      scoreThreshold: 0.25,
      filter: qdrantFilter,
    });

    if (qdrantHits.length === 0) {
      // Qdrant returned nothing — fall back to BM25 only
      logger.info("hybridRetrieve: Qdrant returned 0 hits — BM25 only");
      return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
    }

    // Convert Qdrant hits to RRFItem format
    const semanticHits: RRFItem[] = qdrantHits.map((h) => ({
      chunk_id: Number(h.payload.chunk_id ?? h.id),
      document_id: Number(h.payload.document_id ?? 0),
      slug: String(h.payload.slug ?? ""),
      title: String(h.payload.title ?? ""),
      citation: String(h.payload.citation ?? ""),
      domain: String(h.payload.domain ?? ""),
      priority: String(h.payload.priority ?? "normal"),
      content: String(h.payload.content ?? ""),
    }));

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

    const merged = rrfMerge(bm25Items, semanticHits);
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
    logger.warn({ err }, "hybridRetrieve: Qdrant semantic leg failed — BM25 only");
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }
}
