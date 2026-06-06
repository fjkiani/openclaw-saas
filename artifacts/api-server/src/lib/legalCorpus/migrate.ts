import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { chunkLegalText } from "./chunkText.js";
import { LEGAL_CORPUS_SEED, LEGAL_CORPUS_VERSION } from "./documents.js";

export async function migrateLegalCorpus(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_corpus_documents (
        id serial PRIMARY KEY,
        slug text UNIQUE NOT NULL,
        title text NOT NULL,
        citation text,
        domain text NOT NULL,
        tags text[] NOT NULL DEFAULT '{}',
        priority text NOT NULL DEFAULT 'normal',
        corpus_version text NOT NULL DEFAULT 'legal-corpus-pg-v1',
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_corpus_chunks (
        id serial PRIMARY KEY,
        document_id integer NOT NULL REFERENCES legal_corpus_documents(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        UNIQUE (document_id, chunk_index)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS legal_corpus_chunks_tsv_idx
        ON legal_corpus_chunks USING gin(tsv)
    `);

    for (const doc of LEGAL_CORPUS_SEED) {
      const upsert = await client.query<{ id: number }>(
        `INSERT INTO legal_corpus_documents
           (slug, title, citation, domain, tags, priority, corpus_version, content, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           citation = EXCLUDED.citation,
           domain = EXCLUDED.domain,
           tags = EXCLUDED.tags,
           priority = EXCLUDED.priority,
           corpus_version = EXCLUDED.corpus_version,
           content = EXCLUDED.content,
           updated_at = now()
         RETURNING id`,
        [
          doc.slug,
          doc.title,
          doc.citation,
          doc.domain,
          doc.tags,
          doc.priority,
          LEGAL_CORPUS_VERSION,
          doc.content,
        ],
      );

      const documentId = upsert.rows[0].id;
      await client.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [documentId]);

      const chunks = chunkLegalText(doc.content);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content)
           VALUES ($1, $2, $3)`,
          [documentId, i, chunks[i]],
        );
      }
    }

    logger.info(
      { documents: LEGAL_CORPUS_SEED.length, version: LEGAL_CORPUS_VERSION },
      "legalCorpus: migration complete",
    );
  } finally {
    client.release();
  }
}
