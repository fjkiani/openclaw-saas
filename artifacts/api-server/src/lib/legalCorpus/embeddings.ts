/**
 * OpenRouter-compatible text embeddings for hybrid legal RAG.
 */

import { resolveApiKey } from "../resolveApiKey.js";
import { logger } from "../logger.js";

const EMBED_MODEL =
  process.env.LEGAL_EMBED_MODEL ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free";
/** Nemotron Embed VL 1B V2 outputs 2048-dim vectors. */
const EMBED_DIM = 2048;

export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = resolveApiKey("OPENROUTER_API_KEY");
  if (!apiKey) return null;

  const input = text.slice(0, 8192);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://openclaw-api-k30t.onrender.com",
        "X-Title": "OpenClaw Legal RAG Embed",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "legalCorpus embed: API error");
      return null;
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = data.data?.[0]?.embedding;
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
