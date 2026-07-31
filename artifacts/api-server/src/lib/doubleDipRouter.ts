import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "@workspace/db";
import { RouterExhaustedError } from "./modelRouter.js";
import { logger } from "./logger.js";
import { resolveApiKey } from "./resolveApiKey.js";

// ─────────────────────────────────────────────────────────────────────────────
// Provider configuration — Groq (fast) + Gemini (slow)
//
// Replaces the dead OpenRouter keys. Groq provides low-latency inference
// for the fast path. Gemini provides higher-quality reasoning for the
// slow path. Both use the OpenAI-compatible chat completions format.
// ─────────────────────────────────────────────────────────────────────────────

interface FastPathPolicy {
  fast_model_id: string;
  fast_provider: string;
  fast_api_key_env: string;
  fast_max_tokens: number;
  fast_timeout_ms: number;
}

const DEFAULT_FAST_POLICY: FastPathPolicy = {
  fast_model_id: "llama-3.3-70b-versatile",
  fast_provider: "groq",
  fast_api_key_env: "GROQ_API_KEY",
  fast_max_tokens: 512,
  fast_timeout_ms: 8_000,
};

const SLOW_MODEL_ID = "gemini-2.5-flash";
const SLOW_API_KEY_ENV = "GOOGLE_API_KEY";
const SLOW_MAX_TOKENS = 1024;
const SLOW_TIMEOUT_MS = 45_000;

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_OPENAI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

