/**
 * benchmark.ts — measure the guardian panel against labeled fixtures.
 *
 * Loads bench/rigor/fixtures.json (a labeled set of executor envelopes tagged
 * slop|clean across the three failure modes) and computes:
 *   - slop-rejection rate (recall on labeled slop) + false-reject rate per
 *     guardian and overall
 *   - materiality-catch, numerical-mismatch-catch rates
 *   - latency per panel run
 *   - baseline contrast: panel ON vs a naive "executor self-judges" baseline
 *     (which trusts any envelope that contains a success claim → the status-quo
 *     failure mode). Demonstrates the panel's added value on the same fixtures.
 *
 * Runs in honest-dry mode without a key (deterministic guardians fully gate;
 * LLM guardians degrade). No fabricated numbers.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runPanel } from "./guardians/panel.js";
import type { ExecutorEnvelope } from "./types.js";

export interface BenchFixture {
  id: string;
  mode: "materiality" | "numerical" | "hedge" | "mixed";
  label: "slop" | "clean";
  envelope: ExecutorEnvelope;
  note?: string;
}

interface Confusion {
  tp: number; // slop correctly rejected
  fn: number; // slop wrongly passed
  tn: number; // clean correctly passed
  fp: number; // clean wrongly rejected
}

function emptyConf(): Confusion {
  return { tp: 0, fn: 0, tn: 0, fp: 0 };
}

function rates(c: Confusion) {
  const slop = c.tp + c.fn;
  const clean = c.tn + c.fp;
  return {
    slop_rejection_rate: slop > 0 ? c.tp / slop : null, // recall
    false_reject_rate: clean > 0 ? c.fp / clean : null, // 1 - specificity
    n_slop: slop,
    n_clean: clean,
    confusion: c,
  };
}

export function loadFixtures(): BenchFixture[] {
  // Resolve relative to this module when import.meta.url is available (ESM
  // production bundle); fall back to cwd-based candidates otherwise (e.g. a CJS
  // test bundle where import.meta.url is undefined). RIGOR_FIXTURES wins if set.
  const candidates: string[] = [];
  if (process.env.RIGOR_FIXTURES) candidates.push(process.env.RIGOR_FIXTURES);
  try {
    const metaUrl = (import.meta as { url?: string }).url;
    if (metaUrl) {
      const here = dirname(fileURLToPath(metaUrl));
      candidates.push(
        resolve(here, "../../../bench/rigor/fixtures.json"),
        resolve(here, "../../bench/rigor/fixtures.json"),
      );
    }
  } catch {
    /* import.meta.url unavailable (CJS) → cwd fallbacks below */
  }
  candidates.push(
    resolve(process.cwd(), "bench/rigor/fixtures.json"),
    resolve(process.cwd(), "artifacts/api-server/bench/rigor/fixtures.json"),
  );
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf8")) as BenchFixture[];
    }
  }
  throw new Error(`fixtures.json not found (looked in: ${candidates.join(", ")})`);
}

/** The naive baseline: trust any envelope that asserts success and ships nothing
 *  contradictory — i.e. no independent verification. Passes unless empty. */
function selfJudgeBaselinePass(env: ExecutorEnvelope): boolean {
  // Status-quo: the executor's own optimism. Anything with text "passes".
  return (env.answer_text ?? "").trim().length > 0;
}

export interface BenchmarkMetrics {
  generated_at: string;
  n_fixtures: number;
  mode: "live" | "dry";
  overall: ReturnType<typeof rates>;
  by_guardian: Record<string, ReturnType<typeof rates>>;
  by_mode: Record<string, ReturnType<typeof rates>>;
  materiality_catch_rate: number | null;
  numerical_mismatch_catch_rate: number | null;
  latency_ms: { mean: number; p50: number; max: number };
  baseline_self_judge: ReturnType<typeof rates>;
  // How many fixtures ran with EVERY guardian in live/deterministic mode (no dry
  // LLM fallback). n_verified < n_fixtures means the run was quota-contaminated and
  // its accuracy numbers must be discarded.
  n_verified: number;
  per_fixture: Array<{
    id: string;
    mode: string;
    label: string;
    panel_pass: boolean;
    verified: boolean;
    correct: boolean;
    score: number;
    failing: string[];
  }>;
}

