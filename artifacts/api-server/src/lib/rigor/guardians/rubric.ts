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
import { geminiJudge, geminiJudgeAvailable } from "../geminiJudge.js";
import { logger } from "../../logger.js";

const MIN_SCORE = Number(process.env.RIGOR_MIN_SCORE ?? "80");
// Soft per-axis backstop: an axis below this is "broken on that dimension" and
// fails regardless of overall. Set well below MIN_SCORE so terse-but-correct
// answers (naturally low on inapplicable axes) are not false-rejected.
const AXIS_FLOOR = Number(process.env.RIGOR_AXIS_FLOOR ?? "50");

// Same free-tier ladder as judgePair.JUDGE_CHAIN (Groq 70B → OR keys 1-4).
// RIGOR_GUARDIAN_MODEL can override the primary model id if set.
function buildChain(): ModelRouteConfig[] {
  const override = (process.env.RIGOR_GUARDIAN_MODEL || "").trim();
  // 2026-07: original free judge slugs (llama-3.3-70b:free, gpt-oss-120b:free) are
  // all 404/delisted and no GROQ key exists → judge silently dry-fell-back on every
  // call. Repointed to verified-working free nvidia nemotron models. Groq entry kept
  // first but is auto-skipped when GROQ_API_KEY is unset (no-op today). Larger models
  // first so the judge is the strongest available; smaller as rate-limit fallbacks.
  const chain: ModelRouteConfig[] = [
    { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 700, timeoutMs: 20_000 },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 700, timeoutMs: 90_000 },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 700, timeoutMs: 90_000 },
    { id: "nvidia/nemotron-3-nano-30b-a3b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 700, timeoutMs: 60_000 },
    { id: "nvidia/nemotron-nano-9b-v2:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 700, timeoutMs: 60_000 },
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

IMPORTANT — do not penalize appropriate concision. Judge relative to what the TASK needs:
- A correct, decisive short answer to a simple question (e.g. a yes/no with a brief reason,
  or "no numeric claim is made here") is HIGH quality, not low.
- If an axis does not apply to the task (e.g. methodological_completeness or actionability
  for a factual yes/no), score that axis HIGH (>=80) to mean "no deficiency", never low.
- Only score an axis low when the answer is genuinely deficient on that dimension (a claim
  that SHOULD have an artifact but doesn't; a number that contradicts the artifact; real
  hedging on a binary question). Missing detail that the task never required is NOT a defect.

Output ONLY JSON:
{"materiality":<0-100>,"numerical_grounding":<0-100>,"decisiveness":<0-100>,"methodological_completeness":<0-100>,"actionability":<0-100>,"overall":<0-100>,"reasoning":"<one sentence>"}`;

function hasLlmKey(): boolean {
  return Boolean(
    geminiJudgeAvailable() ||
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
    // Primary judge: Google Gemini (independent rate-limit bucket + independent
    // model family from the nvidia executors). Fall back to the nvidia OpenRouter
    // chain only if Gemini is unavailable/errors. Either way we end with a
    // validated RubricSchema `r` and a `modelUsed` label.
    let r: z.infer<typeof RubricSchema>;
    let modelUsed: string | undefined;
    if (geminiJudgeAvailable()) {
      try {
        const g = await geminiJudge(
          RUBRIC_PROMPT,
          serializeForJudge(env),
          (raw) => RubricSchema.parse(raw),
          { maxOutputTokens: 4000, temperature: 0, timeoutMs: 40_000 },
        );
        r = g.parsed;
        modelUsed = g.model_used;
      } catch (gErr) {
        logger.warn({ err: String(gErr) }, "[rigor.rubric] Gemini primary failed — falling back to nvidia chain");
        const res = await invokeWithFallback<z.infer<typeof RubricSchema>>(
          { systemPrompt: RUBRIC_PROMPT, userContent: serializeForJudge(env), title: "Rigor Rubric Judge", maxTokens: 700, temperature: 0 },
          buildChain(),
          { validator: (raw) => RubricSchema.parse(raw), routeChainId: "rigor-rubric", schemaType: "seo", retry: { max: 2, baseMs: 1000 } },
        );
        r = res.parsed;
        modelUsed = res.model_used;
      }
    } else {
      const res = await invokeWithFallback<z.infer<typeof RubricSchema>>(
        { systemPrompt: RUBRIC_PROMPT, userContent: serializeForJudge(env), title: "Rigor Rubric Judge", maxTokens: 700, temperature: 0 },
        buildChain(),
        { validator: (raw) => RubricSchema.parse(raw), routeChainId: "rigor-rubric", schemaType: "seo", retry: { max: 2, baseMs: 1000 } },
      );
      r = res.parsed;
      modelUsed = res.model_used;
    }
    const axes = {
      materiality: r.materiality,
      numerical_grounding: r.numerical_grounding,
      decisiveness: r.decisiveness,
      methodological_completeness: r.methodological_completeness,
      actionability: r.actionability,
    };
    const minAxis = Math.min(...Object.values(axes));
    // Gate rule (2026-07-25): overall >= MIN_SCORE (quality bar) AND every axis
    // >= AXIS_FLOOR (a soft "not broken on any dimension" backstop).
    //
    // WHY NOT "every axis >= MIN_SCORE": that min-axis rule false-rejected terse-
    // but-correct answers. A correct one-liner ("Yes, compatible with Node 20,
    // verified against engines") scores ~96 overall but naturally low on
    // methodological_completeness/actionability (there is no methodology to show
    // for a yes/no), so a single inapplicable sub-80 axis failed the whole run.
    // Live benchmark measured false-reject 0.54 from exactly this. The overall
    // score already reflects the judge's holistic quality view; the axis floor
    // only catches output that is genuinely broken on some dimension (<50),
    // preserving 1.0 slop recall without punishing concision.
    const axisFloor = AXIS_FLOOR;
    const belowFloor = Object.entries(axes)
      .filter(([, v]) => v < axisFloor)
      .map(([k, v]) => `${k}=${v}`);
    const pass = r.overall >= MIN_SCORE && minAxis >= axisFloor;
    return {
      guardian: "rubric",
      pass,
      reason: pass
        ? `Rubric overall ${r.overall} ≥ ${MIN_SCORE}; no axis below floor ${axisFloor}. ${r.reasoning}`
        : r.overall < MIN_SCORE
          ? `Rubric overall ${r.overall} < ${MIN_SCORE}. ${r.reasoning}`
          : `Rubric axis below floor ${axisFloor} (${belowFloor.join(", ")}) despite overall ${r.overall}. ${r.reasoning}`,
      evidence: [
        `overall=${r.overall}`,
        `axis_floor=${axisFloor}`,
        ...Object.entries(axes).map(([k, v]) => `${k}=${v}`),
      ],
      severity: pass ? "low" : "high",
      score: Math.max(0, Math.min(1, r.overall / 100)),
      mode: "live",
      detail: { axes, overall: r.overall, min_score: MIN_SCORE, axis_floor: axisFloor, model: modelUsed },
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
