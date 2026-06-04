import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "@workspace/db";
import { RouterExhaustedError } from "./modelRouter.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Policy lookup — reads zie_router_policies to resolve the current fast-path
// model for a given task_type. Falls back to the hardcoded default if the
// table doesn't exist yet or has no row for this task_type.
// After Modal completes a LoRA fine-tune, updateRoutingPolicy() writes here
// and the next invocation automatically uses the trained model.
// ─────────────────────────────────────────────────────────────────────────────

interface FastPathPolicy {
  fast_model_id: string;
  fast_provider: string;
  fast_api_key_env: string;
  fast_max_tokens: number;
  fast_timeout_ms: number;
}

const DEFAULT_FAST_POLICY: FastPathPolicy = {
  fast_model_id: "liquid/lfm-2.5-1.2b-instruct:free",
  fast_provider: "openrouter",
  fast_api_key_env: "OPENROUTER_API_KEY",
  fast_max_tokens: 512,
  fast_timeout_ms: 8_000,
};

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
      return res.rows[0];
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

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_REFERER =
  process.env.OPENROUTER_REFERER ?? "https://openclaw-api-k30t.onrender.com";

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
// Low-level fetch — accepts an AbortSignal directly
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCompletion(
  modelId: string,
  apiKey: string,
  userContent: string,
  maxTokens: number,
  signal: AbortSignal,
  systemPromptOverride?: string,
): Promise<unknown> {
  const response = await fetch(OPENROUTER_BASE, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": "OpenClaw Double-Dip Router",
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
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 200)}`);
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

  // Resolve fast-path model from zie_router_policies.
  const fastPolicy = await resolveFastPolicy(taskType);
  const fastApiKey = process.env[fastPolicy.fast_api_key_env] ?? process.env.OPENROUTER_API_KEY ?? "";
  const slowApiKey1 = process.env.OPENROUTER_API_KEY ?? "";
  const slowApiKey2 = process.env.OPENROUTER_API_KEY_2 ?? "";

  if (!fastApiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  logger.info(
    { taskType, domain, fastModel: fastPolicy.fast_model_id, promptHash },
    "doubleDipRouter: executing double-dip",
  );

  const slowAbort = new AbortController();
  const fastSignal = AbortSignal.timeout(fastPolicy.fast_timeout_ms);

  const fastPromise: Promise<{ result: unknown; confidence: number; won: "fast" } | null> =
    fetchCompletion(fastPolicy.fast_model_id, fastApiKey, userContent, fastPolicy.fast_max_tokens, fastSignal, systemPrompt)
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

  const slowTimeoutSignal = AbortSignal.timeout(45_000);
  const slowSignal = AbortSignal.any([slowAbort.signal, slowTimeoutSignal]);
  const activeSlowKey = slowApiKey1 || slowApiKey2;

  const slowPromise: Promise<{ result: unknown; confidence: number; won: "slow" } | null> =
    fetchCompletion("openai/gpt-4o", activeSlowKey, userContent, 1024, slowSignal, systemPrompt)
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
        if (slowApiKey2 && slowApiKey2 !== slowApiKey1) {
          const fallbackSignal = AbortSignal.any([slowAbort.signal, AbortSignal.timeout(45_000)]);
          return fetchCompletion("openai/gpt-4o", slowApiKey2, userContent, 1024, fallbackSignal, systemPrompt)
            .then((raw) => {
              const parsed = outputSchema.safeParse(raw);
              if (!parsed.success) return null;
              const result = parsed.data as { confidence?: number };
              const confidence = typeof result.confidence === "number" ? result.confidence : 1;
              return { result: parsed.data, confidence, won: "slow" as const };
            })
            .catch((fallbackErr: unknown) => {
              logger.warn({ err: fallbackErr }, "doubleDipRouter: slow path fallback also failed");
              return null;
            });
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
