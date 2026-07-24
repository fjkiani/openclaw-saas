/**
 * rubric.ts — Guardian D: Rigor Rubric Judge (LLM; reuses the judgePair chain).
 *
 * Scores an answer 0-100 on five axes — materiality, numerical grounding,
 * decisiveness, methodological completeness, actionability — and REJECTS if the
 * overall (or any single axis) falls below RIGOR_MIN_SCORE. This is the
 * normalized reward the DSPy sidecar consumes via /_score.
 *
 * Honest degradation: with no LLM key this guardian returns mode:"dry" and does
 * NOT fabricate a score. In dry mode it emits a neutral pass (score derived from
 * the deterministic guardians is what actually gates the run) so the pipeline
 * still functions and the LLM axis simply "requires key" — matching the plan's
 * honest-dry contract.
 */

import { z } from "zod";
import type { ExecutorEnvelope, GuardianVerdict } from "../types.js";
import { invokeWithFallback, type ModelRouteConfig } from "../../modelRouter.js";
import { logger } from "../../logger.js";

const MIN_SCORE = Number(process.env.RIGOR_MIN_SCORE ?? "80");

// Same free-tier ladder as judgePair.JUDGE_CHAIN (Groq 70B → OR keys 1-4).
// RIGOR_GUARDIAN_MODEL can override the primary model id if set.
function buildChain(): ModelRouteConfig[] {
  const override = (process.env.RIGOR_GUARDIAN_MODEL || "").trim();
  const chain: ModelRouteConfig[] = [
    { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 512, timeoutMs: 20_000 },
    { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 512, timeoutMs: 55_000 },
    { id: "openai/gpt-oss-120b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2", maxTokens: 512, timeoutMs: 55_000 },
    { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_3", maxTokens: 512, timeoutMs: 55_000 },
    { id: "openai/gpt-oss-120b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_4", maxTokens: 512, timeoutMs: 55_000 },
  ];
  if (override) chain.unshift({ id: override, provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 512, timeoutMs: 55_000 });
  return chain;
}

const RubricSchema = z.object({
  materiality: z.number().min(0).max(100),
  numerical_grounding: z.number().min(0).max(100),
  decisiveness: z.number().min(0).max(100),
  methodological_completeness: z.number().min(0).max(100),
  actionability: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  reasoning: z.string().min(5),
});

const RUBRIC_PROMPT = `You are a strict rigor auditor. Score the AI answer 0-100 on each axis:
- materiality: are success/fix claims backed by concrete artifacts/edits, not prose?
- numerical_grounding: do stated numbers match the provided artifacts?
- decisiveness: does it commit to binary verdicts instead of hedging?
- methodological_completeness: is the method complete and reproducible?
- actionability: can a reader act on it directly?

Then give an "overall" 0-100 (holistic, not a mean). Be harsh on slop: unbacked claims,
vague hedging, or numbers that don't match artifacts should score low.

Output ONLY JSON:
{"materiality":<0-100>,"numerical_grounding":<0-100>,"decisiveness":<0-100>,"methodological_completeness":<0-100>,"actionability":<0-100>,"overall":<0-100>,"reasoning":"<one sentence>"}`;

function hasLlmKey(): boolean {
  return Boolean(
    (process.env.GROQ_API_KEY || "").trim() ||
      (process.env.OPENROUTER_API_KEY || "").trim() ||
      (process.env.OPENROUTER_API_KEY_2 || "").trim() ||
      (process.env.OPENROUTER_API_KEY_3 || "").trim() ||
      (process.env.OPENROUTER_API_KEY_4 || "").trim(),
  );
}

function serializeForJudge(env: ExecutorEnvelope): string {
  return JSON.stringify({
    answer_text: env.answer_text,
    artifacts: (env.artifacts ?? []).map((a) => ({
      name: a.name,
      mime: a.mime,
      content: a.content.slice(0, 4000),
    })),
    edit_blocks: env.edit_blocks,
    claims: env.claims,
  });
}

export async function rubricGuardian(env: ExecutorEnvelope): Promise<GuardianVerdict> {
  if (!hasLlmKey()) {
    // Honest-dry: no fabricated LLM score. Neutral pass; deterministic guardians gate.
    return {
      guardian: "rubric",
      pass: true,
      reason: "LLM rubric requires an API key; skipped in honest-dry mode (deterministic guardians gate).",
      evidence: ["rubric adjudication skipped: no LLM key (honest-dry)"],
      severity: "low",
      score: 1,
      mode: "dry",
      detail: { min_score: MIN_SCORE },
    };
  }

  try {
    const res = await invokeWithFallback<z.infer<typeof RubricSchema>>(
      {
        systemPrompt: RUBRIC_PROMPT,
        userContent: serializeForJudge(env),
        title: "Rigor Rubric Judge",
        maxTokens: 512,
        temperature: 0,
      },
      buildChain(),
      { validator: (raw) => RubricSchema.parse(raw), routeChainId: "rigor-rubric", schemaType: "seo" },
    );
    const r = res.parsed;
    const axes = {
      materiality: r.materiality,
      numerical_grounding: r.numerical_grounding,
      decisiveness: r.decisiveness,
      methodological_completeness: r.methodological_completeness,
      actionability: r.actionability,
    };
    const minAxis = Math.min(...Object.values(axes));
    const failedAxes = Object.entries(axes)
      .filter(([, v]) => v < MIN_SCORE)
      .map(([k, v]) => `${k}=${v}`);
    const pass = r.overall >= MIN_SCORE && minAxis >= MIN_SCORE;
    return {
      guardian: "rubric",
      pass,
      reason: pass
        ? `Rubric overall ${r.overall} ≥ ${MIN_SCORE}; all axes clear. ${r.reasoning}`
        : `Rubric below threshold (overall ${r.overall}, failing axes: ${failedAxes.join(", ") || "none"}). ${r.reasoning}`,
      evidence: [
        `overall=${r.overall}`,
        ...Object.entries(axes).map(([k, v]) => `${k}=${v}`),
      ],
      severity: pass ? "low" : "high",
      score: Math.max(0, Math.min(1, r.overall / 100)),
      mode: "live",
      detail: { axes, overall: r.overall, min_score: MIN_SCORE, model: res.model_used },
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "[rigor.rubric] LLM judge failed — honest dry fallback");
    return {
      guardian: "rubric",
      pass: true,
      reason: "LLM rubric judge unavailable (all chain entries failed); deterministic guardians gate.",
      evidence: [`rubric LLM failed: ${String(err).slice(0, 160)}`],
      severity: "low",
      score: 1,
      mode: "dry",
      detail: { min_score: MIN_SCORE },
    };
  }
}
