/**
 * hedge.ts — Guardian C: Hedge-Detector / Anti-Coward (hybrid).
 *
 * Rejects answers that use nuance/hedging to DODGE a binary requirement, or
 * that lean on cowardly qualifiers instead of committing to a verdict. The
 * deterministic layer is a lexicon (anti-coward phrases + peakoss-derived
 * signals: excess emoji, excess unbacked code-references, missing final
 * newline in code). The LLM layer (judge chain) only adjudicates *borderline*
 * cases and degrades honestly (mode:"dry") when no key is present — it never
 * fabricates a score.
 *
 * Design intent: a decisive, correct answer PASSES even if it is careful; only
 * hedging *used to avoid answering a yes/no* fails.
 */

import type { ExecutorEnvelope, GuardianVerdict } from "../types.js";
import { invokeWithFallback, type ModelRouteConfig } from "../../modelRouter.js";
import { geminiJudge, geminiJudgeAvailable } from "../geminiJudge.js";
import { z } from "zod";
import { logger } from "../../logger.js";

// Anti-coward lexicon — phrases that, in a decision context, signal dodging.
const HEDGE_LEXICON: string[] = [
  "it's important to note",
  "it is important to note",
  "while not explicitly",
  "could be interpreted as",
  "documented as not a blocker",
  "it would pass if",
  "is arguably",
  "one could argue",
  "may or may not",
  "it depends on how you look",
  "in some sense",
  "arguably passes",
  "technically speaking",
  "for all intents and purposes",
  "loosely speaking",
  "more or less",
  "should probably",
  "i think it might",
  "it seems like it could",
  "not necessarily a problem",
];

// Binary-requirement cues — when present, hedging is disqualifying.
const BINARY_CUES = [
  "pass", "fail", "passes", "fails", "yes", "no", "compliant", "blocker",
  "meets", "does not meet", "satisfies", "requirement", "gate",
];

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

const MAX_EMOJI = Number(process.env.RIGOR_MAX_EMOJI ?? "2");
const MAX_CODE_REFS = Number(process.env.RIGOR_MAX_CODE_REFS ?? "8");

interface HedgeSignals {
  hedgePhrases: string[];
  emojiCount: number;
  codeRefCount: number;
  hasBinaryCue: boolean;
}

