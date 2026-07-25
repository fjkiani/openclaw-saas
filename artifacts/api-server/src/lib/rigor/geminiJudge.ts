/**
 * geminiJudge.ts — direct Google Gemini client for the rigor executor + judges.
 *
 * Why a direct path (not OpenRouter): the OpenRouter free tier has a hard
 * per-day cap (free-models-per-day) and this account has zero paid credits, so
 * once the cap is hit EVERY nvidia model 429s until reset — the executor AND the
 * judge chain both die. Google's Generative Language API is an INDEPENDENT
 * rate-limit bucket AND (for the judge) an independent model family. Using
 * Gemini as PRIMARY for both the executor and the rubric judge (nvidia as
 * fallback) lets the pipeline actually run live under OpenRouter exhaustion.
 *
 * responseMimeType:"application/json" makes Gemini emit clean JSON (its internal
 * "thoughts" tokens are billed separately and never pollute the returned text),
 * which sidesteps the reasoning-model empty-content problem — PROVIDED the
 * maxOutputTokens budget covers thoughts + JSON (2.5-flash spends ~1000-1700
 * thought tokens, so a small budget truncates mid-JSON → default 4000).
 *
 * Transient resilience: Gemini returns 503 ("high demand, try again later") and
 * 429 ("quota") under sustained load. geminiFetch retries those with exponential
 * backoff + jitter before giving up, so a brief spike doesn't force a dry
 * fallback. Non-transient statuses (400/403/404) fail fast.
 */

import { resolveApiKey } from "../resolveApiKey.js";
import { logger } from "../logger.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Default judge model. gemini-2.5-flash: fast (~3-4s), cheap, strong JSON.
const GEMINI_JUDGE_MODEL = (process.env.RIGOR_GEMINI_JUDGE_MODEL || "gemini-2.5-flash").trim();
// Executor model (used when OpenRouter's daily free cap blocks the nvidia chain).
const GEMINI_EXEC_MODEL = (process.env.RIGOR_GEMINI_EXEC_MODEL || "gemini-2.5-flash").trim();

// Tier → Gemini executor model. Uses GENUINELY DISTINCT models so the swap
// escalation (fast→balanced→max) traverses real different models, not the same
// one relabeled. Only models verified callable on this key are used (2.5-pro and
// the 2.0 family are currently 429/RESOURCE_EXHAUSTED on the free quota).
const GEMINI_TIER_EXEC: Record<string, string> = {
  fast: "gemini-2.5-flash-lite",
  balanced: "gemini-2.5-flash",
  max: "gemini-flash-lite-latest",
  frontier: "gemini-2.5-flash",
};

export function geminiExecModelForTier(tier?: string): string {
  if (tier && GEMINI_TIER_EXEC[tier]) return GEMINI_TIER_EXEC[tier];
  return GEMINI_EXEC_MODEL;
}

// Gemini has PER-MINUTE (RPM) free-tier limits that 429 under bursts but recover
// in seconds — and each model has its OWN bucket. So when one model 429s we try
// the next Gemini model before dropping to the nvidia chain. Verified-callable
// models only (2.5-pro and 2.0 family are RESOURCE_EXHAUSTED on this key).
const GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-lite-latest"];

// Judge fallback order: put a given primary first, then the rest (deduped).
function judgeModelChain(primary: string): string[] {
  return [primary, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== primary)];
}

export function geminiKey(): string | null {
  return (
    resolveApiKey("GOOGLE_API_KEY") ||
    resolveApiKey("GEMINI_API_KEY") ||
    (process.env.GOOGLE_API_KEY || "").trim() ||
    (process.env.GEMINI_API_KEY || "").trim() ||
    null
  );
}

