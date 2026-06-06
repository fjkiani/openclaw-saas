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

    // ── v2 columns: source tracking + idempotency ──────────────────────────
    await client.query(`
      ALTER TABLE legal_corpus_documents
        ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'seed',
        ADD COLUMN IF NOT EXISTS source_url text,
        ADD COLUMN IF NOT EXISTS source_hash text
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS legal_corpus_documents_source_hash_idx
        ON legal_corpus_documents(source_hash) WHERE source_hash IS NOT NULL
    `);

    // ── pgvector column for ANN search (Supabase has vector ext enabled) ────
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await client.query(`
      ALTER TABLE legal_corpus_chunks
        ADD COLUMN IF NOT EXISTS embedding real[]
    `);

    await client.query(`
      ALTER TABLE legal_corpus_chunks
        ADD COLUMN IF NOT EXISTS embedding_vec vector(2048)
    `);

    // HNSW limited to 2000 dims on Supabase; skip ANN index for 2048-dim Nemotron.

    const ingestedCount = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM legal_corpus_documents
       WHERE source_type IN ('cuad', 'statute', 'nvca')`,
    );
    const hasIngestedCorpus = (ingestedCount.rows[0]?.n ?? 0) > 0;
    const bootSeedEnabled = process.env.LEGAL_CORPUS_BOOT_SEED === "true";

    if (hasIngestedCorpus && !bootSeedEnabled) {
      logger.info(
        { ingested: ingestedCount.rows[0]?.n },
        "legalCorpus: skip boot seed — ingested corpus present",
      );
    } else {
      // ── Legacy playbook seeds (empty DB or LEGAL_CORPUS_BOOT_SEED=true only) ──
      for (const doc of LEGAL_CORPUS_SEED) {
        const upsert = await client.query<{ id: number }>(
          `INSERT INTO legal_corpus_documents
             (slug, title, citation, domain, tags, priority, corpus_version, content, source_type, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed', now())
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
    }

    logger.info(
      {
        documents: bootSeedEnabled || !hasIngestedCorpus ? LEGAL_CORPUS_SEED.length : 0,
        version: LEGAL_CORPUS_VERSION,
        skipped_boot_seed: hasIngestedCorpus && !bootSeedEnabled,
      },
      "legalCorpus: migration complete",
    );
  } finally {
    client.release();
  }
}
