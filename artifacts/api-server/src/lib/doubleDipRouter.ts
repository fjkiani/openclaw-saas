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
): Promise<SlopAnalysis> {
  const response = await fetch(OPENROUTER_BASE, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": "OpenClaw Manuscript Slop Check",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: SLOP_SYSTEM_PROMPT },
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

  return SlopSchema.parse(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt hash
// ─────────────────────────────────────────────────────────────────────────────

export function hashPrompt(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistToVault(
  promptHash: string,
  promptJson: unknown,
  winner: SlopAnalysis,
  loser: SlopAnalysis,
): Promise<void> {
  await Promise.all([
    pool.query(
      `INSERT INTO zie_training_records
         (task_type, prompt_hash, prompt_json, remote_response_json, quality_score)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prompt_hash) DO NOTHING`,
      [
        "manuscript_slop_check",
        promptHash,
        JSON.stringify(promptJson),
        JSON.stringify(winner),
        winner.confidence.toFixed(4),
      ],
    ),
    pool.query(
      `INSERT INTO zie_preference_pairs
         (task_type, prompt_hash, chosen_response_json, rejected_response_json)
       VALUES ($1, $2, $3, $4)`,
      [
        "manuscript_slop_check",
        promptHash,
        JSON.stringify(winner),
        JSON.stringify(loser),
      ],
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// executeDoubleDip — speculative concurrent execution (INV-02)
// ─────────────────────────────────────────────────────────────────────────────

export async function executeDoubleDip(
  promptJson: unknown,
  promptHash: string,
  taskType = "manuscript_slop_check",
): Promise<SlopAnalysis> {
  const userContent = JSON.stringify(promptJson);

  // Resolve fast-path model from zie_router_policies.
  // After a LoRA fine-tune completes, this returns the trained model ID
  // instead of the base liquid/lfm-2.5-1.2b — the flywheel closes.
  const fastPolicy = await resolveFastPolicy(taskType);
  const fastApiKey = process.env[fastPolicy.fast_api_key_env] ?? process.env.OPENROUTER_API_KEY ?? "";
  const slowApiKey1 = process.env.OPENROUTER_API_KEY ?? "";
  const slowApiKey2 = process.env.OPENROUTER_API_KEY_2 ?? "";

  if (!fastApiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  logger.info(
    { taskType, fastModel: fastPolicy.fast_model_id, promptHash },
    "doubleDipRouter: executing double-dip",
  );

  // AbortController for the slow path.
  // .abort() is called the moment the fast path returns confidence >= 0.85,
  // killing the active TCP connection to OpenRouter.
  const slowAbort = new AbortController();

  // Fast path: model from zie_router_policies (starts as liquid/lfm-2.5-1.2b:free,
  // upgrades to fine-tuned LoRA after first successful training run)
  const fastSignal = AbortSignal.timeout(fastPolicy.fast_timeout_ms);

  const fastPromise: Promise<{ result: SlopAnalysis; won: "fast" } | null> =
    fetchCompletion(fastPolicy.fast_model_id, fastApiKey, userContent, fastPolicy.fast_max_tokens, fastSignal)
      .then((result) => {
        if (result.confidence >= CONFIDENCE_THRESHOLD) {
          // Fast path won — kill the slow path TCP connection immediately
          slowAbort.abort("fast-path-won");
          return { result, won: "fast" as const };
        }
        // Ran but confidence too low — slow path continues
        return null;
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "doubleDipRouter: fast path failed");
        return null;
      });

  // Slow path: openai/gpt-4o (120B proxy) — 45 s timeout, killed by slowAbort
  // AbortSignal.any() combines the 45 s timeout with the manual abort controller,
  // whichever fires first wins and cancels the fetch.
  const slowTimeoutSignal = AbortSignal.timeout(45_000);
  const slowSignal = AbortSignal.any([slowAbort.signal, slowTimeoutSignal]);

  const activeSlowKey = slowApiKey1 || slowApiKey2;
  const slowPromise: Promise<{ result: SlopAnalysis; won: "slow" } | null> =
    fetchCompletion("openai/gpt-4o", activeSlowKey, userContent, 1024, slowSignal)
      .then((result) => ({ result, won: "slow" as const }))
      .catch((err: unknown) => {
        if (
          slowAbort.signal.aborted ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError"))
        ) {
          // Aborted by fast-path win or timeout — not an error
          return null;
        }
        // Try fallback key if primary failed for a non-abort reason
        if (slowApiKey2 && slowApiKey2 !== slowApiKey1) {
          const fallbackSignal = AbortSignal.any([
            slowAbort.signal,
            AbortSignal.timeout(45_000),
          ]);
          return fetchCompletion(
            "openai/gpt-4o",
            slowApiKey2,
            userContent,
            1024,
            fallbackSignal,
          )
            .then((result) => ({ result, won: "slow" as const }))
            .catch((fallbackErr: unknown) => {
              logger.warn(
                { err: fallbackErr },
                "doubleDipRouter: slow path fallback also failed",
              );
              return null;
            });
        }
        logger.warn({ err }, "doubleDipRouter: slow path failed");
        return null;
      });

  // Both paths run concurrently. Promise.all waits for both to settle.
  // We prefer fast if it won; otherwise take slow.
  const [fastOutcome, slowOutcome] = await Promise.all([fastPromise, slowPromise]);

  if (fastOutcome?.won === "fast") {
    logger.info(
      { confidence: fastOutcome.result.confidence, promptHash },
      "doubleDipRouter: fast path won — slow path aborted",
    );
    return fastOutcome.result;
  }

  if (slowOutcome?.won === "slow") {
    const winner = slowOutcome.result;
    const loser: SlopAnalysis =
      fastOutcome === null
        ? {
            severity: "low",
            tag: "facile_analysis",
            evidenceSpans: ["[fast-path-failed]"],
            confidence: 0,
          }
        : {
            severity: fastOutcome.result?.severity ?? "low",
            tag: fastOutcome.result?.tag ?? "facile_analysis",
            evidenceSpans: fastOutcome.result?.evidenceSpans ?? ["[fast-path-low-confidence]"],
            confidence: fastOutcome.result?.confidence ?? 0,
          };

    // Fire-and-forget vault capture — never blocks the HTTP response
    void persistToVault(promptHash, promptJson, winner, loser).catch(
      (err: unknown) => {
        logger.error(
          { err, promptHash },
          "doubleDipRouter: vault persistence failed",
        );
      },
    );

    logger.info(
      { confidence: winner.confidence, promptHash },
      "doubleDipRouter: slow path won — vault capture queued",
    );
    return winner;
  }

  throw new RouterExhaustedError([]);
}