export function geminiJudgeAvailable(): boolean {
  return Boolean(geminiKey());
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

/**
 * POST to a Gemini model with bounded retry-with-backoff on transient (429/5xx)
 * statuses. Returns the concatenated text of candidate[0]. Throws on
 * non-transient HTTP error, exhausted retries, or empty output.
 */
async function geminiFetch(
  model: string,
  systemPrompt: string,
  userContent: string,
  generationConfig: Record<string, unknown>,
  timeoutMs: number,
  retry: { max: number; baseMs: number },
): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error("no Gemini key");
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n---\n\n${userContent}` }] }],
    generationConfig,
  });
  let lastErr = "";
  for (let attempt = 0; attempt <= retry.max; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (netErr) {
      // network/timeout — treat as transient
      lastErr = `network: ${String(netErr).slice(0, 120)}`;
      if (attempt < retry.max) {
        const delay = retry.baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
        logger.warn({ model, attempt, delay, err: lastErr }, "[gemini] transient network — backing off");
        await sleep(delay);
        continue;
      }
      throw new Error(`gemini ${lastErr}`);
    }
    if (resp.ok) {
      const data = (await resp.json()) as { candidates?: GeminiCandidate[] };
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error(`gemini empty output (finishReason=${cand?.finishReason ?? "?"})`);
      return text;
    }
    const t = await resp.text().catch(() => "");
    lastErr = `${resp.status}: ${t.slice(0, 140)}`;
    if (TRANSIENT.has(resp.status) && attempt < retry.max) {
      const delay = retry.baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn({ model, attempt, delay, status: resp.status }, "[gemini] transient — backing off");
      await sleep(delay);
      continue;
    }
    // non-transient, or retries exhausted
    throw new Error(`gemini ${lastErr}`);
  }
  throw new Error(`gemini exhausted: ${lastErr}`);
}

export interface GeminiJudgeResult<T> {
  parsed: T;
  model_used: string;
  raw: string;
}

/**
 * Call Gemini expecting JSON, validate it. Throws on HTTP error, empty output,
 * unparseable JSON, or validator rejection so callers can fall back cleanly.
 */
export async function geminiJudge<T>(
  systemPrompt: string,
  userContent: string,
  validate: (parsed: unknown) => T,
  opts: { maxOutputTokens?: number; temperature?: number; timeoutMs?: number; model?: string; retry?: { max: number; baseMs: number } } = {},
): Promise<GeminiJudgeResult<T>> {
  const chain = judgeModelChain((opts.model || GEMINI_JUDGE_MODEL).trim());
  let lastErr: unknown;
  for (const model of chain) {
    try {
      const text = await geminiFetch(
        model,
        systemPrompt,
        userContent,
        {
          temperature: opts.temperature ?? 0,
          maxOutputTokens: opts.maxOutputTokens ?? 4000,
          responseMimeType: "application/json",
        },
        opts.timeoutMs ?? 40_000,
        opts.retry ?? { max: 2, baseMs: 800 },
      );
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        parsedJson = JSON.parse(cleaned);
      }
      const parsed = validate(parsedJson);
      return { parsed, model_used: `google/${model}`, raw: text };
    } catch (err) {
      lastErr = err;
      logger.warn({ model, err: String(err) }, "[gemini] judge model failed — trying next Gemini model");
    }
  }
  throw new Error(`gemini judge chain exhausted: ${String(lastErr)}`);
}

/**
 * Raw Gemini generation for the EXECUTOR path (returns text without schema
 * validation so the orchestrator's tolerant envelope parser handles it).
 */
export async function geminiGenerate(
  systemPrompt: string,
  userContent: string,
  opts: { maxOutputTokens?: number; temperature?: number; timeoutMs?: number; model?: string; json?: boolean; retry?: { max: number; baseMs: number } } = {},
): Promise<{ raw: string; model_used: string }> {
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxOutputTokens ?? 4000,
  };
  if (opts.json !== false) generationConfig.responseMimeType = "application/json";
  // Try the requested (tier) model first, then the other Gemini models (separate
  // RPM buckets) before the caller falls back to the OpenRouter chain.
  const chain = judgeModelChain((opts.model || GEMINI_EXEC_MODEL).trim());
  let lastErr: unknown;
  for (const model of chain) {
    try {
      const raw = await geminiFetch(
        model,
        systemPrompt,
        userContent,
        generationConfig,
        opts.timeoutMs ?? 45_000,
        opts.retry ?? { max: 2, baseMs: 800 },
      );
      return { raw, model_used: `google/${model}` };
    } catch (err) {
      lastErr = err;
      logger.warn({ model, err: String(err) }, "[gemini] exec model failed — trying next Gemini model");
    }
  }
  throw new Error(`gemini exec chain exhausted: ${String(lastErr)}`);
}
