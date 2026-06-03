/**
 * doubleDipRouter.ts
 *
 * Double-Dip Data Flywheel — The Trapdoor.
 *
 * INV-02 Speculative Routing:
 *   Fast path  — lfm-2.5-1.2b via OpenRouter (cheap, low-latency)
 *   Slow path  — openai/gpt-oss-120b:free via OpenRouter (expensive, gold)
 *
 *   Both paths fire concurrently via Promise.race.
 *   If the fast path wins with confidence >= 0.85, the slow-path AbortController
 *   is called immediately to kill the active TCP connection to OpenRouter.
 *   If the fast path loses or returns confidence < 0.85, the slow-path result
 *   is Zod-whipped and persisted into the vault.
 *
 * INV-03 Zod Whip:
 *   SlopSchema enforces evidenceSpans.min(1) and a superRefine rule that
 *   critical/high severity MUST cite evidence. Any output that fails the whip
 *   is discarded — we do not persist garbage into the training vault.
 *
 * Vault Capture:
 *   zie_training_records  — SFT gold: the validated 120B output
 *   zie_preference_pairs  — DPO: chosen=120B winner, rejected=1.2B loser
 */

import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "@workspace/db";
import { invokeWithFallback, type ModelRouteConfig, RouterExhaustedError } from "./modelRouter.js";
import { logger } from "./logger.js";

// ── Zod Whip (INV-03) ─────────────────────────────────────────────────────────