export async function runBenchmark(): Promise<BenchmarkMetrics> {
  const fixtures = loadFixtures();
  const keyed = Boolean(process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);

  const overall = emptyConf();
  const byGuardian: Record<string, Confusion> = {
    materiality: emptyConf(),
    numerical: emptyConf(),
    hedge: emptyConf(),
    rubric: emptyConf(),
  };
  const byMode: Record<string, Confusion> = {};
  const baseline = emptyConf();
  const latencies: number[] = [];
  const perFixture: BenchmarkMetrics["per_fixture"] = [];

  let materialityCatchable = 0;
  let materialityCaught = 0;
  let numericalCatchable = 0;
  let numericalCaught = 0;

  for (const fx of fixtures) {
    const t0 = Date.now();
    const panel = await runPanel(fx.envelope);
    latencies.push(Date.now() - t0);

    const isSlop = fx.label === "slop";
    const rejected = !panel.pass;
    const correct = isSlop ? rejected : !rejected;

    // overall confusion
    if (isSlop && rejected) overall.tp++;
    else if (isSlop && !rejected) overall.fn++;
    else if (!isSlop && !rejected) overall.tn++;
    else overall.fp++;

    // by declared failure mode
    byMode[fx.mode] ??= emptyConf();
    if (isSlop && rejected) byMode[fx.mode].tp++;
    else if (isSlop && !rejected) byMode[fx.mode].fn++;
    else if (!isSlop && !rejected) byMode[fx.mode].tn++;
    else byMode[fx.mode].fp++;

    // per-guardian: did THIS guardian reject? (attributes catches to guardians)
    for (const v of panel.verdicts) {
      const g = byGuardian[v.guardian];
      if (!g) continue;
      const gRejected = !v.pass;
      if (isSlop && gRejected) g.tp++;
      else if (isSlop && !gRejected) g.fn++;
      else if (!isSlop && !gRejected) g.tn++;
      else g.fp++;
    }

    // targeted catch rates
    if (fx.mode === "materiality" && isSlop) {
      materialityCatchable++;
      if (panel.verdicts.find((v) => v.guardian === "materiality" && !v.pass)) materialityCaught++;
    }
    if (fx.mode === "numerical" && isSlop) {
      numericalCatchable++;
      if (panel.verdicts.find((v) => v.guardian === "numerical" && !v.pass)) numericalCaught++;
    }

    // baseline
    const baseRejected = !selfJudgeBaselinePass(fx.envelope);
    if (isSlop && baseRejected) baseline.tp++;
    else if (isSlop && !baseRejected) baseline.fn++;
    else if (!isSlop && !baseRejected) baseline.tn++;
    else baseline.fp++;

    perFixture.push({
      id: fx.id,
      mode: fx.mode,
      label: fx.label,
      panel_pass: panel.pass,
      verified: panel.verified,
      correct,
      score: panel.score,
      failing: panel.verdicts.filter((v) => !v.pass).map((v) => v.guardian),
    });
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((s, x) => s + x, 0) / (latencies.length || 1);

  return {
    generated_at: new Date().toISOString(),
    n_fixtures: fixtures.length,
    mode: keyed ? "live" : "dry",
    overall: rates(overall),
    by_guardian: Object.fromEntries(Object.entries(byGuardian).map(([k, v]) => [k, rates(v)])),
    by_mode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, rates(v)])),
    materiality_catch_rate: materialityCatchable > 0 ? materialityCaught / materialityCatchable : null,
    numerical_mismatch_catch_rate: numericalCatchable > 0 ? numericalCaught / numericalCatchable : null,
    latency_ms: {
      mean: Math.round(mean * 100) / 100,
      p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    },
    baseline_self_judge: rates(baseline),
    n_verified: perFixture.filter((f) => f.verified).length,
    per_fixture: perFixture,
  };
}
