/**
 * Multi-query hybrid retrieval — improves coverage for long contracts.
 */

import { legalCorpusHybridRetrieve } from "../legalCorpus/hybridRetrieve.js";
import { buildContextBlock, type RRFResult } from "../legalCorpus/rrfMerge.js";
import {
  COFOUNDER_STATUTE_SLUGS,
  fetchCofounderStatuteHits,
  type LegalCorpusHit,
} from "../legalCorpus/retrieve.js";

export async function mergedHybridRetrieve(params: {
  queries: string[];
  domains?: string[];
  topK?: number;
  maxChars?: number;
  forceCofounderCritical?: boolean;
}): Promise<{
  hits: LegalCorpusHit[];
  context_block: string;
  truncated: boolean;
  retrieval_mode: "hybrid" | "bm25_only";
  queries_run: number;
  forced_slugs_retrieved: string[];
}> {
  const topK = params.topK ?? 12;
  const maxChars = params.maxChars ?? 8000;
  const byChunk = new Map<number, LegalCorpusHit & { best_rank: number }>();
  let retrieval_mode: "hybrid" | "bm25_only" = "hybrid";

  if (params.forceCofounderCritical) {
    const forced = await fetchCofounderStatuteHits();
    for (const h of forced) {
      byChunk.set(h.chunk_id, { ...h, best_rank: 2 });
    }
  }

  for (const query of params.queries) {
    const r = await legalCorpusHybridRetrieve({
      query,
      domains: params.domains,
      topK,
      maxChars,
      forceCofounderCritical: false,
    });
    if (r.retrieval_mode === "bm25_only") retrieval_mode = "bm25_only";

    for (const h of r.hits) {
      const existing = byChunk.get(h.chunk_id);
      if (!existing || h.rank > existing.best_rank) {
        byChunk.set(h.chunk_id, { ...h, best_rank: h.rank });
      }
    }
  }

  const hits = [...byChunk.values()]
    .sort((a, b) => b.best_rank - a.best_rank)
    .slice(0, topK)
    .map(({ best_rank: _, ...h }) => h);

  const rrfItems: RRFResult[] = hits.map((h, i) => ({
    chunk_id: h.chunk_id,
    document_id: h.document_id,
    slug: h.slug,
    title: h.title,
    citation: h.citation,
    domain: h.domain,
    priority: h.priority,
    content: h.content,
    rrf_score: 1 / (i + 1),
  }));

  const { block, truncated } = buildContextBlock(rrfItems, maxChars);

  const forcedSet = new Set<string>(COFOUNDER_STATUTE_SLUGS);
  const forced_slugs_retrieved = [...new Set(hits.filter((h) => forcedSet.has(h.slug)).map((h) => h.slug))];

  return {
    hits,
    context_block: block,
    truncated,
    retrieval_mode,
    queries_run: params.queries.length,
    forced_slugs_retrieved,
  };
}
