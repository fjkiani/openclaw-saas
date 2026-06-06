import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { embedText, EMBED_DIM } from "./embeddings.js";

/** Backfill chunk embeddings (non-blocking; safe to call on boot). */
export async function backfillLegalCorpusEmbeddings(): Promise<void> {
  if (process.env.LEGAL_EMBED_DISABLE === "true") return;

  try {
    const stale = await pool.query(
      `UPDATE legal_corpus_chunks
       SET embedding = NULL
       WHERE embedding IS NOT NULL
         AND coalesce(array_length(embedding, 1), 0) <> $1`,
      [EMBED_DIM],
    );
    if (stale.rowCount && stale.rowCount > 0) {
      logger.info({ cleared: stale.rowCount, dim: EMBED_DIM }, "legalCorpus: cleared stale embeddings");
    }

    let totalUpdated = 0;
    for (let batch = 0; batch < 20; batch++) {
      const rows = await pool.query<{ id: number; content: string }>(
        `SELECT id, content FROM legal_corpus_chunks WHERE embedding IS NULL LIMIT 25`,
      );
      if (rows.rows.length === 0) break;

      for (const row of rows.rows) {
        const vec = await embedText(row.content);
        if (!vec) return;
        await pool.query(`UPDATE legal_corpus_chunks SET embedding = $1::real[] WHERE id = $2`, [
          vec,
          row.id,
        ]);
        totalUpdated++;
      }
    }
    if (totalUpdated > 0) {
      logger.info({ updated: totalUpdated }, "legalCorpus: embeddings backfilled");
    }
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus: embedding backfill failed");
  }
}