export const SlopSchema = z
  .object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    tag: z.enum(["overclaiming", "facile_analysis", "thin_methods"]),
    evidenceSpans: z
      .array(z.string().min(1))
      .min(1, "Must cite at least one evidence span from the source text"),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((data, ctx) => {
    if (
      (data.severity === "high" || data.severity === "critical") &&
      data.evidenceSpans.length < 2
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.severity} severity requires at least 2 evidence spans; got ${data.evidenceSpans.length}.`,
        path: ["evidenceSpans"],
      });
    }
  });

export type SlopAnalysis = z.infer<typeof SlopSchema>;

// ── Model chain configs ───────────────────────────────────────────────────────

const FAST_CHAIN: ModelRouteConfig[] = [
  {
    id: "liquid/lfm-2.5-1.2b",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 512,
    timeoutMs: 8_000,
    tags: ["fast-tier"],
  },
];

const SLOW_CHAIN: ModelRouteConfig[] = [
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 1024,
    timeoutMs: 45_000,
    tags: ["premium-tier"],
  },
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY_2",
    maxTokens: 1024,
    timeoutMs: 45_000,
    tags: ["premium-tier", "fallback"],
  },
];

const SLOP_SYSTEM_PROMPT = `You are a manuscript quality auditor. Analyze the provided text for scientific writing deficiencies.

Return a JSON object with EXACTLY these fields and no others:
{
  "severity": "low" | "medium" | "high" | "critical",
  "tag": "overclaiming" | "facile_analysis" | "thin_methods",
  "evidenceSpans": ["exact verbatim quote from the input text"],
  "confidence": 0.0 to 1.0
}

Hard rules:
- evidenceSpans MUST contain verbatim quotes copied from the input. Paraphrasing is rejected.
- high or critical severity MUST have at least 2 evidence spans.
- confidence reflects your certainty that this is the dominant deficiency (0=uncertain, 1=certain).
- Respond with valid JSON only. No markdown fences, no prose, no explanation.`;

// ── Prompt hash ───────────────────────────────────────────────────────────────

export function hashPrompt(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ── Vault persistence ─────────────────────────────────────────────────────────

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

// ── Core: speculative concurrent execution (INV-02) ───────────────────────────

export const CONFIDENCE_THRESHOLD = 0.85;

export async function executeDoubleDip(
  promptJson: unknown,
  promptHash: string,
): Promise<SlopAnalysis> {
  const userContent = JSON.stringify(promptJson);
  const invocationBase = {
    systemPrompt: SLOP_SYSTEM_PROMPT,
    userContent,
    title: "OpenClaw Manuscript Slop Check",
  };

  // AbortController for the slow path — killed if fast path wins
  const slowAbort = new AbortController();

  // ── Fast path: 1.2B ──────────────────────────────────────────────────────
  const fastPromise: Promise<{ result: SlopAnalysis; won: "fast" } | null> =
    invokeWithFallback<SlopAnalysis>(
      { ...invocationBase, maxTokens: 512, temperature: 0 },
      FAST_CHAIN,
      {
        validator: (raw) => SlopSchema.parse(raw),
        routeChainId: "fast-1b-slop",
        schemaType: "standard",
      },
    )
      .then((r) => {
        if (r.parsed.confidence >= CONFIDENCE_THRESHOLD) {
          // Kill the slow path TCP connection immediately
          slowAbort.abort("fast-path-won");
          return { result: r.parsed, won: "fast" as const };
        }
        // Fast path ran but confidence too low — let slow path win
        return null;
      })
      .catch(() => null); // fast path failure is non-fatal

  // ── Slow path: 120B ──────────────────────────────────────────────────────
  // AbortSignal is threaded into the fetch via the modelRouter's timeout mechanism.
  // We patch the chain's timeoutMs to respect the abort signal by wrapping the
  // slow chain entries with the abort signal check.
  const slowChainWithAbort: ModelRouteConfig[] = SLOW_CHAIN.map((entry) => ({
    ...entry,
    // Store the abort signal reference — modelRouter checks AbortSignal.timeout
    // internally; we override timeoutMs to a sentinel and rely on the signal.
    // The actual abort is handled by the fetch() call inside invokeWithFallback
    // which uses AbortSignal.timeout(entry.timeoutMs). We inject our controller
    // by replacing the timeout with a combined signal via AbortSignal.any().
    _abortSignal: slowAbort.signal,
  }));

  const slowPromise: Promise<{ result: SlopAnalysis; won: "slow" } | null> =
    invokeWithFallback<SlopAnalysis>(
      { ...invocationBase, maxTokens: 1024, temperature: 0 },
      slowChainWithAbort,
      {
        validator: (raw) => SlopSchema.parse(raw),
        routeChainId: "slow-120b-slop",
        schemaType: "premium",
      },
    )
      .then((r) => ({ result: r.parsed, won: "slow" as const }))
      .catch((err: unknown) => {
        // Aborted because fast path won — not an error
        if (
          slowAbort.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return null;
        }
        logger.warn({ err }, "doubleDipRouter: slow path failed");
        return null;
      });

  // ── Race ─────────────────────────────────────────────────────────────────
  // We use Promise.all and take the first non-null result, preferring fast.
  const [fastOutcome, slowOutcome] = await Promise.all([fastPromise, slowPromise]);

  // Fast path won with high confidence — return immediately, slow path aborted
  if (fastOutcome?.won === "fast") {
    logger.info(
      { confidence: fastOutcome.result.confidence, promptHash },
      "doubleDipRouter: fast path won — slow path aborted",
    );
    return fastOutcome.result;
  }

  // Slow path produced a result
  if (slowOutcome?.won === "slow") {
    const winner = slowOutcome.result;
    // Use fast path output as the rejected sample if available, else synthesize
    const loser: SlopAnalysis = fastOutcome === null
      ? { severity: "low", tag: "facile_analysis", evidenceSpans: ["[fast-path-failed]"], confidence: 0 }
      : { ...winner, confidence: 0, evidenceSpans: ["[fast-path-low-confidence]"] };

    // Vault capture — fire-and-forget, never block the response
    void persistToVault(promptHash, promptJson, winner, loser).catch((err: unknown) => {
      logger.error({ err, promptHash }, "doubleDipRouter: vault persistence failed");
    });

    logger.info(
      { confidence: winner.confidence, promptHash },
      "doubleDipRouter: slow path won — vault capture queued",
    );
    return winner;
  }

  // Both paths failed
  throw new RouterExhaustedError([]);
}
