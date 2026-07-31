import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { deleteByFilter, LEGAL_CORPUS_COLLECTION } from "../qdrantClient.js";

/**
 * Remove non-corpus documents from BOTH Postgres and Qdrant so the legal corpus
 * contains only real ingested contract language (CUAD). This purges:
 *   - source_type='seed'  — the 12 legacy boot-seed docs (the thin text-matcher content)
 *   - source_type='texts' — ad-hoc diagnostic/test docs ingested via the texts source
 * The ingested corpus (source_type IN ('cuad','statute','nvca')) is canonical and untouched.
 *
 * Postgres rows are deleted (cascades to chunks); Qdrant points are removed by
 * document_id filter so no orphaned vectors remain.
 */
export async function cleanupBootSeedDocuments(): Promise<{
  deleted: number;
  slugs: string[];
  qdrant_deleted: number;
}> {
  // Collect the document_ids being removed so we can purge their Qdrant points.
  const toDelete = await pool.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM legal_corpus_documents WHERE source_type IN ('seed', 'texts')`,
  );
  const docIds = toDelete.rows.map((r) => r.id);
  const slugs = toDelete.rows.map((r) => r.slug);

  // Delete Postgres rows (cascades to legal_corpus_chunks).
  const result = await pool.query<{ slug: string }>(
    `DELETE FROM legal_corpus_documents WHERE source_type IN ('seed', 'texts') RETURNING slug`,
  );

  // Delete the corresponding Qdrant points so no orphaned vectors remain.
  let qdrantDeleted = 0;
  for (const documentId of docIds) {
    try {
      await deleteByFilter(LEGAL_CORPUS_COLLECTION, {
        must: [{ key: "document_id", match: { value: documentId } }],
      });
      qdrantDeleted++;
    } catch (err) {
      logger.warn({ err, documentId }, "legalCorpus: failed to delete Qdrant points for purged doc");
    }
  }

  if (slugs.length > 0) {
    logger.info(
      { deleted: slugs.length, qdrantDeleted, slugs },
      "legalCorpus: purged seed/test documents from Postgres + Qdrant",
    );
  }
  return { deleted: slugs.length, slugs, qdrant_deleted: qdrantDeleted };
}