async function resolveFastPolicy(taskType: string): Promise<FastPathPolicy> {
  try {
    const res = await pool.query<FastPathPolicy>(
      `SELECT fast_model_id, fast_provider, fast_api_key_env, fast_max_tokens, fast_timeout_ms
       FROM zie_router_policies
       WHERE task_type = $1
       LIMIT 1`,
      [taskType],
    );
    if (res.rows.length > 0) {
      // Override the default with DB-stored policy, but ensure the provider
      // is groq or gemini (not openrouter, which is dead).
      const policy = res.rows[0];
      if (policy.fast_provider === "openrouter") {
        logger.warn(
          { taskType, storedProvider: "openrouter" },
          "doubleDipRouter: DB policy references dead openrouter provider — using groq default",
        );
        return DEFAULT_FAST_POLICY;
      }
      return policy;
    }
  } catch {
    // Table may not exist yet — fall through to default
  }
  return DEFAULT_FAST_POLICY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Whip (INV-03)
// ─────────────────────────────────────────────────────────────────────────────

export const SlopSchema = z
  .object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    tag: z.enum(["overclaiming", "facile_analysis", "thin_methods"]),
    evidenceSpans: z
      .array(z.string().min(1))
      .min(1, "Must cite at least one verbatim evidence span"),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((data, ctx) => {
    if (
      (data.severity === "high" || data.severity === "critical") &&
      data.evidenceSpans.length < 2
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.severity} severity requires >= 2 evidence spans; got ${data.evidenceSpans.length}.`,
        path: ["evidenceSpans"],
      });
    }
  });

export type SlopAnalysis = z.infer<typeof SlopSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.85;

const SLOP_SYSTEM_PROMPT = `You are a manuscript quality auditor. Analyze the provided text for scientific writing deficiencies.

Return a JSON object with EXACTLY these fields and no others:
{
  "severity": "low" | "medium" | "high" | "critical",
  "tag": "overclaiming" | "facile_analysis" | "thin_methods",
  "evidenceSpans": ["exact verbatim quote from the input text"],
  "confidence": 0.0 to 1.0
}

Hard rules:
- evidenceSpans MUST be verbatim quotes from the input. Paraphrasing is rejected.
- high or critical severity MUST have at least 2 evidence spans.
- confidence is your certainty this is the dominant deficiency (0=uncertain, 1=certain).
- Respond with valid JSON only. No markdown fences, no prose.`;

// ─────────────────────────────────────────────────────────────────────────────
// Low-level fetch — provider-agnostic OpenAI-compatible completions
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCompletion(
  endpoint: string,
  modelId: string,
  apiKey: string,
  userContent: string,
  maxTokens: number,
  signal: AbortSignal,
  systemPromptOverride?: string,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPromptOverride ?? SLOP_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${endpoint} ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`JSON parse failed: ${raw.slice(0, 120)}`);
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt hash
// ─────────────────────────────────────────────────────────────────────────────

export function hashPrompt(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault options — passed through from domain-specific callers
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultOptions {
  domain?: string;
  sourceKind?: string;
  preferenceSource?: string;
  systemPrompt?: string;
  /** Zod schema to validate model output. Defaults to SlopSchema. */
  outputSchema?: z.ZodTypeAny;
  /** Confidence threshold override. Defaults to CONFIDENCE_THRESHOLD (0.85). */
  confidenceThreshold?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistToVault(
  taskType: string,
  promptHash: string,
  promptJson: unknown,
  winner: unknown,
  loser: unknown,
  opts: Required<Pick<VaultOptions, "domain" | "sourceKind" | "preferenceSource">>,
  qualityScore: number,
): Promise<void> {
  await Promise.all([
    pool.query(
      `INSERT INTO zie_training_records
         (task_type, domain, source_kind, prompt_hash, prompt_json, remote_response_json, quality_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (prompt_hash) DO NOTHING`,
      [
        taskType,
        opts.domain,
        opts.sourceKind,
        promptHash,
        JSON.stringify(promptJson),
        JSON.stringify(winner),
        qualityScore.toFixed(4),
      ],
    ),
    pool.query(
      `INSERT INTO zie_preference_pairs
         (task_type, domain, source_kind, preference_source, prompt_hash, chosen_response_json, rejected_response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        taskType,
        opts.domain,
        opts.sourceKind,
        opts.preferenceSource,
        promptHash,
        JSON.stringify(winner),
        JSON.stringify(loser),
      ],
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// DoubleDipResult — returned to all callers
// ─────────────────────────────────────────────────────────────────────────────

export interface DoubleDipResult {
  analysis: unknown;
  path_taken: "fast" | "slow";
}

// ─────────────────────────────────────────────────────────────────────────────
// executeDoubleDip — speculative concurrent execution (INV-02)
//
// Fast path: Groq (llama-3.3-70b-versatile) — low latency, 8s timeout.
// Slow path: Gemini (gemini-2.5-flash) — higher quality, 45s timeout.
// If fast path confidence >= threshold, slow path is aborted.
// Otherwise slow path result is persisted to the vault as a DPO pair.
// ─────────────────────────────────────────────────────────────────────────────

export async function executeDoubleDip(
  promptJson: unknown,
  promptHash: string,
  taskType = "manuscript_slop_check",
  vaultOpts: VaultOptions = {},
): Promise<DoubleDipResult> {
  const userContent = JSON.stringify(promptJson);
  const domain = vaultOpts.domain ?? "manuscript";
  const sourceKind = vaultOpts.sourceKind ?? "direct_call";
  const preferenceSource = vaultOpts.preferenceSource ?? "path_race";
  const systemPrompt = vaultOpts.systemPrompt;
  const outputSchema: z.ZodTypeAny = vaultOpts.outputSchema ?? SlopSchema;
  const confidenceThreshold = vaultOpts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;

  // Resolve fast-path model from zie_router_policies (or default to Groq).
  const fastPolicy = await resolveFastPolicy(taskType);
  const fastApiKey = resolveApiKey(fastPolicy.fast_api_key_env);
  const slowApiKey = resolveApiKey(SLOW_API_KEY_ENV);

  // Determine fast-path endpoint based on provider
  const fastEndpoint = fastPolicy.fast_provider === "groq"
    ? GROQ_ENDPOINT
    : GEMINI_OPENAI_ENDPOINT;

  if (!fastApiKey) {
    throw new Error(`${fastPolicy.fast_api_key_env} is not set — cannot run fast path`);
  }

  logger.info(
    { taskType, domain, fastModel: fastPolicy.fast_model_id, fastProvider: fastPolicy.fast_provider, slowModel: SLOW_MODEL_ID, promptHash },
    "doubleDipRouter: executing double-dip",
  );

  const slowAbort = new AbortController();
  const fastSignal = AbortSignal.timeout(fastPolicy.fast_timeout_ms);

  const fastPromise: Promise<{ result: unknown; confidence: number; won: "fast" } | null> =
    fetchCompletion(fastEndpoint, fastPolicy.fast_model_id, fastApiKey, userContent, fastPolicy.fast_max_tokens, fastSignal, systemPrompt)
      .then((raw) => {
        const parsed = outputSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ issues: parsed.error.issues }, "doubleDipRouter: fast path schema invalid");
          return null;
        }
        const result = parsed.data as { confidence?: number };
        const confidence = typeof result.confidence === "number" ? result.confidence : 0;
        if (confidence >= confidenceThreshold) {
          slowAbort.abort("fast-path-won");
          return { result: parsed.data, confidence, won: "fast" as const };
        }
        return null;
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "doubleDipRouter: fast path failed");
        return null;
      });

  const slowTimeoutSignal = AbortSignal.timeout(SLOW_TIMEOUT_MS);
  const slowSignal = AbortSignal.any([slowAbort.signal, slowTimeoutSignal]);

  const slowPromise: Promise<{ result: unknown; confidence: number; won: "slow" } | null> =
    fetchCompletion(GEMINI_OPENAI_ENDPOINT, SLOW_MODEL_ID, slowApiKey, userContent, SLOW_MAX_TOKENS, slowSignal, systemPrompt)
      .then((raw) => {
        const parsed = outputSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ issues: parsed.error.issues }, "doubleDipRouter: slow path schema invalid");
          return null;
        }
        const result = parsed.data as { confidence?: number };
        const confidence = typeof result.confidence === "number" ? result.confidence : 1;
        return { result: parsed.data, confidence, won: "slow" as const };
      })
      .catch((err: unknown) => {
        if (
          slowAbort.signal.aborted ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError"))
        ) {
          return null;
        }
        logger.warn({ err }, "doubleDipRouter: slow path failed");
        return null;
      });

  const [fastOutcome, slowOutcome] = await Promise.all([fastPromise, slowPromise]);

  if (fastOutcome?.won === "fast") {
    logger.info(
      { confidence: fastOutcome.confidence, promptHash },
      "doubleDipRouter: fast path won — slow path aborted",
    );
    return { analysis: fastOutcome.result, path_taken: "fast" };
  }

  if (slowOutcome?.won === "slow") {
    const winner = slowOutcome.result;
    const loser = fastOutcome === null
      ? { severity: "low", tag: "facile_analysis", evidenceSpans: ["[fast-path-failed]"], confidence: 0 }
      : fastOutcome.result;

    void persistToVault(
      taskType,
      promptHash,
      promptJson,
      winner,
      loser,
      { domain, sourceKind, preferenceSource },
      slowOutcome.confidence,
    ).catch((err: unknown) => {
      logger.error({ err, promptHash }, "doubleDipRouter: vault persistence failed");
    });

    logger.info(
      { confidence: slowOutcome.confidence, promptHash },
      "doubleDipRouter: slow path won — vault capture queued",
    );
    return { analysis: winner, path_taken: "slow" };
  }

  throw new RouterExhaustedError([]);
}
