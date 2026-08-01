import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedTextWithRetry, embedBatchWithRetry } from "./embeddings.js";
import {
  ensureCollection,
  upsertPoints,
  scrollPoints,
  LEGAL_CORPUS_COLLECTION,
  LEGAL_EMBED_DIM,
  type QdrantPoint,
} from "../qdrantClient.js";

export interface EmbedBackfillResult {
  updated: number;
  remaining: number;
  failed?: number;
  stopped_early: boolean;
}

/**
 * In-process tracker for a fire-and-forget full backfill. Lets the route kick
 * off the job detached (so the host's HTTP proxy timeout never applies) and
 * lets a status endpoint report progress. Single-process (Render runs one
 * instance), so a module-level flag is sufficient.
 */
export interface BackfillJobState {
  running: boolean;
  startedAt: string | null;
  updated: number;
  failed: number;
  finishedAt: string | null;
  error: string | null;
}

const jobState: BackfillJobState = {
  running: false,
  startedAt: null,
  updated: 0,
  failed: 0,
  finishedAt: null,
  error: null,
};

export function getBackfillJobState(): BackfillJobState {
  return { ...jobState };
}

/**
 * Start a full backfill (all remaining chunks) as a detached in-process task.
 * Returns immediately. Idempotent: if a job is already running, returns false
 * and does not start a second one. The task loops backfillLegalCorpusEmbeddings
 * until no chunks remain, accumulating progress into jobState.
 */
export function startFullBackfillInBackground(opts: { delayMs?: number; batchSize?: number; chunkPerCall?: number } = {}): boolean {
  if (jobState.running) return false;
  jobState.running = true;
  jobState.startedAt = new Date().toISOString();
  jobState.updated = 0;
  jobState.failed = 0;
  jobState.finishedAt = null;
  jobState.error = null;

  // Pace batches to stay under Gemini's free-tier per-minute embed limit
  // (~100 req/min). batchEmbedContents counts 1 request per batch, so a
  // 1200ms gap caps throughput at ~50 batches/min — safely under the cap
  // while still embedding ~5,000 chunks/min (100 texts/batch).
  const delayMs = opts.delayMs ?? 1200;
  const batchSize = opts.batchSize ?? 100;
  const chunkPerCall = opts.chunkPerCall ?? 2000;

  void (async () => {
    try {
      // Loop until a pass reports zero remaining (all chunks vectorized).
      // Each pass is resumable via existing-ID skip, so this is safe to re-run.
      for (;;) {
        const r = await backfillLegalCorpusEmbeddings({ maxChunks: chunkPerCall, delayMs, batchSize });
        jobState.updated += r.updated;
        jobState.failed += r.failed ?? 0;
        logger.info({ passUpdated: r.updated, passRemaining: r.remaining, totalUpdated: jobState.updated }, "legalCorpus: background backfill pass complete");
        if (r.remaining <= 0 || (r.updated === 0 && (r.failed ?? 0) === 0)) {
          break;
        }
      }
      jobState.finishedAt = new Date().toISOString();
      logger.info({ updated: jobState.updated, failed: jobState.failed }, "legalCorpus: background backfill FINISHED");
    } catch (err: unknown) {
      jobState.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "legalCorpus: background backfill failed");
    } finally {
      jobState.running = false;
    }
  })();

  return true;
}

/**
 * Backfill chunk embeddings into Qdrant.
 * Reads chunks from Postgres (where content lives), embeds them, and upserts
 * to the Qdrant openclaw_legal_corpus collection.
 *
 * Replaces the old pgvector backfill that wrote to embedding_vec column.
 * Does NOT depend on a Postgres embedding column — checks Qdrant directly
 * for which points already exist.
 */
