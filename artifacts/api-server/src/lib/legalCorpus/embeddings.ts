/**
 * Gemini text embeddings for hybrid legal RAG.
 *
 * Uses Google's Generative Language API (gemini-embedding-001, 3072-dim).
 * The previous implementation used an OpenRouter free embed model that was
 * retired upstream (HTTP 402 / 0 quota). Gemini's embedding endpoint is
 * free-tier and returns 3072-dimensional vectors.
 */

import { resolveApiKey } from "../resolveApiKey.js";
import { logger } from "../logger.js";

const EMBED_MODEL =
  process.env.LEGAL_EMBED_MODEL ?? "gemini-embedding-001";
/** gemini-embedding-001 outputs 3072-dim vectors. */
const EMBED_DIM = 3072;

export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) return null;

  const input = text.slice(0, 8192);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: input }] },
          taskType: "RETRIEVAL_DOCUMENT",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "legalCorpus embed: API error");
      return null;
    }

    const data = (await res.json()) as {
      embedding?: { values?: number[] };
    };
    const vec = data.embedding?.values;
    if (!vec?.length) return null;
    return vec;
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus embed: failed");
    return null;
  }
}

/**
 * Embed with exponential-backoff retry on transient failures (rate limits,
 * network errors). embedText returns null on any failure; this retries up to
 * maxAttempts with backoff before giving up. Returns null only after all
 * attempts fail — so callers can distinguish "permanently failed" from
 * "transiently rate-limited" and keep making progress on a long backfill.
 */
export async function embedTextWithRetry(
  text: string,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<number[] | null> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vec = await embedText(text);
    if (vec) return vec;
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
    logger.warn({ attempt: attempt + 1, maxAttempts, delayMs: delay }, "legalCorpus embed: retrying after failure");
    await new Promise((r) => setTimeout(r, delay));
  }
  logger.error({ maxAttempts }, "legalCorpus embed: all retry attempts failed");
  return null;
}

/**
 * Embed a batch of texts in a single API call via Gemini's batchEmbedContents.
 * Up to 100 texts per request — drastically fewer HTTP requests than one
 * embedContent call per chunk, which matters because the free-tier rate limit
 * (HTTP 429) is per-request: fewer requests = fewer 429 stalls on long
 * backfills. Returns an array the same length as `texts`; each element is the
 * 3072-dim vector or null if that text failed. Returns null for the whole
 * array on request-level failure so callers can fall back / retry.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[] | null> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) return null;
  if (texts.length === 0) return [];
  // Gemini batchEmbedContents caps at 100 requests per call.
  const batch = texts.slice(0, 100).map((t) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: t.slice(0, 8192) }] },
    taskType: "RETRIEVAL_DOCUMENT",
  }));
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: batch }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, count: batch.length }, "legalCorpus embedBatch: API error");
      return null;
    }
    const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
    const embs = data.embeddings;
    if (!embs?.length) return null;
    return embs.map((e) => (e?.values?.length ? e.values : null));
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus embedBatch: failed");
    return null;
  }
}

/**
 * Batch embed with exponential-backoff retry on transient request-level
 * failure. Returns an array aligned to `texts` (null per failed text), or
 * null if every attempt failed at the request level.
 */
export async function embedBatchWithRetry(
  texts: string[],
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<(number[] | null)[] | null> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const out = await embedBatch(texts);
    if (out) return out;
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
    logger.warn({ attempt: attempt + 1, maxAttempts, delayMs: delay, count: texts.length }, "legalCorpus embedBatch: retrying after failure");
    await new Promise((r) => setTimeout(r, delay));
  }
  logger.error({ maxAttempts, count: texts.length }, "legalCorpus embedBatch: all retry attempts failed");
  return null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export { EMBED_DIM, EMBED_MODEL };
