/**
 * ingestBatch — bulk upsert with source_hash idempotency.
 *
 * Extends the single-doc `ingestLegalDocument` pattern with:
 *   - source_type / source_url / source_hash columns
 *   - Skip-if-hash-matches (avoids re-embedding unchanged documents)
 *   - Writes to both `embedding real[]` and `embedding_vec vector(2048)`
 *
 * Used by the ingest CLI and can be called from the API server.
 */

import { pool } from "@workspace/db";
import { chunkLegalText } from "./chunkText.js";
import { embedText } from "./embeddings.js";
import { LEGAL_CORPUS_VERSION } from "./documents.js";
import { logger } from "../logger.js";

export interface IngestBatchEntry {
  slug: string;
  title: string;
  citation?: string;
  domain: string;
  tags?: string[];
  priority?: "critical" | "normal" | "high" | "medium";
  content: string;
  source_type: string;
  source_url?: string;
  /** If provided, skip upsert when the stored hash matches. */
  source_hash?: string;
}

export interface IngestBatchResult {
  slug: string;
  document_id: number;
  chunks: number;
  skipped: boolean;
}

/**
 * Compute a simple SHA-256 hash of content for idempotency checks.
 * Runs in Node 18+ via `crypto.subtle`.
 */
export async function computeSourceHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Ingest a single document with source_hash idempotency.
 * If source_hash is provided and matches the stored hash, the document is skipped.
 * Otherwise, the document is upserted and all chunks are recreated.
 */
export async function ingestBatchDocument(
  entry: IngestBatchEntry,
): Promise<IngestBatchResult> {
  const {
    slug,
    title,
    citation,
    domain,
    tags = [],
    priority = "normal",
    content,
    source_type,
    source_url,
    source_hash,
  } = entry;

  // ── Idempotency check ──────────────────────────────────────────────────
  if (source_hash) {
    const existing = await pool.query<{ source_hash: string }>(
      `SELECT source_hash FROM legal_corpus_documents WHERE slug = $1`,
      [slug],
    );
    if (existing.rows.length > 0 && existing.rows[0].source_hash === source_hash) {
      logger.info({ slug }, "ingestBatch: skipping unchanged document");
      return {
        slug,
        document_id: 0,
        chunks: 0,
        skipped: true,
      };
    }
  }

  // ── Upsert document ────────────────────────────────────────────────────
  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO legal_corpus_documents
       (slug, title, citation, domain, tags, priority, corpus_version, content,
        source_type, source_url, source_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       citation = EXCLUDED.citation,
       domain = EXCLUDED.domain,
       tags = EXCLUDED.tags,
       priority = EXCLUDED.priority,
       corpus_version = EXCLUDED.corpus_version,
       content = EXCLUDED.content,
       source_type = EXCLUDED.source_type,
       source_url = EXCLUDED.source_url,
       source_hash = EXCLUDED.source_hash,
       updated_at = now()
     RETURNING id`,
    [
      slug,
      title,
      citation ?? null,
      domain,
      tags,
      priority,
      LEGAL_CORPUS_VERSION,
      content,
      source_type,
      source_url ?? null,
      source_hash ?? null,
    ],
  );

  const documentId = upsert.rows[0].id;

  // ── Delete old chunks ──────────────────────────────────────────────────
  await pool.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [
    documentId,
  ]);

  // ── Chunk + embed ──────────────────────────────────────────────────────
  const chunks = chunkLegalText(content);
  for (let i = 0; i < chunks.length; i++) {
    const vec = await embedText(chunks[i]);
    // Write to both embedding (real[]) and embedding_vec (vector) columns
    await pool.query(
      `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content, embedding, embedding_vec)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        documentId,
        i,
        chunks[i],
        vec ?? null,
        vec ? JSON.stringify(vec) : null, // pgvector accepts JSON string for vector type
      ],
    );
  }

  logger.info({ slug, chunks: chunks.length }, "ingestBatch: document ingested");

  return {
    slug,
    document_id: documentId,
    chunks: chunks.length,
    skipped: false,
  };
}

/**
 * Batch ingest multiple documents sequentially.
 * Returns results for each document, including skips.
 */
export async function ingestBatch(
  entries: IngestBatchEntry[],
  opts?: { delayMs?: number },
): Promise<IngestBatchResult[]> {
  const delayMs = opts?.delayMs ?? 1000; // 1s default for OpenRouter rate limit
  const results: IngestBatchResult[] = [];

  for (const entry of entries) {
    const result = await ingestBatchDocument(entry);
    results.push(result);
    if (!result.skipped && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}
