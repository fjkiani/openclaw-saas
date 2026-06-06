/**
 * Hybrid legal RAG: Postgres tsvector (BM25) + embedding cosine similarity.
 */

import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText, cosineSimilarity } from "./embeddings.js";
import {
  legalCorpusRetrieve,
  type LegalCorpusHit,
  type LegalCorpusRetrieveResult,
} from "./retrieve.js";

export async function legalCorpusHybridRetrieve(params: {
  query: string;
  domains?: string[];
  topK?: number;
  maxChars?: number;
  forceCofounderCritical?: boolean;
}): Promise<LegalCorpusRetrieveResult & { retrieval_mode: "hybrid" | "bm25_only" }> {
  const topK = params.topK ?? 10;

  const bm25 = await legalCorpusRetrieve({ ...params, topK: topK * 2 });

  const queryVec = await embedText(params.query);
  if (!queryVec) {
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }

  try {
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
       WHERE c.embedding IS NOT NULL`,
    );

    const semanticScored: LegalCorpusHit[] = [];
    for (const r of rows.rows) {
      if (!r.embedding?.length) continue;
      const sim = cosineSimilarity(queryVec, r.embedding);
      if (sim < 0.25) continue;
      semanticScored.push({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        slug: r.slug,
        title: r.title,
        citation: r.citation ?? "",
        domain: r.domain,
        priority: r.priority,
        rank: sim,
        content: r.content,
      });
    }

    const merged = new Map<number, LegalCorpusHit>();
    for (const h of bm25.hits) {
      merged.set(h.chunk_id, { ...h, rank: h.rank * 0.45 });
    }
    for (const h of semanticScored) {
      const existing = merged.get(h.chunk_id);
      if (existing) {
        existing.rank = existing.rank + h.rank * 0.55;
      } else {
        merged.set(h.chunk_id, { ...h, rank: h.rank * 0.55 });
      }
    }

    const sorted = [...merged.values()]
      .sort((a, b) => {
        if (a.priority === "critical" && b.priority !== "critical") return -1;
        if (b.priority === "critical" && a.priority !== "critical") return 1;
        return b.rank - a.rank;
      })
      .slice(0, topK);

    const maxChars = params.maxChars ?? 8000;
    const parts: string[] = [];
    let len = 0;
    let truncated = false;
    for (const h of sorted) {
      const section =
        `[${h.slug}] ${h.title}\nCitation: ${h.citation}\n` +
        `Domain: ${h.domain} | score: ${h.rank.toFixed(3)}\n${h.content}\n`;
      if (len + section.length > maxChars) {
        truncated = true;
        break;
      }
      parts.push(section);
      len += section.length;
    }

    return {
      hits: sorted,
      context_block: parts.join("\n---\n"),
      corpus_version: bm25.corpus_version,
      truncated,
      retrieval_mode: "hybrid",
    };
  } catch (err: unknown) {
    logger.warn({ err }, "hybridRetrieve: semantic leg failed — BM25 only");
    return { ...bm25, hits: bm25.hits.slice(0, topK), retrieval_mode: "bm25_only" };
  }
}
