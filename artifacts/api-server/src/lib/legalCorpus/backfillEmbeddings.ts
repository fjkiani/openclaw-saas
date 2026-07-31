import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText, EMBED_DIM } from "./embeddings.js";
import {
  ensureCollection,
  upsertPoints,
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
    // Find chunks that are not yet in Qdrant.
    // We check by looking for chunks whose document_id+chunk_index combo
    // doesn't have a corresponding Qdrant point. Since we can't easily query
    // Qdrant for "missing" points, we re-embed all chunks that don't have
    // an embedding in the legacy embedding column (which we keep as a marker).
    let totalUpdated = 0;
    let stoppedEarly = false;

    while (totalUpdated < maxChunks) {
      const rows = await pool.query<{
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
         WHERE c.embedding IS NULL
         LIMIT 25`,
      );
      if (rows.rows.length === 0) break;

      const points: QdrantPoint[] = [];
      for (const row of rows.rows) {
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

        // Mark as embedded in Postgres (legacy column as marker)
        await pool.query(
          `UPDATE legal_corpus_chunks SET embedding = $1::real[] WHERE id = $2`,
          [vec, row.id],
        );

        totalUpdated++;

        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      if (points.length > 0) {
        await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
      }

      if (stoppedEarly) break;
    }

    const remainingRows = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM legal_corpus_chunks WHERE embedding IS NULL`,
    );
    const remaining = parseInt(remainingRows.rows[0]?.n ?? "0", 10);

    if (totalUpdated > 0) {
      logger.info({ updated: totalUpdated, remaining }, "legalCorpus: embeddings backfilled to Qdrant");
    }

    return { updated: totalUpdated, remaining, stopped_early: stoppedEarly };
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus: embedding backfill failed");
    return { updated: 0, remaining: -1, stopped_early: true };
  }
}
