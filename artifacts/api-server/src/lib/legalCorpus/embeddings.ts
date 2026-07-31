/**
 * Text embeddings for hybrid legal RAG — provider-pluggable.
 *
 * Backend is selected by env (first match wins):
 *   LEGAL_EMBED_PROVIDER = "cohere" | "gemini"   (explicit override)
 *   else COHERE_API_KEY set  -> Cohere
 *   else GOOGLE_API_KEY set  -> Gemini
 *
 * Cohere (default when a key is present):
 *   model  LEGAL_EMBED_MODEL ?? "embed-english-v3.0"  (1024-dim)
 *   endpoint POST https://api.cohere.ai/v1/embed  (up to 96 texts/request)
 *   Free/trial keys have workable rate limits; batches of 96 embed in ~0.25s.
 *
 * Gemini (fallback):
 *   model  LEGAL_EMBED_MODEL ?? "gemini-embedding-001"  (3072-dim)
 *   Free tier is capped at 1,000 embed requests/day (HTTP 429 when exhausted).
 *
 * The vector dimension MUST match the Qdrant collection. Set LEGAL_EMBED_DIM
 * (and recreate the collection) when switching providers — see qdrantClient.
 */

import { resolveApiKey } from "../resolveApiKey.js";
import { logger } from "../logger.js";

type EmbedProvider = "cohere" | "gemini";

function selectProvider(): EmbedProvider {
  const explicit = process.env.LEGAL_EMBED_PROVIDER?.trim().toLowerCase();
  if (explicit === "cohere" || explicit === "gemini") return explicit;
  if (resolveApiKey("COHERE_API_KEY")) return "cohere";
  return "gemini";
}

const PROVIDER: EmbedProvider = selectProvider();

const COHERE_MODEL = process.env.LEGAL_EMBED_MODEL ?? "embed-english-v3.0";
const GEMINI_MODEL = process.env.LEGAL_EMBED_MODEL ?? "gemini-embedding-001";

/** Active model name (informational). */
export const EMBED_MODEL = PROVIDER === "cohere" ? COHERE_MODEL : GEMINI_MODEL;
/** Output dimension of the active provider. */
export const EMBED_DIM = PROVIDER === "cohere" ? 1024 : 3072;
/** Max texts per batch request for the active provider. */
const BATCH_CAP = PROVIDER === "cohere" ? 96 : 100;

// ── Cohere ────────────────────────────────────────────────────────────────────

async function cohereEmbedBatch(texts: string[], inputType: "search_document" | "search_query"): Promise<(number[] | null)[] | null> {
  const apiKey = resolveApiKey("COHERE_API_KEY");
  if (!apiKey) return null;
  if (texts.length === 0) return [];
  try {
    const res = await fetch("https://api.cohere.ai/v1/embed", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        texts: texts.map((t) => t.slice(0, 8192)),
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, count: texts.length, body: body.slice(0, 200) }, "legalCorpus cohereEmbed: API error");
      return null;
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    const embs = data.embeddings;
    if (!embs?.length) return null;
    return embs.map((e) => (e?.length ? e : null));
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus cohereEmbed: failed");
    return null;
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function geminiEmbedOne(text: string): Promise<number[] | null> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) return null;
  const input = text.slice(0, 8192);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text: input }] },
          taskType: "RETRIEVAL_DOCUMENT",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "legalCorpus geminiEmbed: API error");
      return null;
    }
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const vec = data.embedding?.values;
    return vec?.length ? vec : null;
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus geminiEmbed: failed");
    return null;
  }
}

async function geminiEmbedBatch(texts: string[]): Promise<(number[] | null)[] | null> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) return null;
  if (texts.length === 0) return [];
  const batch = texts.slice(0, 100).map((t) => ({
    model: `models/${GEMINI_MODEL}`,
    content: { parts: [{ text: t.slice(0, 8192) }] },
    taskType: "RETRIEVAL_DOCUMENT",
  }));
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: batch }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, count: batch.length }, "legalCorpus geminiEmbedBatch: API error");
      return null;
    }
    const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
    const embs = data.embeddings;
    if (!embs?.length) return null;
    return embs.map((e) => (e?.values?.length ? e.values : null));
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpus geminiEmbedBatch: failed");
    return null;
  }
}

// ── Public API (provider-agnostic) ────────────────────────────────────────────

/**
 * Embed a single text. Returns the vector or null on failure.
 * For Cohere this is a 1-text batch; for Gemini a single embedContent call.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (PROVIDER === "cohere") {
    const out = await cohereEmbedBatch([text], "search_document");
    return out?.[0] ?? null;
  }
  return geminiEmbedOne(text);
}

/**
 * Embed with exponential-backoff retry on transient failures. Returns null
 * only after all attempts fail, so callers can distinguish "permanently
 * failed" from "transiently rate-limited" and keep making progress.
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
    logger.warn({ attempt: attempt + 1, maxAttempts, delayMs: delay, provider: PROVIDER }, "legalCorpus embed: retrying after failure");
    await new Promise((r) => setTimeout(r, delay));
  }
  logger.error({ maxAttempts, provider: PROVIDER }, "legalCorpus embed: all retry attempts failed");
  return null;
}

/**
 * Embed a batch of texts in a single API request (provider-native batching).
 * Returns an array aligned to `texts` (null per failed text), or null if the
 * request itself failed. Cohere caps at 96 texts/request; Gemini at 100.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[] | null> {
  if (texts.length === 0) return [];
  const slice = texts.slice(0, BATCH_CAP);
  if (PROVIDER === "cohere") {
    return cohereEmbedBatch(slice, "search_document");
  }
  return geminiEmbedBatch(slice);
}

/**
 * Batch embed with exponential-backoff retry on request-level failure.
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
    logger.warn({ attempt: attempt + 1, maxAttempts, delayMs: delay, count: texts.length, provider: PROVIDER }, "legalCorpus embedBatch: retrying after failure");
    await new Promise((r) => setTimeout(r, delay));
  }
  logger.error({ maxAttempts, count: texts.length, provider: PROVIDER }, "legalCorpus embedBatch: all retry attempts failed");
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

export { EMBED_DIM as EMBED_DIMENSION };