export async function backfillLegalCorpusEmbeddings(
  opts: { maxChunks?: number; delayMs?: number; batchSize?: number } = {},
): Promise<EmbedBackfillResult> {
  const maxChunks = opts.maxChunks ?? 500;
  const delayMs = opts.delayMs ?? 400;
  // Texts per batchEmbedContents request (Gemini caps at 100). Larger batches
  // mean far fewer rate-limited requests on long backfills.
  const batchSize = Math.min(Math.max(opts.batchSize ?? 100, 1), 100);

  if (process.env.LEGAL_EMBED_DISABLE === "true") {
    return { updated: 0, remaining: 0, stopped_early: false };
  }

  const qdrantOk = await ensureCollection(LEGAL_CORPUS_COLLECTION, LEGAL_EMBED_DIM, "Cosine");
  if (!qdrantOk) {
    logger.warn("legalCorpus: Qdrant not configured — backfill skipped");
    return { updated: 0, remaining: -1, stopped_early: true };
  }

  try {
    // Get all existing Qdrant point IDs (to skip already-embedded chunks)
    const existingIds = new Set<number>();
    let offset: number | undefined;
    do {
      const { points, nextOffset } = await scrollPoints(LEGAL_CORPUS_COLLECTION, {
        limit: 100,
        offset,
        withPayload: false,
        withVector: false,
      });
      for (const p of points) {
        existingIds.add(p.id);
      }
      offset = nextOffset;
    } while (offset !== undefined);

    logger.info({ existingInQdrant: existingIds.size }, "legalCorpus: backfill — found existing Qdrant points");

    // Get all chunks from Postgres
    const allRows = await pool.query<{
      id: number;
      document_id: number;
      chunk_index: number;
      content: string;
      slug: string;
      title: string;
      citation: string;
      domain: string;
      priority: string;
    }>(
      `SELECT c.id, c.document_id, c.chunk_index, c.content,
              d.slug, d.title, d.citation, d.domain, d.priority
       FROM legal_corpus_chunks c
       JOIN legal_corpus_documents d ON d.id = c.document_id
       ORDER BY c.document_id, c.chunk_index`,
    );

    // Filter to chunks not yet in Qdrant
    const toEmbed = allRows.rows.filter((row: (typeof allRows.rows)[number]) => {
      const pointId = row.document_id * 10000 + row.chunk_index;
      return !existingIds.has(pointId);
    });

    if (toEmbed.length === 0) {
      logger.info("legalCorpus: backfill — all chunks already in Qdrant");
      return { updated: 0, remaining: 0, stopped_early: false };
    }

    logger.info({ toEmbed: toEmbed.length }, "legalCorpus: backfill — chunks needing embedding");

    let totalUpdated = 0;
    let failed = 0;
    let stoppedEarly = false;

    // Cap the work to maxChunks up front so batching respects the same limit.
    const work = toEmbed.slice(0, maxChunks);
    stoppedEarly = toEmbed.length > work.length;

    const points: QdrantPoint[] = [];

    const pushPoint = (row: (typeof work)[number], vec: number[]): void => {
      const pointId = row.document_id * 10000 + row.chunk_index;
      points.push({
        id: pointId,
        vector: vec,
        payload: {
          document_id: row.document_id,
          chunk_id: row.chunk_index,
          chunk_index: row.chunk_index,
          slug: row.slug,
          title: row.title,
          citation: row.citation ?? "",
          domain: row.domain,
          priority: row.priority,
          content: row.content,
        },
      });
    };

    // Process in batches of `batchSize` texts per API request. Batching cuts
    // the number of rate-limited requests ~100x vs one request per chunk.
    for (let i = 0; i < work.length; i += batchSize) {
      const slice = work.slice(i, i + batchSize);
      const vecs = await embedBatchWithRetry(slice.map((r: (typeof work)[number]) => r.content));

      if (vecs) {
        for (let j = 0; j < slice.length; j++) {
          const vec = vecs[j];
          if (vec) {
            pushPoint(slice[j], vec);
            totalUpdated++;
          } else {
            // Per-text failure inside a successful batch: fall back to single.
            const single = await embedTextWithRetry(slice[j].content);
            if (single) {
              pushPoint(slice[j], single);
              totalUpdated++;
            } else {
              failed++;
              logger.warn({ documentId: slice[j].document_id, chunkIndex: slice[j].chunk_index }, "legalCorpus: backfill — chunk embed failed after batch+single retries, skipping");
            }
          }
        }
      } else {
        // Whole-batch request failed after retries: fall back to per-chunk
        // single embeds so one bad batch does not lose the whole slice.
        logger.warn({ batchStart: i, count: slice.length }, "legalCorpus: backfill — batch failed, falling back to single embeds");
        for (const row of slice) {
          const vec = await embedTextWithRetry(row.content);
          if (vec) {
            pushPoint(row, vec);
            totalUpdated++;
          } else {
            failed++;
          }
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }

      // Upsert incrementally per batch so progress is durable even if the
      // request is later interrupted (free-tier request timeouts).
      if (points.length > 0) {
        await upsertPoints(LEGAL_CORPUS_COLLECTION, points.splice(0, points.length));
      }

      if (delayMs > 0 && i + batchSize < work.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const remaining = toEmbed.length - totalUpdated - failed;

    if (totalUpdated > 0 || failed > 0) {
      logger.info({ updated: totalUpdated, failed, remaining }, "legalCorpus: embeddings backfilled to Qdrant");
    }

    return { updated: totalUpdated, remaining, failed, stopped_early: stoppedEarly };
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus: embedding backfill failed");
    return { updated: 0, remaining: -1, stopped_early: true };
  }
}
