/**
 * orchestrator.ts — the Rigor-Gate relentless verification loop.
 *
 * Flow (per the approved plan):
 *   1. Resolve the house model → OpenRouter id (catalog).
 *   2. Execute: prefer the DSPy Refine sidecar (real framework) when it is
 *      healthy AND a key is present; otherwise fall back to a native
 *      modelRouter executor loop. The chosen path is recorded (never faked).
 *   3. Run the guardian panel (Materiality · Numerical · Hedge · Rubric), AND-gate.
 *   4. On REJECT: build a CorrectionPayload (failing guardians + reasons +
 *      evidence + failed SEARCH/REPLACE blocks) and re-execute with the hint.
 *   5. Model-swap: after RIGOR_SWAP_AFTER (2) consecutive same-model failures,
 *      advance to the next catalog entry (the black-box "reroute" analogue).
 *   6. Hard cap RIGOR_MAX_ATTEMPTS (6) → verdict "ESCALATED" + full trail.
 *
 * A REJECTED envelope is NEVER returned as PASSED. Honest-dry: without a key the
 * native executor cannot call an LLM, so the loop runs the panel over a
 * synthesized "dry" envelope built from the prompt/contract and escalates
 * transparently (mode:"dry"); deterministic guardians still gate.
 */
import crypto from "node:crypto";
import { logger } from "../logger.js";
import { resolveApiKey } from "../resolveApiKey.js";
import {
  invokeWithFallback,
  RouterExhaustedError,
  type ModelRouteConfig,
} from "../modelRouter.js";
import { hashPrompt } from "../doubleDipRouter.js";
import { runPanel } from "./guardians/panel.js";
import { buildCorrection } from "./correction.js";
import { geminiGenerate, geminiJudgeAvailable, geminiExecModelForTier } from "./geminiJudge.js";
import { buildSwapChain, DEFAULT_HOUSE_MODEL } from "./catalog.js";
import type {
  ExecutorEnvelope,
  HouseModel,
  PanelResult,
  RigorAttempt,
  RigorRunResult,
  RigorVerdict,
} from "./types.js";

const MAX_ATTEMPTS = Number(process.env.RIGOR_MAX_ATTEMPTS ?? "6");
const SWAP_AFTER = Number(process.env.RIGOR_SWAP_AFTER ?? "2");
const MIN_SCORE = Number(process.env.RIGOR_MIN_SCORE ?? "80");
const DSPY_URL = process.env.RIGOR_DSPY_URL ?? "http://127.0.0.1:8088";

export interface RigorRunInput {
  prompt: string;
  house_model?: string;
  task_type?: string;
  /** Optional contract/spec forwarded to the executor (e.g. skill requirements). */
  contract?: Record<string, unknown>;
  /** Seed artifacts (e.g. an existing file the executor should edit). */
  seed_artifacts?: ExecutorEnvelope["artifacts"];
  /** Force the native executor even if the sidecar is up (used by tests/benchmark). */
  force_native?: boolean;
  /** Per-request override of RIGOR_MAX_ATTEMPTS (native path loop cap + DSPy max_n). */
  max_attempts?: number;
  /** Per-request override of RIGOR_SWAP_AFTER (consecutive same-model fails before swap). */
  swap_after?: number;
}

// ── DSPy sidecar client ───────────────────────────────────────────────────────

async function dspyHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${DSPY_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return Boolean(j.ok);
  } catch {
    return false;
  }
}

interface DspyRefineResponse {
  ok: boolean;
  mode: "live" | "dry";
  executor_path: "dspy";
  envelope?: ExecutorEnvelope;
  passed?: boolean;
  best_score?: number;
  n_attempts?: number;
  reason?: string;
}

