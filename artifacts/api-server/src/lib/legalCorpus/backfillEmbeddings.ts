import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText, EMBED_DIM } from "./embeddings.js";

export interface EmbedBackfillResult {
  updated: number;
  remaining: number;
  stopped_early: boolean;
}

/** Backfill chunk embeddings (non-blocking on boot; full run via embed-backfill route). */
export async function backfillLegalCorpusEmbeddings(
  opts: { maxChunks?: number; delayMs?: number } = {},
): Promise<EmbedBackfillResult> {
  const maxChunks = opts.maxChunks ?? 500;
  const delayMs = opts.delayMs ?? 400;

  if (process.env.LEGAL_EMBED_DISABLE === "true") {
    return { updated: 0, remaining: 0, stopped_early: false };
  }

  try {
    const stale = await pool.query(
      `UPDATE legal_corpus_chunks
       SET embedding = NULL, embedding_vec = NULL
       WHERE embedding IS NOT NULL
         AND coalesce(array_length(embedding, 1), 0) <> $1`,
      [EMBED_DIM],
    );
    if (stale.rowCount && stale.rowCount > 0) {
      logger.info({ cleared: stale.rowCount, dim: EMBED_DIM }, "legalCorpus: cleared stale embeddings");
    }

    // Chunks missing either column (legacy boot backfill only wrote embedding real[]).
    let totalUpdated = 0;
    let stoppedEarly = false;

    while (totalUpdated < maxChunks) {
      const rows = await pool.query<{ id: number; content: string }>(
        `SELECT id, content FROM legal_corpus_chunks
         WHERE embedding IS NULL OR embedding_vec IS NULL
         LIMIT 25`,
      );
      if (rows.rows.length === 0) break;

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

        await pool.query(
          `UPDATE legal_corpus_chunks
           SET embedding = $1::real[], embedding_vec = $2::vector
           WHERE id = $3`,
          [vec, `[${vec.join(",")}]`, row.id],
        );
        totalUpdated++;

        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      if (stoppedEarly) break;
    }

    const remainingRows = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM legal_corpus_chunks
       WHERE embedding IS NULL OR embedding_vec IS NULL`,
    );
    const remaining = parseInt(remainingRows.rows[0]?.n ?? "0", 10);

    if (totalUpdated > 0) {
      logger.info({ updated: totalUpdated, remaining }, "legalCorpus: embeddings backfilled");
    }

    return { updated: totalUpdated, remaining, stopped_early: stoppedEarly };
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus: embedding backfill failed");
    return { updated: 0, remaining: -1, stopped_early: true };
  }
}
