/**
 * panel.ts — the Guardian AND-gate.
 *
 * Runs all four guardians over one ExecutorEnvelope and fuses their verdicts:
 *   - pass  = every guardian passes (AND-gate)
 *   - score = mean of guardian sub-scores * 100 (0..100), the reward signal
 *
 * Deterministic guardians (Materiality, Numerical) run synchronously; the
 * hybrid/LLM guardians (Hedge, Rubric) are awaited. Order is fixed so evidence
 * reads materiality → numerical → hedge → rubric.
 */

import type { ExecutorEnvelope, GuardianVerdict, PanelResult } from "../types.js";
import { materialityGuardian } from "./materiality.js";
import { numericalGuardian } from "./numerical.js";
import { hedgeGuardian } from "./hedge.js";
import { rubricGuardian } from "./rubric.js";

export interface PanelOptions {
  /** Skip the LLM rubric (e.g. for pure-deterministic benchmarking). */
  skipRubric?: boolean;
  /** Skip the hedge guardian's LLM adjudication path is handled inside it. */
  skipHedge?: boolean;
}

export async function runPanel(
  env: ExecutorEnvelope,
  opts: PanelOptions = {},
): Promise<PanelResult> {
  const verdicts: GuardianVerdict[] = [];

  // A · Materiality (deterministic, includes aislop + SEARCH/REPLACE)
  verdicts.push(materialityGuardian(env));

  // B · Numerical (deterministic)
  verdicts.push(numericalGuardian(env));

  // C · Hedge (hybrid)
  if (!opts.skipHedge) {
    verdicts.push(await hedgeGuardian(env));
  }

  // D · Rubric (LLM, honest-dry without key)
  if (!opts.skipRubric) {
    verdicts.push(await rubricGuardian(env));
  }

  const pass = verdicts.every((v) => v.pass);
  const score =
    verdicts.length > 0
      ? (verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length) * 100
      : 0;
  // "verified" only if no guardian fell back to dry mode. A dry LLM guardian
  // means that axis was never actually evaluated, so the panel result cannot be
  // treated as a trustworthy pass by the orchestrator.
  const verified = verdicts.every((v) => v.mode !== "dry");

  return { pass, score: Math.round(score * 100) / 100, verdicts, verified };
}