async function callDspyRefine(
  input: RigorRunInput,
  model: HouseModel,
  promptHash: string,
  runId: string,
): Promise<DspyRefineResponse | null> {
  try {
    const r = await fetch(`${DSPY_URL}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: input.prompt,
        house_model: model.house_name,
        openrouter_id: model.openrouter_id,
        contract: input.contract ?? {},
        threshold: MIN_SCORE / 100,
        max_n: input.max_attempts ?? MAX_ATTEMPTS,
        task_type: input.task_type ?? "rigor_generic",
        prompt_hash: promptHash,
        run_id: runId,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) return null;
    return (await r.json()) as DspyRefineResponse;
  } catch (err) {
    logger.warn({ err: String(err) }, "[rigor.orchestrator] DSPy /refine call failed");
    return null;
  }
}

// ── Native executor (modelRouter) ─────────────────────────────────────────────

const EXECUTOR_SYSTEM = `You are the Rigor-Gate executor. You must produce a JSON object with EXACTLY these fields and nothing else:
{
  "answer_text": string,            // the decisive answer; no hedging, no "it's important to note"
  "artifacts": [{"name","mime","content"}],  // any file/code/data you produce (code goes here)
  "edit_blocks": [string],          // Aider SEARCH/REPLACE blocks if editing a seeded file, else []
  "claims": [{"text","kind"}]       // kind in {"success","numeric","factual"}
}
Rules: Never claim a fix/pass/result you cannot back with a concrete artifact. Every number you state must match the artifact it came from. If prior feedback rejected you, the feedback explains exactly why — fix that specific problem, do not restate.`;

function buildExecutorUser(
  input: RigorRunInput,
  hint: string,
  seed: ExecutorEnvelope["artifacts"],
): string {
  const parts: string[] = [`TASK:\n${input.prompt}`];
  if (input.contract && Object.keys(input.contract).length > 0) {
    parts.push(`CONTRACT (requirements the output must satisfy):\n${JSON.stringify(input.contract, null, 2)}`);
  }
  if (seed.length > 0) {
    parts.push(
      `EXISTING FILES (edit these via edit_blocks; their current content):\n` +
        seed.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n"),
    );
  }
  if (hint) parts.push(`CORRECTION REQUIRED (your previous attempt was REJECTED):\n${hint}`);
  return parts.join("\n\n");
}

function parseNativeEnvelope(raw: string, seed: ExecutorEnvelope["artifacts"]): ExecutorEnvelope {
  let obj: Record<string, unknown> = {};
  try {
    // Tolerate ```json fences.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // If the model returned prose, treat it as answer_text so guardians can judge it.
    obj = { answer_text: raw };
  }
  const artifacts = Array.isArray(obj.artifacts)
    ? (obj.artifacts as ExecutorEnvelope["artifacts"])
    : [];
  // Merge seed artifacts the executor did not re-emit, so SEARCH/REPLACE has a target.
  const seen = new Set(artifacts.map((a) => a.name));
  for (const s of seed) if (!seen.has(s.name)) artifacts.push(s);
  return {
    answer_text: typeof obj.answer_text === "string" ? obj.answer_text : "",
    artifacts,
    edit_blocks: Array.isArray(obj.edit_blocks) ? (obj.edit_blocks as string[]) : [],
    claims: Array.isArray(obj.claims) ? (obj.claims as ExecutorEnvelope["claims"]) : [],
  };
}

async function nativeExecute(
  input: RigorRunInput,
  model: HouseModel,
  hint: string,
  seed: ExecutorEnvelope["artifacts"],
): Promise<{ envelope: ExecutorEnvelope; live: boolean }> {
  const chain: ModelRouteConfig[] = [
    { id: model.openrouter_id, provider: "openrouter", apiKeyEnv: model.api_key_env, maxTokens: 4000 },
  ];
  // PRIMARY executor: Google Gemini when a key is present. The OpenRouter free
  // tier has a hard per-day cap (free-models-per-day) that, once hit, 429s every
  // nvidia model until reset; Gemini is an independent, healthy quota that emits
  // clean envelope JSON in ~2s. On ANY Gemini failure we fall through to the
  // OpenRouter chain below (which reports its real per-entry reasons and, if it
  // also fails, produces the honest dry envelope → UNVERIFIED). Opt-out via
  // RIGOR_DISABLE_GEMINI_EXEC=1.
  if (geminiJudgeAvailable() && process.env.RIGOR_DISABLE_GEMINI_EXEC !== "1") {
    try {
      const g = await geminiGenerate(EXECUTOR_SYSTEM, buildExecutorUser(input, hint, seed), {
        temperature: 0.2,
        maxOutputTokens: 4000,
        timeoutMs: 45_000,
        model: geminiExecModelForTier(model.tier),
      });
      logger.info({ model: g.model_used, house: model.house_name }, "[rigor.orchestrator] executor via Gemini (primary)");
      return { envelope: parseNativeEnvelope(g.raw, seed), live: true };
    } catch (gErr) {
      logger.warn(
        { err: String(gErr), house: model.house_name },
        "[rigor.orchestrator] Gemini executor failed — falling back to OpenRouter chain",
      );
    }
  }
  try {
    const res = await invokeWithFallback(
      {
        systemPrompt: EXECUTOR_SYSTEM,
        userContent: buildExecutorUser(input, hint, seed),
        title: "rigor-executor",
        temperature: 0.7,
        maxTokens: 4000,
      },
      chain,
      // schemaType:"seo" is the escape hatch that skips detectUnusableOutput's
      // LEGAL-clause field checks (rationale_summary/recommended_action). The
      // rigor executor emits answer_text/artifacts/claims and does its OWN
      // tolerant parsing via parseNativeEnvelope, so the legal validator must
      // not run — otherwise every rigor call is falsely flagged "unusable
      // (empty rationale_summary)" and silently dry-falls-back. (2026-07)
      { routeChainId: `rigor-exec:${model.house_name}`, schemaType: "seo", retry: { max: 2, baseMs: 1000 } },
    );
    return { envelope: parseNativeEnvelope(res.raw, seed), live: true };
  } catch (err) {
    if (err instanceof RouterExhaustedError) {
      // All entries exhausted. This is NOT necessarily "no key" — it can be
      // 429/402/timeout/empty-content with a valid key. Surface the ACTUAL
      // per-entry reasons so failures are never silently masked as dry, and
      // reflect the real cause in the envelope (which is still gated normally).
      const reasons = err.attempt_log.map(
        (a) => `${a.provider}:${a.model_id} -> ${a.status}${a.error ? ` (${a.error.slice(0, 120)})` : ""}`,
      );
      const anyKeyMissing = err.attempt_log.every((a) => a.status === "key_missing");
      logger.warn(
        { model: model.house_name, openrouter_id: model.openrouter_id, reasons },
        "[rigor.orchestrator] executor call exhausted — falling back to dry envelope",
      );
      const label = anyKeyMissing ? "no LLM key available" : `executor unavailable: ${reasons.join("; ")}`;
      return {
        envelope: {
          answer_text: `[dry-mode: ${label}] Task echoed for guardian evaluation: ${input.prompt.slice(0, 400)}`,
          artifacts: seed,
          edit_blocks: [],
          claims: [],
        },
        live: false,
      };
    }
    throw err;
  }
}

// ── Main orchestration ────────────────────────────────────────────────────────

export async function runRigorGate(input: RigorRunInput): Promise<RigorRunResult> {
  const houseName = input.house_model ?? DEFAULT_HOUSE_MODEL;
  const taskType = input.task_type ?? "general";
  // Per-request overrides (fall back to env-configured module defaults). Clamped
  // to sane bounds so a caller cannot request a pathological loop.
  const maxAttempts = Math.max(1, Math.min(20, input.max_attempts ?? MAX_ATTEMPTS));
  const swapAfter = Math.max(1, Math.min(maxAttempts, input.swap_after ?? SWAP_AFTER));
  const promptHash = hashPrompt(`${taskType}::${input.prompt}`);
  const runId = crypto.randomUUID();
  const seed = input.seed_artifacts ?? [];

  const swapChain = await buildSwapChain(houseName);
  if (swapChain.length === 0) {
    throw new Error(`No usable house model resolved for "${houseName}"`);
  }

  const keyed = Boolean(resolveApiKey("OPENROUTER_API_KEY"));
  const useDspy = !input.force_native && keyed && (await dspyHealthy());

  const attempts: RigorAttempt[] = [];
  const modelPath: string[] = [];
  let slopEnvelope: ExecutorEnvelope | null = null;
  let scoreBefore = 0;
  let modeLive = keyed;

  // ── Path A: DSPy Refine sidecar (real framework, single relentless call) ────
  if (useDspy) {
    const model = swapChain[0];
    modelPath.push(model.house_name);
    const dspy = await callDspyRefine(input, model, promptHash, runId);
    if (dspy && dspy.ok && dspy.envelope) {
      // Re-score with our panel authoritatively (the sidecar reward already used
      // it, but we re-run to attach the canonical verdict trail).
      const panel = await runPanel(dspy.envelope);
      scoreBefore = panel.score;
      attempts.push({
        attempt: 1,
        house_model: model.house_name,
        openrouter_id: model.openrouter_id,
        executor_path: "dspy",
        panel,
        swapped: false,
      });
      if (!panel.pass) slopEnvelope = dspy.envelope;
      return finalize({
        input,
        taskType,
        houseName: model.house_name,
        promptHash,
        runId,
        finalEnvelope: dspy.envelope,
        slopEnvelope,
        attempts,
        modelPath,
        executorPath: "dspy",
        scoreBefore,
        modeLive: dspy.mode === "live",
      });
    }
    // Sidecar returned dry/failed → fall through to native (path recorded native).
    logger.info(
      { reason: dspy?.reason ?? "sidecar unreachable" },
      "[rigor.orchestrator] DSPy path unavailable; falling back to native executor",
    );
  }

  // ── Path B: native modelRouter loop with correction + model-swap ────────────
  let modelIdx = 0;
  let consecutiveFails = 0;
  let hint = "";
  let lastEnvelope: ExecutorEnvelope | null = null;
  let lastPanel: PanelResult | null = null;
  let lastLive = false; // liveness of the most recent attempt's executor

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const model = swapChain[Math.min(modelIdx, swapChain.length - 1)];
    const swapped = modelPath.length > 0 && modelPath[modelPath.length - 1] !== model.house_name;
    modelPath.push(model.house_name);

    const { envelope, live } = await nativeExecute(input, model, hint, seed);
    // Per-attempt liveness. The FINAL verdict's mode must reflect the WINNING
    // attempt's executor, not a sticky "any attempt ever went dry" flag: an
    // early attempt can dry-fall-back on a transient 503 and a later attempt can
    // succeed live. Track the last attempt's liveness and pass THAT to finalize.
    const attemptLive = live;
    lastLive = live;
    if (!live) modeLive = false; // retained only for legacy telemetry, not verdict
    const panel = await runPanel(envelope);
    lastEnvelope = envelope;
    lastPanel = panel;
    if (attemptNo === 1) scoreBefore = panel.score;

    attempts.push({
      attempt: attemptNo,
      house_model: model.house_name,
      openrouter_id: model.openrouter_id,
      executor_path: "native",
      panel,
      swapped,
    });

    if (panel.pass) {
      return finalize({
        input,
        taskType,
        houseName: model.house_name,
        promptHash,
        runId,
        finalEnvelope: envelope,
        slopEnvelope,
        attempts,
        modelPath,
        executorPath: "native",
        scoreBefore,
        // Verdict reflects THIS (winning) attempt's executor liveness.
        modeLive: attemptLive,
      });
    }

    // REJECTED → capture the first slop, build correction, maybe swap.
    if (slopEnvelope === null) slopEnvelope = envelope;
    const correction = buildCorrection(panel);
    hint = correction.advice;
    consecutiveFails += 1;
    if (consecutiveFails >= swapAfter && modelIdx < swapChain.length - 1) {
      modelIdx += 1;
      consecutiveFails = 0;
      hint += `\n\n[Escalating to a stronger model after ${swapAfter} failed attempts.]`;
    }
  }

  // Cap hit → ESCALATED. Never return the rejected envelope as PASSED.
  return finalize({
    input,
    taskType,
    houseName: swapChain[Math.min(modelIdx, swapChain.length - 1)].house_name,
    promptHash,
    runId,
    finalEnvelope: lastEnvelope ?? { answer_text: "", artifacts: seed, edit_blocks: [], claims: [] },
    slopEnvelope,
    attempts,
    modelPath,
    executorPath: "native",
    scoreBefore,
    // Verdict reflects the LAST attempt's executor liveness (an early transient
    // dry-fallback must not force the whole run to UNVERIFIED if later attempts
    // ran live). If the last attempt was dry → UNVERIFIED; else → ESCALATED.
    modeLive: lastLive,
    forceEscalated: true,
    lastPanel,
  });
}

