import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText } from "./embeddings.js";
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
  stopped_early: boolean;
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
  opts: { maxChunks?: number; delayMs?: number } = {},
): Promise<EmbedBackfillResult> {
  const maxChunks = opts.maxChunks ?? 500;
  const delayMs = opts.delayMs ?? 400;

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
    const toEmbed = allRows.rows.filter((row) => {
      const pointId = row.document_id * 10000 + row.chunk_index;
      return !existingIds.has(pointId);
    });

    if (toEmbed.length === 0) {
      logger.info("legalCorpus: backfill — all chunks already in Qdrant");
      return { updated: 0, remaining: 0, stopped_early: false };
    }

    logger.info({ toEmbed: toEmbed.length }, "legalCorpus: backfill — chunks needing embedding");

    let totalUpdated = 0;
    let stoppedEarly = false;

    const points: QdrantPoint[] = [];
    for (const row of toEmbed) {
      if (totalUpdated >= maxChunks) {
        stoppedEarly = true;
        break;
      }

      const vec = await embedText(row.content);
      if (!vec) {
        stoppedEarly = true;
        break;
      }

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

      totalUpdated++;

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (points.length > 0) {
      await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
    }

    const remaining = toEmbed.length - totalUpdated;

    if (totalUpdated > 0) {
      logger.info({ updated: totalUpdated, remaining }, "legalCorpus: embeddings backfilled to Qdrant");
    }

    return { updated: totalUpdated, remaining, stopped_early: stoppedEarly };
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus: embedding backfill failed");
    return { updated: 0, remaining: -1, stopped_early: true };
  }
}
