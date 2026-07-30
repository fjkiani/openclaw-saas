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
