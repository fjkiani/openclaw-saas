/**
 * doubleDipRouter.ts
 *
 * Double-Dip Data Flywheel — The Trapdoor.
 *
 * Dip 1: Run local 1.2B model (cheap). If confidence >= 0.85, return immediately.
 * Dip 2: Route to 120B via OpenRouter (expensive). Zod-whip the output.
 *        Asynchronously persist:
 *          - zie_training_records  (SFT gold: the 120B output)
 *          - zie_preference_pairs  (DPO: chosen=120B, rejected=local)
 *        Return the validated 120B result to the caller.
 */

import { z } from "zod";
import { pool } from "@workspace/db";
import { invokeWithFallback, type ModelRouteConfig } from "./modelRouter.js";
import { logger } from "./logger.js";

// ── Zod Whip ──────────────────────────────────────────────────────────────────
// If the 120B output doesn't cite evidence spans, it fails and we don't persist it.

export const SlopSchema = z
  .object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    tag: z.enum(["overclaiming", "facile_analysis", "thin_methods"]),
    evidenceSpans: z.array(z.string()).min(1, "Must cite at least one evidence span"),
  })
  .superRefine((data, ctx) => {
    if (
      ["high", "critical"].includes(data.severity) &&
      data.evidenceSpans.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Critical slop MUST cite evidence.",
        path: ["evidenceSpans"],
      });
    }
  });

export type SlopAnalysis = z.infer<typeof SlopSchema>;

// ── Local model result shape ──────────────────────────────────────────────────

export interface LocalModelResult {
  data: SlopAnalysis;
  confidence: number; // 0.0 – 1.0
}

// ── Model chain configs ───────────────────────────────────────────────────────

const LOCAL_1B_CHAIN: ModelRouteConfig[] = [
  {
    id: "meta-llama/llama-3.2-1b-instruct",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 512,
    timeoutMs: 10_000,
    tags: ["local-tier"],
  },
];

const PREMIUM_120B_CHAIN: ModelRouteConfig[] = [
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 1024,
    timeoutMs: 30_000,
    tags: ["premium-tier"],
  },
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY_2",
    maxTokens: 1024,
    timeoutMs: 30_000,
    tags: ["premium-tier", "fallback"],
  },
];

const SLOP_SYSTEM_PROMPT = `You are a manuscript quality auditor. Analyze the provided text for scientific writing deficiencies.

Return a JSON object with exactly these fields:
{
  "severity": "low" | "medium" | "high" | "critical",
  "tag": "overclaiming" | "facile_analysis" | "thin_methods",
  "evidenceSpans": ["exact quoted text from the manuscript that supports your finding"]
}

Rules:
- evidenceSpans MUST contain at least one direct quote from the input text.
- For high or critical severity, you MUST provide multiple evidence spans.
- Do not add any fields beyond the three specified.
- Respond with JSON only. No prose, no markdown.`;

// ── Local model runner ────────────────────────────────────────────────────────

async function runLocalModel(promptJson: unknown): Promise<LocalModelResult> {
  try {
    const result = await invokeWithFallback<SlopAnalysis>(
      {
        systemPrompt: SLOP_SYSTEM_PROMPT,
        userContent: JSON.stringify(promptJson),
        title: "OpenClaw Slop Check (local)",
        maxTokens: 512,
        temperature: 0,
      },
      LOCAL_1B_CHAIN,
      {
        validator: (raw) => SlopSchema.parse(raw),
        routeChainId: "local-1b-slop",
        schemaType: "standard",
      },
    );
    // Confidence heuristic: low-severity findings from small model are less reliable
    const confidenceMap: Record<string, number> = {
      low: 0.92,
      medium: 0.80,
      high: 0.65,
      critical: 0.55,
    };
    return {
      data: result.parsed,
      confidence: confidenceMap[result.parsed.severity] ?? 0.70,
    };
  } catch {
    // Local model failed entirely — confidence 0 forces premium escalation
    return {
      data: { severity: "low", tag: "facile_analysis", evidenceSpans: [] },
      confidence: 0,
    };
  }
}

// ── Premium 120B runner ───────────────────────────────────────────────────────

async function runOpenRouter120B(promptJson: unknown): Promise<SlopAnalysis> {
  const result = await invokeWithFallback<SlopAnalysis>(
    {
      systemPrompt: SLOP_SYSTEM_PROMPT,
      userContent: JSON.stringify(promptJson),
      title: "OpenClaw Slop Check (premium)",
      maxTokens: 1024,
      temperature: 0,
    },
    PREMIUM_120B_CHAIN,
    {
      validator: (raw) => SlopSchema.parse(raw),
      routeChainId: "premium-120b-slop",
      schemaType: "premium",
    },
  );
  return result.parsed;
}

// ── Async persistence (fire-and-forget with error capture) ────────────────────

async function persistFlywheelData(
  promptHash: string,
  promptJson: unknown,
  remoteResult: SlopAnalysis,
  localResult: LocalModelResult,
): Promise<void> {
  await Promise.all([
    // SFT Vault: the 120B gold output
    pool.query(
      `INSERT INTO zie_training_records
         (task_type, prompt_hash, prompt_json, remote_response_json, quality_score)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (prompt_hash) DO NOTHING`,
      [
        "manuscript_slop_check",
        promptHash,
        JSON.stringify(promptJson),
        JSON.stringify(remoteResult),
        "1.0000",
      ],
    ),
    // DPO Vault: chosen=120B, rejected=local
    pool.query(
      `INSERT INTO zie_preference_pairs
         (task_type, prompt_hash, chosen_response_json, rejected_response_json)
       VALUES ($1, $2, $3, $4)`,
      [
        "manuscript_slop_check",
        promptHash,
        JSON.stringify(remoteResult),
        JSON.stringify(localResult.data),
      ],
    ),
  ]);
}

// ── Public API ────────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.85;

export async function executeDoubleDip(
  promptJson: unknown,
  promptHash: string,
): Promise<SlopAnalysis> {
  // ── Dip 1: Local model (cheap) ────────────────────────────────────────────
  const localResult = await runLocalModel(promptJson);

  if (localResult.confidence >= CONFIDENCE_THRESHOLD) {
    return localResult.data;
  }

  // ── Dip 2: Premium 120B via OpenRouter (expensive) ───────────────────────
  const remoteResult = await runOpenRouter120B(promptJson);

  // ── The Theft: async persist, never block the caller ─────────────────────
  void persistFlywheelData(promptHash, promptJson, remoteResult, localResult).catch(
    (err: unknown) => {
      logger.error(
        { err, promptHash },
        "doubleDipRouter: flywheel persistence failed",
      );
    },
  );

  return remoteResult;
}
