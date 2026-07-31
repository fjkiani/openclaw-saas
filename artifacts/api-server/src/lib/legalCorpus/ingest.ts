import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { chunkLegalText } from "./chunkText.js";
import { embedText } from "./embeddings.js";
import { LEGAL_CORPUS_VERSION } from "./documents.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilter,
  LEGAL_CORPUS_COLLECTION,
  LEGAL_EMBED_DIM,
  type QdrantPoint,
} from "../qdrantClient.js";

export async function ingestLegalDocument(params: {
  slug: string;
  title: string;
  citation?: string;
  domain: string;
  tags?: string[];
  priority?: "critical" | "normal";
  content: string;
}): Promise<{ slug: string; document_id: number; chunks: number; qdrant_points: number }> {
  const { slug, title, citation, domain, tags = [], priority = "normal", content } = params;

  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO legal_corpus_documents
       (slug, title, citation, domain, tags, priority, corpus_version, content, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       citation = EXCLUDED.citation,
       domain = EXCLUDED.domain,
       tags = EXCLUDED.tags,
       priority = EXCLUDED.priority,
       content = EXCLUDED.content,
       updated_at = now()
     RETURNING id`,
    [slug, title, citation ?? null, domain, tags, priority, LEGAL_CORPUS_VERSION, content],
  );

  const documentId = upsert.rows[0].id;
  await pool.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [documentId]);

  const chunks = chunkLegalText(content);

  // Insert chunks into Postgres (for BM25 tsvector search)
  for (let i = 0; i < chunks.length; i++) {
    await pool.query(
      `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content)
       VALUES ($1, $2, $3)`,
      [documentId, i, chunks[i]],
    );
  }

  // ── Embed and upsert to Qdrant for semantic search ──────────────────────
  let qdrantPoints = 0;
  const qdrantOk = await ensureCollection(LEGAL_CORPUS_COLLECTION, LEGAL_EMBED_DIM, "Cosine");

  if (qdrantOk) {
    // Delete existing points for this document (idempotent re-ingest)
    await deleteByFilter(LEGAL_CORPUS_COLLECTION, {
      must: [{ key: "document_id", match: { value: documentId } }],
    });

    const points: QdrantPoint[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vec = await embedText(chunks[i]);
      if (!vec) {
        logger.warn({ documentId, chunkIndex: i, slug }, "ingest: embed failed — skipping chunk in Qdrant");
        continue;
      }

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
          citation: citation ?? "",
          domain,
          priority,
          content: chunks[i],
        },
      });
    }

    if (points.length > 0) {
      qdrantPoints = await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
    }
  } else {
    logger.warn({ slug }, "ingest: Qdrant not configured — chunks stored in Postgres only (BM25-only retrieval)");
  }

  return { slug, document_id: documentId, chunks: chunks.length, qdrant_points: qdrantPoints };
}