// ── Result assembly ───────────────────────────────────────────────────────────

function finalize(args: {
  input: RigorRunInput;
  taskType: string;
  houseName: string;
  promptHash: string;
  runId: string;
  finalEnvelope: ExecutorEnvelope;
  slopEnvelope: ExecutorEnvelope | null;
  attempts: RigorAttempt[];
  modelPath: string[];
  executorPath: "dspy" | "native";
  scoreBefore: number;
  modeLive: boolean;
  forceEscalated?: boolean;
  lastPanel?: PanelResult | null;
}): RigorRunResult {
  const last = args.attempts[args.attempts.length - 1];
  const scoreAfter = last?.panel.score ?? 0;
  const dedupModelPath = [...new Set(args.modelPath)];

  // ── Fail-closed verdict ─────────────────────────────────────────────────────
  // Integrity rule: the gate must never CERTIFY output it could not verify.
  //   1. Executor dry (rate-limit/timeout/no-key)  → UNVERIFIED. The model never
  //      produced the output; a dry echo passing the deterministic guardians is
  //      NOT a real pass, and it is not a real reject either.
  //   2. Last panel passed but was not fully verified (an LLM guardian fell back
  //      to dry) → UNVERIFIED. We cannot stand behind a pass whose judge did not
  //      actually run.
  //   3. Passed AND verified AND executor live → PASS.
  //   4. Otherwise (live, evaluated, guardians rejected to the cap) → ESCALATED.
  const executorLive = args.modeLive;
  const lastPanelPass = Boolean(last?.panel.pass);
  const lastPanelVerified = Boolean(last?.panel.verified);
  let verdict: RigorVerdict;
  if (!executorLive) {
    verdict = "UNVERIFIED";
  } else if (!args.forceEscalated && lastPanelPass && lastPanelVerified) {
    verdict = "PASS";
  } else if (!args.forceEscalated && lastPanelPass && !lastPanelVerified) {
    verdict = "UNVERIFIED";
  } else {
    verdict = "ESCALATED";
  }
  const passed = verdict === "PASS";
  const escalated = verdict === "ESCALATED";
  return {
    verdict,
    run_id: args.runId,
    task_type: args.taskType,
    house_model: args.houseName,
    prompt_hash: args.promptHash,
    final_envelope: args.finalEnvelope,
    slop_envelope: args.slopEnvelope,
    attempts: args.attempts,
    n_attempts: args.attempts.length,
    escalated,
    rigor_score_before: Math.round(args.scoreBefore),
    rigor_score_after: Math.round(scoreAfter),
    model_path: dedupModelPath,
    executor_path: args.executorPath,
    mode: args.modeLive ? "live" : "dry",
  };
}
