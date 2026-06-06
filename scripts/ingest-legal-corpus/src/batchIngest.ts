/**
 * batchIngest.ts — Chunk + embed + upsert with source_hash.
 *
 * Duplicates ~55 lines from @workspace/api-server (chunkLegalText + embedText + pool setup)
 * to avoid cross-package build coupling. The CLI runs independently with tsx.
 */

import pg from "pg";
import { createHash } from "node:crypto";

// ── Duplicated chunk logic (from chunkText.ts) ─────────────────────────────
const CHUNK_WORDS = 280;
const CHUNK_OVERLAP = 40;

function chunkLegalText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + CHUNK_WORDS).join(" "));
    i += CHUNK_WORDS - CHUNK_OVERLAP;
    if (i >= words.length) break;
  }
  return chunks.filter((c) => c.trim().length > 40);
}

// ── Duplicated embed logic (from embeddings.ts) ────────────────────────────
const EMBED_MODEL =
  process.env.LEGAL_EMBED_MODEL ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free";

async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;

  const input = text.slice(0, 8192);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://openclaw-api-k30t.onrender.com",
        "X-Title": "OpenClaw Legal RAG Ingest CLI",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`Embed API error: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = data.data?.[0]?.embedding;
    if (!vec?.length) return null;
    return vec;
  } catch (err: unknown) {
    console.warn(`Embed failed: ${err}`);
    return null;
  }
}

// ── Pool setup ─────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// ── Types ──────────────────────────────────────────────────────────────────
export interface BatchEntry {
  slug: string;
  title: string;
  domain: string;
  priority: "critical" | "normal" | "high" | "medium";
  content: string;
  source_type: string;
  source_url?: string;
}

export interface BatchResult {
  slug: string;
  document_id: number;
  chunks: number;
  skipped: boolean;
  error?: string;
}

export interface BatchOptions {
  embed: boolean;
  delayMs: number;
  onProgress?: (slug: string, idx: number, total: number) => void;
  onResult?: (result: BatchResult) => void;
  maxRetries?: number;
}

/**
 * Compute SHA-256 hash of content for idempotency.
 */
function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Ingest a single document with source_hash idempotency.
 */
async function ingestOne(
  entry: BatchEntry,
  embed: boolean,
  maxRetries: number,
): Promise<BatchResult> {
  const sourceHash = computeHash(entry.content);

  // ── Idempotency check ──────────────────────────────────────────────────
  const existing = await pool.query<{ source_hash: string }>(
    `SELECT source_hash FROM legal_corpus_documents WHERE slug = $1`,
    [entry.slug],
  );
  if (existing.rows.length > 0 && existing.rows[0].source_hash === sourceHash) {
    return { slug: entry.slug, document_id: 0, chunks: 0, skipped: true };
  }

  // ── Upsert document ────────────────────────────────────────────────────
  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO legal_corpus_documents
       (slug, title, citation, domain, tags, priority, corpus_version, content,
        source_type, source_url, source_hash, updated_at)
     VALUES ($1, $2, NULL, $3, '{}', $4, 'legal-corpus-pg-v1', $5, $6, $7, $8, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       domain = EXCLUDED.domain,
       priority = EXCLUDED.priority,
       content = EXCLUDED.content,
       source_type = EXCLUDED.source_type,
       source_url = EXCLUDED.source_url,
       source_hash = EXCLUDED.source_hash,
       updated_at = now()
     RETURNING id`,
    [
      entry.slug,
      entry.title,
      entry.domain,
      entry.priority,
      entry.content,
      entry.source_type,
      entry.source_url ?? null,
      sourceHash,
    ],
  );

  const documentId = upsert.rows[0].id;

  // ── Delete old chunks ──────────────────────────────────────────────────
  await pool.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [
    documentId,
  ]);

  // ── Chunk + embed ──────────────────────────────────────────────────────
  const chunks = chunkLegalText(entry.content);
  for (let i = 0; i < chunks.length; i++) {
    let vec: number[] | null = null;

    if (embed) {
      // Retry logic for rate limits (429) and transient errors
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        vec = await embedText(chunks[i]);
        if (vec !== null) break;

        if (attempt < maxRetries) {
          const waitMs = Math.min(60_000, 1000 * Math.pow(2, attempt));
          console.warn(
            `  Embed retry ${attempt + 1}/${maxRetries} for chunk ${i} of ${entry.slug}, waiting ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }

    // Write to both embedding (real[]) and embedding_vec (vector) columns
    await pool.query(
      `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content, embedding, embedding_vec)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        documentId,
        i,
        chunks[i],
        vec ?? null,
        vec ? JSON.stringify(vec) : null,
      ],
    );
  }

  return { slug: entry.slug, document_id: documentId, chunks: chunks.length, skipped: false };
}

/**
 * Batch ingest multiple documents sequentially.
 */
export async function batchIngest(
  entries: BatchEntry[],
  opts: BatchOptions,
): Promise<BatchResult[]> {
  const { embed, delayMs, onProgress, onResult, maxRetries = 3 } = opts;
  const results: BatchResult[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    onProgress?.(entry.slug, idx, entries.length);

    try {
      const result = await ingestOne(entry, embed, maxRetries);
      results.push(result);
      onResult?.(result);

      // Rate limit delay between documents (not between chunks — chunk delay is inside embedText)
      if (!result.skipped && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${entry.slug}: ${msg}`);
      results.push({
        slug: entry.slug,
        document_id: 0,
        chunks: 0,
        skipped: false,
        error: msg,
      });
    }
  }

  return results;
}

/**
 * Close the pool — call after all ingests are done.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
