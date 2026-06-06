/**
 * rrfMerge.ts — Reciprocal Rank Fusion merge for hybrid retrieval.
 *
 * Extracted from hybridRetrieve.ts for testability and reuse.
 * RRF formula: score = Σ (1 / (k + rank_i))  where k = 60 (standard constant)
 */

export interface RRFItem {
  chunk_id: number;
  document_id: number;
  slug: string;
  title: string;
  citation: string;
  domain: string;
  priority: string;
  content: string;
}

export interface RRFResult extends RRFItem {
  rrf_score: number;
}

const RRF_K = 60;

/**
 * Merge two ranked lists using Reciprocal Rank Fusion.
 *
 * @param bm25Hits  - BM25 results, pre-sorted by relevance (best first)
 * @param semanticHits - Semantic/vector results, pre-sorted by similarity (best first)
 * @param weights - Optional weights for each source [bm25Weight, semanticWeight].
 *                   Default: [0.45, 0.55] matching the original hybridRetrieve.
 * @returns Merged results sorted by RRF score (with critical priority override)
 */
export function rrfMerge(
  bm25Hits: RRFItem[],
  semanticHits: RRFItem[],
  weights: [number, number] = [0.45, 0.55],
): RRFResult[] {
  const [bm25Weight, semanticWeight] = weights;

  // Build rank maps (1-indexed)
  const bm25Ranks = new Map<number, number>();
  bm25Hits.forEach((h, i) => bm25Ranks.set(h.chunk_id, i + 1));

  const semanticRanks = new Map<number, number>();
  semanticHits.forEach((h, i) => semanticRanks.set(h.chunk_id, i + 1));

  // Collect all unique chunk_ids
  const allChunkIds = new Set<number>();
  for (const h of bm25Hits) allChunkIds.add(h.chunk_id);
  for (const h of semanticHits) allChunkIds.add(h.chunk_id);

  // Build lookup by chunk_id (prefer semantic hit for richer data)
  const byChunkId = new Map<number, RRFItem>();
  for (const h of bm25Hits) byChunkId.set(h.chunk_id, h);
  for (const h of semanticHits) byChunkId.set(h.chunk_id, h);

  // Compute RRF scores
  const results: RRFResult[] = [];
  for (const chunkId of allChunkIds) {
    const item = byChunkId.get(chunkId)!;
    let score = 0;

    const bm25Rank = bm25Ranks.get(chunkId);
    if (bm25Rank !== undefined) {
      score += bm25Weight / (RRF_K + bm25Rank);
    }

    const semanticRank = semanticRanks.get(chunkId);
    if (semanticRank !== undefined) {
      score += semanticWeight / (RRF_K + semanticRank);
    }

    results.push({
      ...item,
      rrf_score: score,
    });
  }

  // Sort: critical priority first, then by RRF score
  results.sort((a, b) => {
    if (a.priority === "critical" && b.priority !== "critical") return -1;
    if (b.priority === "critical" && a.priority !== "critical") return 1;
    return b.rrf_score - a.rrf_score;
  });

  return results;
}

/**
 * Build a context block from ranked hits, respecting maxChars limit.
 */
export function buildContextBlock(
  hits: RRFResult[],
  maxChars: number,
): { block: string; truncated: boolean } {
  const parts: string[] = [];
  let len = 0;
  let truncated = false;

  for (const h of hits) {
    const section =
      `[${h.slug}] ${h.title}\n` +
      `Citation: ${h.citation}\n` +
      `Domain: ${h.domain} | rrf: ${h.rrf_score.toFixed(4)}\n` +
      `${h.content}\n`;
    if (len + section.length > maxChars) {
      truncated = true;
      const remaining = maxChars - len - 20;
      if (remaining > 200) {
        parts.push(section.slice(0, remaining) + "\n...[truncated]");
      }
      break;
    }
    parts.push(section);
    len += section.length;
  }

  return { block: parts.join("\n---\n"), truncated };
}