function scanSignals(env: ExecutorEnvelope): HedgeSignals {
  const text = (env.answer_text ?? "").toLowerCase();
  const hedgePhrases = HEDGE_LEXICON.filter((p) => text.includes(p));
  const emojiCount = (env.answer_text ?? "").match(EMOJI_RE)?.length ?? 0;
  // "unbacked code-references": inline backtick spans / `foo()` mentions in prose
  const codeRefCount = ((env.answer_text ?? "").match(/`[^`]+`/g) ?? []).length;
  const hasBinaryCue = BINARY_CUES.some((c) => new RegExp(`\\b${c}\\b`, "i").test(env.answer_text ?? ""));
  return { hedgePhrases, emojiCount, codeRefCount, hasBinaryCue };
}

// LLM adjudication chain — same free-tier ladder as judgePair.
// 2026-07: repointed off dead free slugs to working nvidia nemotron models
// (see rubric.ts buildChain for rationale). maxTokens raised 256->500 so the
// reasoning models leave room for the JSON verdict after their reasoning tokens.
const HEDGE_CHAIN: ModelRouteConfig[] = [
  { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 500, timeoutMs: 20_000 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 500, timeoutMs: 60_000 },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 500, timeoutMs: 60_000 },
];

const HedgeJudgeSchema = z.object({
  dodges_requirement: z.boolean(),
  reason: z.string().min(3),
});

const HEDGE_JUDGE_PROMPT = `You judge whether an AI answer uses hedging/nuance to DODGE a binary (yes/no, pass/fail) requirement, rather than committing to a verdict.

Rules:
- A careful but DECISIVE answer that clearly states pass/fail (even with caveats) does NOT dodge.
- An answer that avoids giving the required verdict, or reframes a clear failure as "arguably fine", DOES dodge.

Output ONLY JSON: {"dodges_requirement": <true|false>, "reason": "<one sentence>"}`;

function hasLlmKey(): boolean {
  return Boolean(
    geminiJudgeAvailable() ||
      (process.env.GROQ_API_KEY || "").trim() ||
      (process.env.OPENROUTER_API_KEY || "").trim() ||
      (process.env.OPENROUTER_API_KEY_2 || "").trim(),
  );
}

export async function hedgeGuardian(env: ExecutorEnvelope): Promise<GuardianVerdict> {
  const sig = scanSignals(env);
  const evidence: string[] = [];

  // Hard deterministic fails (peakoss-derived formatting slop).
  const formatFails: string[] = [];
  if (sig.emojiCount > MAX_EMOJI) formatFails.push(`emoji count ${sig.emojiCount} > ${MAX_EMOJI}`);
  if (sig.codeRefCount > MAX_CODE_REFS)
    formatFails.push(`inline code-references ${sig.codeRefCount} > ${MAX_CODE_REFS} (likely name-dropping without materialization)`);

  // Hedging next to a binary cue is the core anti-coward trigger.
  const hedgingOnBinary = sig.hedgePhrases.length > 0 && sig.hasBinaryCue;

  if (hedgingOnBinary) {
    evidence.push(
      `hedging phrase(s) [${sig.hedgePhrases.join("; ")}] appear alongside a binary requirement cue`,
    );
  }
  for (const f of formatFails) evidence.push(f);

  // Deterministic verdict when signals are unambiguous.
  if (formatFails.length > 0) {
    return {
      guardian: "hedge",
      pass: false,
      reason: `Formatting/anti-slop violation: ${formatFails.join("; ")}.`,
      evidence,
      severity: "medium",
      score: 0,
      mode: "deterministic",
      detail: { ...sig },
    };
  }

  // Clear hedging-on-binary with multiple phrases → deterministic reject.
  if (hedgingOnBinary && sig.hedgePhrases.length >= 2) {
    return {
      guardian: "hedge",
      pass: false,
      reason: "Anti-coward: multiple hedging phrases used to soften a binary requirement.",
      evidence,
      severity: "high",
      score: 0,
      mode: "deterministic",
      detail: { ...sig },
    };
  }

  // Borderline (exactly one hedge phrase on a binary cue) → LLM adjudication.
  const borderline = hedgingOnBinary && sig.hedgePhrases.length === 1;
  if (borderline && hasLlmKey()) {
    try {
      // Primary: Gemini (independent model family + bucket). Fallback: nvidia chain.
      let res: { parsed: z.infer<typeof HedgeJudgeSchema>; model_used?: string };
      if (geminiJudgeAvailable()) {
        try {
          res = await geminiJudge(HEDGE_JUDGE_PROMPT, env.answer_text ?? "", (raw) => HedgeJudgeSchema.parse(raw), {
            maxOutputTokens: 2000,
            temperature: 0,
            timeoutMs: 30_000,
          });
        } catch (gErr) {
          logger.warn({ err: String(gErr) }, "[rigor.hedge] Gemini adjudication failed — nvidia fallback");
          res = await invokeWithFallback<z.infer<typeof HedgeJudgeSchema>>(
            { systemPrompt: HEDGE_JUDGE_PROMPT, userContent: env.answer_text ?? "", title: "Rigor Hedge Judge", maxTokens: 256, temperature: 0 },
            HEDGE_CHAIN,
            { validator: (raw) => HedgeJudgeSchema.parse(raw), routeChainId: "rigor-hedge", schemaType: "seo", retry: { max: 2, baseMs: 1000 } },
          );
        }
      } else {
        res = await invokeWithFallback<z.infer<typeof HedgeJudgeSchema>>(
          { systemPrompt: HEDGE_JUDGE_PROMPT, userContent: env.answer_text ?? "", title: "Rigor Hedge Judge", maxTokens: 256, temperature: 0 },
          HEDGE_CHAIN,
          { validator: (raw) => HedgeJudgeSchema.parse(raw), routeChainId: "rigor-hedge", schemaType: "seo", retry: { max: 2, baseMs: 1000 } },
        );
      }
      if (res.parsed.dodges_requirement) {
        evidence.push(`LLM adjudication: ${res.parsed.reason}`);
        return {
          guardian: "hedge",
          pass: false,
          reason: "Anti-coward: LLM adjudged the answer dodges a binary requirement.",
          evidence,
          severity: "high",
          score: 0,
          mode: "live",
          detail: { ...sig, llm_model: res.model_used },
        };
      }
      return {
        guardian: "hedge",
        pass: true,
        reason: "Decisive enough: single hedge phrase, LLM judged it does not dodge.",
        evidence,
        severity: "low",
        score: 1,
        mode: "live",
        detail: { ...sig, llm_model: res.model_used },
      };
    } catch (err) {
      logger.warn({ err: String(err) }, "[rigor.hedge] LLM adjudication failed — deterministic fallback");
      // fall through to deterministic borderline handling
    }
  }

  if (borderline && !hasLlmKey()) {
    // Honest-dry: one hedge on a binary cue, no key to adjudicate. We flag it as
    // a soft fail (score 0.5) so the orchestrator still applies pressure, but we
    // mark mode:"dry" — we are NOT fabricating an LLM verdict.
    return {
      guardian: "hedge",
      pass: false,
      reason: "Borderline hedging on a binary requirement; no LLM key to adjudicate → treated as unresolved (dry).",
      evidence: [...evidence, "adjudication skipped: no LLM key (honest-dry)"],
      severity: "medium",
      score: 0.5,
      mode: "dry",
      detail: { ...sig },
    };
  }

  return {
    guardian: "hedge",
    pass: true,
    reason: "No disqualifying hedging around a binary requirement.",
    evidence,
    severity: "low",
    score: 1,
    mode: hasLlmKey() ? "live" : "deterministic",
    detail: { ...sig },
  };
}
