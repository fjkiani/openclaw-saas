import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { chunkLegalText } from "./chunkText.js";
import { LEGAL_CORPUS_SEED, LEGAL_CORPUS_VERSION } from "./documents.js";
import { embedText } from "./embeddings.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilter,
  LEGAL_CORPUS_COLLECTION,
  LEGAL_EMBED_DIM,
  type QdrantPoint,
} from "../qdrantClient.js";

export async function migrateLegalCorpus(): Promise<void> {
  const client = await pool.connect();
  try {
    // ── Postgres tables (BM25 + metadata) ──────────────────────────────────
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

    // ── Qdrant collection for semantic search ──────────────────────────────
    // Replaces pgvector. Collection is prefixed openclaw_ to avoid contaminating
    // existing Qdrant collections in the cluster.
    const qdrantOk = await ensureCollection(LEGAL_CORPUS_COLLECTION, LEGAL_EMBED_DIM, "Cosine");
    if (qdrantOk) {
      logger.info(
        { collection: LEGAL_CORPUS_COLLECTION, dims: LEGAL_EMBED_DIM },
        "legalCorpus: Qdrant collection ready for semantic search",
      );
    } else {
      logger.warn(
        "legalCorpus: Qdrant not configured — semantic retrieval disabled, BM25-only fallback",
      );
    }

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

        // ── Seed Qdrant with embeddings for this document's chunks ──────────
        if (qdrantOk) {
          await seedQdrantForDocument(documentId, doc.slug, doc.title, doc.citation, doc.domain, doc.priority, chunks);
        }
      }
    }

    logger.info(
      {
        documents: bootSeedEnabled || !hasIngestedCorpus ? LEGAL_CORPUS_SEED.length : 0,
        version: LEGAL_CORPUS_VERSION,
        skipped_boot_seed: hasIngestedCorpus && !bootSeedEnabled,
        qdrant: qdrantOk,
      },
      "legalCorpus: migration complete",
    );
  } finally {
    client.release();
  }
}

/**
 * Embed each chunk and upsert into Qdrant.
 * Point IDs are derived from document_id and chunk_index to be deterministic.
 */
async function seedQdrantForDocument(
  documentId: number,
  slug: string,
  title: string,
  citation: string,
  domain: string,
  priority: string,
  chunks: string[],
): Promise<void> {
  // Delete existing points for this document (idempotent re-seed)
  await deleteByFilter(LEGAL_CORPUS_COLLECTION, {
    must: [{ key: "document_id", match: { value: documentId } }],
  });

  const points: QdrantPoint[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const vec = await embedText(chunks[i]);
    if (!vec) {
      logger.warn({ documentId, chunkIndex: i, slug }, "legalCorpus: embed failed — skipping chunk in Qdrant");
      continue;
    }

    // Deterministic point ID: documentId * 10000 + chunkIndex
    // (supports up to 10k chunks per document, well within limits)
    const pointId = documentId * 10000 + i;

    points.push({
      id: pointId,
      vector: vec,
      payload: {
        document_id: documentId,
        chunk_id: i,
        chunk_index: i,
        slug,
        title,
        citation,
        domain,
        priority,
        content: chunks[i],
      },
    });
  }

  if (points.length > 0) {
    const upserted = await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
    logger.info({ documentId, slug, chunks: chunks.length, upserted }, "legalCorpus: Qdrant seeded for document");
  }
}
