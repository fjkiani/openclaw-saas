import { pool } from "@workspace/db";
import { logger } from "../logger.js";

/** Remove legacy boot-seed docs; ingested corpus (cuad/statute/nvca) is canonical. */
export async function cleanupBootSeedDocuments(): Promise<{
  deleted: number;
  slugs: string[];
}> {
  const result = await pool.query<{ slug: string }>(
    `DELETE FROM legal_corpus_documents WHERE source_type = 'seed' RETURNING slug`,
  );
  const slugs = result.rows.map((r) => r.slug);
  if (slugs.length > 0) {
    logger.info({ deleted: slugs.length, slugs }, "legalCorpus: removed boot seed documents");
  }
  return { deleted: slugs.length, slugs };
}
