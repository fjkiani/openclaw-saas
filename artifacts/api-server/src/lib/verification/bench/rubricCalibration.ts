/**
 * bench/rubricCalibration.ts — is the LLM rubric a usable pass/fail instrument at all?
 *
 * The rubric guardian ships with minScore 0.8 and axisFloor 0.5. Those numbers were chosen by
 * assertion, not measurement, and a live run showed a clean fixture scoring 0.70 — so the guardian
 * rejects correct output. Hand-tuning the threshold until the benchmark looks good would be fitting
 * the instrument to the test set, so instead this measures two things and reports them whichever
 * way they fall:
 *
 *   1. THRESHOLD SWEEP — score every rubric-domain fixture live, then sweep minScore across the
 *      full range and compute (recall, false-reject rate) at each cut. If no cut gives usable
 *      numbers, the rubric cannot carry a fail-closed verdict at any threshold, and the correct
 *      engineering decision is to keep it out of the verdict rather than to retune it.
 *
 *   2. RUN-TO-RUN VARIANCE — repeat the identical scoring pass REPS times at temperature 0. Any
 *      spread is pure instrument noise: same input, same prompt, same temperature. This is the
 *      measured basis for preferring deterministic checks, replacing the assertion that
 *      deterministic checks are more reproducible.
 *
 * COVERAGE IS PART OF THE RESULT, NOT A PRECONDITION. Free judge tiers cap requests and tokens per
 * DAY, so a run can return a handful of usable scores and dozens of degraded ones. A sweep computed
 * over four surviving fixtures is not a calibration, and quoting its "best cut" would be the same
 * error as hand-tuning. So the report carries an explicit coverage fraction, suppresses `best_cut`
 * when coverage is below COVERAGE_FLOOR, and says so in `findings`. Likewise, if no fixture returned
 * two or more usable scores, variance is reported as UNMEASURED rather than as agreement.
 *
 * mcp_server has no rubric guardian, so its fixtures are skipped rather than counted as passes.
 *
 * Run (live, spends judge quota):
 *   RIGOR_OUT=/path RUBRIC_REPS=3 node_modules/.bin/tsx src/lib/verification/bench/rubricCalibration.ts
 *
 * Re-derive sweep/variance/findings from an existing artifact's stored scores, no network at all —
 * used to correct report text without spending quota and without inventing numbers:
 *   RUBRIC_RESCORE_FROM=/path/rubric_calibration.json node_modules/.bin/tsx .../rubricCalibration.ts
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { allFixtures, type Fixture } from "./fixtures.js";
import { registerAllDomains } from "../registerAll.js";
import { verify, getDomain } from "../verificationCore.js";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out";
const REPS = Number(process.env.RUBRIC_REPS ?? 3);
const PACE_MS = Number(process.env.RUBRIC_PACE_MS ?? 150);
/** Free-tier judges are rate-limited on rolling AND daily budgets, so a single attempt understates
 *  what a production caller would see. Retry with backoff, and report BOTH rates. */
const MAX_ATTEMPTS = Number(process.env.RUBRIC_ATTEMPTS ?? 3);
/** 0 = repeat every fixture; N = repeat only a stratified sample of N (see varianceSubsample). */
const VARIANCE_N = Number(process.env.RUBRIC_VARIANCE_N ?? 0);
const BACKOFF_MS = [2000, 6000, 12000];
/** Re-derive from stored scores instead of calling any model. */
const RESCORE_FROM = process.env.RUBRIC_RESCORE_FROM || "";

/**
 * Minimum fraction of rubric fixtures that must produce a usable rep-0 score before the sweep is
 * treated as a calibration rather than an anecdote. 0.9 is a judgement call, stated here so a reader
 * can disagree with it explicitly instead of discovering it implied by a suppressed field.
 */
const COVERAGE_FLOOR = Number(process.env.RUBRIC_COVERAGE_FLOOR ?? 0.9);

/**
 * The judge fallback chain as shipped: 6 model entries, but only 3 upstream accounts behind them
 * (groq, openrouter, google). The four OpenRouter keys resolve to ONE account with ONE shared
 * per-day allowance — measured in bench/quotaProbe.ts, where all three probed OpenRouter keys
 * returned the identical `X-RateLimit-Remaining: 0`. Chain length is therefore not chain
 * independence, and availability findings must quote accounts, not keys.
 */
const CHAIN_DESCRIPTION = "6-entry fallback chain spanning only 3 upstream accounts (groq, openrouter, google)";

interface RubricScore {
  fixture: string;
  domain: string;
  label: "clean" | "slop";
  rep: number;
  overall: number | null;
  min_axis: number | null;
  axes: Record<string, number>;
  model: string;
  status: string;
  /** Guardian reason line — carries the router failure text when status is degraded. */
  reason: string;
  latency_ms: number;
  attempts: number;
}

interface SweepPoint {
  min_score: number;
  tp: number;
  fn: number;
  tn: number;
  fp: number;
  recall: number;
  false_reject_rate: number;
}

export interface RubricCalibrationReport {
  generated_at: string;
  /** "live" = scores came from model calls in this process; "rescored" = re-derived from an artifact. */
  mode: "live" | "rescored";
  /** Set when mode is "rescored": which artifact the scores were read from. */
  source_artifact: string | null;
  reps: number;
  n_fixtures_scored: number;
  /** Fixture ids that received repeat calls for the reproducibility estimate. */
  variance_subsample: string[];
  n_degraded: number;
  n_first_attempt_failures: number;
  max_attempts: number;
  shipped_defaults: { min_score: number; axis_floor: number };
  scores: RubricScore[];
  /** Sweep uses rep 0 only, so the sweep is not averaged over noise it is trying to characterise. */
  sweep: SweepPoint[];
  /** Usable rep-0 scores actually behind the sweep. */
  n_scored_rep0: number;
  /** n_scored_rep0 / n_fixtures_scored. */
  sweep_coverage: number;
  /** True when sweep_coverage < COVERAGE_FLOOR: the sweep is an anecdote, not a calibration. */
  sweep_underpowered: boolean;
  coverage_floor: number;
  /** Null whenever the sweep is underpowered, even if a zero-false-reject cut exists in the data. */
  best_cut: { min_score: number; recall: number; false_reject_rate: number } | null;
  /** Why best_cut was withheld, or null if it was not withheld. */
  best_cut_suppressed_reason: string | null;
  variance: {
    /** Fixtures with a usable score in EVERY rep. */
    n_fixtures_with_all_reps: number;
    /** Fixtures with >= 2 usable scores — the set variance is actually computed over. */
    n_fixtures_with_repeats: number;
    /** True when no fixture returned >= 2 usable scores: variance is unmeasured, not zero. */
    unmeasured: boolean;
    max_spread: number;
    mean_spread: number;
    n_fixtures_spread_gt_0: number;
    n_verdict_flips: number;
    flipped: string[];
    per_fixture: Array<{ fixture: string; scores: number[]; reps_usable: number; spread: number }>;
  };
  findings: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fixtures whose domain panel actually contains a rubric guardian. */
export function rubricFixtures(): Fixture[] {
  registerAllDomains();
  return allFixtures().filter((f) => {
    const d = getDomain(f.domain);
    return Boolean(d && d.guardians.some((g) => g.name === "rubric"));
  });
}

/**
 * Choose which fixtures get repeat calls.
 *
 * Rep 0 always covers every rubric fixture, because the threshold sweep needs full coverage. The
 * repeat reps only exist to measure temperature-0 reproducibility, and that does not need the whole
 * corpus — free model tiers cap requests per day, and spending the budget on redundant repeats
 * costs sweep coverage. RUBRIC_VARIANCE_N picks a deterministic round-robin sample stratified by
 * (domain, label) so the variance estimate is not drawn from one domain. 0 means "repeat all".
 */
export function varianceSubsample(fixtures: Fixture[], n: number): string[] {
  if (n <= 0 || n >= fixtures.length) return fixtures.map((f) => f.id);
  const groups = new Map<string, Fixture[]>();
  for (const f of [...fixtures].sort((a, b) => a.id.localeCompare(b.id))) {
    const k = `${f.domain}:${f.label}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const keys = [...groups.keys()].sort();
  const picked: string[] = [];
  for (let i = 0; picked.length < n; i++) {
    let advanced = false;
    for (const k of keys) {
      const arr = groups.get(k)!;
      if (i < arr.length && picked.length < n) { picked.push(arr[i]!.id); advanced = true; }
    }
    if (!advanced) break;
  }
  return picked;
}

interface DeriveMeta {
  mode: "live" | "rescored";
  source_artifact: string | null;
  reps: number;
  max_attempts: number;
  n_fixtures_scored: number;
  coverage_floor: number;
}

/**
 * Everything downstream of the model calls: sweep, variance, coverage guard, findings.
 *
 * Pure in `scores` so the identical derivation runs on a fresh live pass and on stored scores read
 * back from disk. That is what makes RUBRIC_RESCORE_FROM safe: corrected report text comes from
 * re-deriving over the same recorded numbers, never from re-asserting a conclusion by hand.
 */
export function deriveReport(scores: RubricScore[], meta: DeriveMeta): RubricCalibrationReport {
  const { reps, max_attempts, n_fixtures_scored, coverage_floor } = meta;

  const degraded = scores.filter((s) => s.status === "degraded").length;
  // attempts > 1 happens only when attempt 0 came back degraded, so this reconstructs the live
  // counter exactly rather than approximating it.
  const firstAttemptFailures = scores.filter((s) => s.attempts > 1).length;
  const varianceIds = [...new Set(scores.filter((s) => s.rep >= 1).map((s) => s.fixture))].sort();

  // ── threshold sweep on rep 0 ────────────────────────────────────────────────
  const rep0 = scores.filter((s) => s.rep === 0 && s.overall != null);
  const sweep: SweepPoint[] = [];
  for (let cut = 0; cut <= 1.0001; cut += 0.05) {
    const minScore = Number(cut.toFixed(2));
    let tp = 0, fn = 0, tn = 0, fp = 0;
    for (const s of rep0) {
      const rubricPass = (s.overall as number) >= minScore;
      if (s.label === "slop") rubricPass ? fn++ : tp++;
      else rubricPass ? tn++ : fp++;
    }
    sweep.push({
      min_score: minScore,
      tp, fn, tn, fp,
      recall: tp + fn ? tp / (tp + fn) : 0,
      false_reject_rate: tn + fp ? fp / (tn + fp) : 0,
    });
  }

  const coverage = n_fixtures_scored ? Number((rep0.length / n_fixtures_scored).toFixed(4)) : 0;
  const underpowered = coverage < coverage_floor;

  // Best cut = highest recall among cuts with zero false rejects; null if none exists.
  const zeroFp = sweep.filter((p) => p.false_reject_rate === 0 && p.tp + p.fn > 0);
  zeroFp.sort((a, b) => b.recall - a.recall || a.min_score - b.min_score);
  const rawBest = zeroFp.length
    ? { min_score: zeroFp[0]!.min_score, recall: zeroFp[0]!.recall, false_reject_rate: 0 }
    : null;
  const suppression = underpowered
    ? `withheld: only ${rep0.length}/${n_fixtures_scored} fixtures (${(coverage * 100).toFixed(1)}%) produced a usable ` +
      `rep-0 score, below the ${(coverage_floor * 100).toFixed(0)}% coverage floor. A cut chosen on this many fixtures ` +
      `is not a calibration and must not be shipped as one.`
    : null;
  const best = underpowered ? null : rawBest;

  // ── run-to-run variance ────────────────────────────────────────────────────
  // Grouped over USABLE scores only. A fixture whose repeat call came back degraded contributes
  // fewer than `reps` values, and counting it as agreement would turn an outage into a
  // reproducibility claim.
  const byFixture = new Map<string, number[]>();
  for (const s of scores) {
    if (s.overall == null) continue;
    const arr = byFixture.get(s.fixture) ?? [];
    arr.push(s.overall);
    byFixture.set(s.fixture, arr);
  }
  const per: Array<{ fixture: string; scores: number[]; reps_usable: number; spread: number }> = [];
  const flipped: string[] = [];
  let nAllReps = 0;
  for (const [fixture, arr] of byFixture) {
    if (arr.length >= reps) nAllReps++;
    if (arr.length < 2) continue;
    const spread = Number((Math.max(...arr) - Math.min(...arr)).toFixed(3));
    per.push({ fixture, scores: arr, reps_usable: arr.length, spread });
    // verdict flip at the SHIPPED default threshold
    const verdicts = new Set(arr.map((v) => v >= 0.8));
    if (verdicts.size > 1) flipped.push(fixture);
  }
  per.sort((a, b) => b.spread - a.spread || a.fixture.localeCompare(b.fixture));
  const spreads = per.map((p) => p.spread);
  const maxSpread = spreads.length ? Math.max(...spreads) : 0;
  const meanSpread = spreads.length ? Number((spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(4)) : 0;

  // ── findings ───────────────────────────────────────────────────────────────
  const findings: string[] = [];

  if (degraded > 0) {
    const sample = scores.find((s) => s.status === "degraded")?.reason ?? "";
    findings.push(
      `live-judge availability: ${firstAttemptFailures}/${scores.length} rubric calls failed on the first attempt and ` +
        `${degraded}/${scores.length} still failed after up to ${max_attempts} attempts with backoff, despite a ` +
        `${CHAIN_DESCRIPTION}. Fail-closed turns every one of those into a FAIL. Example: ${sample.slice(0, 300)}`,
    );
  } else {
    findings.push(
      `live-judge availability: all ${scores.length} rubric calls succeeded within ${max_attempts} attempts across a ${CHAIN_DESCRIPTION}.`,
    );
  }

  // Coverage guard comes BEFORE the sweep numbers so a reader hits the caveat first.
  if (underpowered) {
    findings.push(
      `SWEEP UNDERPOWERED — DO NOT USE TO PICK A THRESHOLD: the sweep below rests on ${rep0.length} usable rep-0 ` +
        `score(s) out of ${n_fixtures_scored} rubric fixtures (${(coverage * 100).toFixed(1)}% coverage, floor ` +
        `${(coverage_floor * 100).toFixed(0)}%). ${degraded} call(s) degraded, so the surviving fixtures are whichever ` +
        `ones happened to win a race against daily quota, not a sample chosen for balance. Every rate below is quoted ` +
        `over that residue; best_cut is withheld deliberately.`,
    );
  } else {
    findings.push(
      `sweep coverage: ${rep0.length}/${n_fixtures_scored} fixtures (${(coverage * 100).toFixed(1)}%) produced a usable rep-0 score.`,
    );
  }

  const shippedPoint = sweep.find((p) => p.min_score === 0.8);
  if (shippedPoint) {
    findings.push(
      `at the shipped minScore 0.8 the live rubric alone scores recall ${(shippedPoint.recall * 100).toFixed(1)}% ` +
        `and false-reject rate ${(shippedPoint.false_reject_rate * 100).toFixed(1)}% on ${rep0.length} scored fixture(s)` +
        `${underpowered ? " — an anecdote at this coverage, not a rate" : ""}.`,
    );
  }

  if (underpowered) {
    findings.push(
      `best_cut ${rawBest ? `(the data's own zero-false-reject point was minScore ${rawBest.min_score}, recall ` +
        `${(rawBest.recall * 100).toFixed(1)}%)` : "(no zero-false-reject cut existed even in the residue)"} is ` +
        `suppressed in this artifact. Reason: ${suppression}`,
    );
  } else {
    findings.push(
      best
        ? `a zero-false-reject cut does exist at minScore ${best.min_score}, where recall is ${(best.recall * 100).toFixed(1)}%.`
        : `NO threshold in [0,1] gives zero false rejects. The rubric cannot carry a fail-closed verdict at any cut on this set.`,
    );
  }

  if (per.length === 0) {
    findings.push(
      `temperature-0 reproducibility: UNMEASURED in this run. No fixture returned two or more usable scores ` +
        `(${varianceIds.length} fixture(s) were scheduled for repeat calls; the repeats degraded), so there is nothing to ` +
        `compare. This is an availability failure, not evidence of agreement — do not read it as either stability or noise.`,
    );
  } else {
    findings.push(
      maxSpread > 0
        ? `temperature-0 reproducibility: ${per.filter((p) => p.spread > 0).length}/${per.length} fixtures with >= 2 usable ` +
            `scores changed score across identical runs (max spread ${maxSpread}, mean ${meanSpread}); ${flipped.length} ` +
            `changed PASS/FAIL verdict at minScore 0.8. Measured over ${per.length} fixture(s) only.`
        : `temperature-0 reproducibility: all ${per.length} fixture(s) with >= 2 usable scores returned an identical score. ` +
            `Small n — this bounds the noise loosely, it does not establish determinism.`,
    );
  }

  return {
    generated_at: new Date().toISOString(),
    mode: meta.mode,
    source_artifact: meta.source_artifact,
    reps,
    n_fixtures_scored,
    variance_subsample: varianceIds,
    n_degraded: degraded,
    n_first_attempt_failures: firstAttemptFailures,
    max_attempts,
    shipped_defaults: { min_score: 0.8, axis_floor: 0.5 },
    scores,
    sweep,
    n_scored_rep0: rep0.length,
    sweep_coverage: coverage,
    sweep_underpowered: underpowered,
    coverage_floor,
    best_cut: best,
    best_cut_suppressed_reason: suppression,
    variance: {
      n_fixtures_with_all_reps: nAllReps,
      n_fixtures_with_repeats: per.length,
      unmeasured: per.length === 0,
      max_spread: maxSpread,
      mean_spread: meanSpread,
      n_fixtures_spread_gt_0: per.filter((p) => p.spread > 0).length,
      n_verdict_flips: flipped.length,
      flipped,
      per_fixture: per,
    },
    findings,
  };
}

export async function runRubricCalibration(): Promise<RubricCalibrationReport> {
  const fixtures = rubricFixtures();
  const varianceIds = new Set(varianceSubsample(fixtures, VARIANCE_N));
  const scores: RubricScore[] = [];

  for (let rep = 0; rep < REPS; rep++) {
    const repFixtures = rep === 0 ? fixtures : fixtures.filter((f) => varianceIds.has(f.id));
    for (const f of repFixtures) {
      // `only: ["rubric"]` isolates the judge: no deterministic guardian can mask or rescue it.
      const t0 = Date.now();
      let g: { status?: string; score?: number; reasons?: string[]; evidence?: Record<string, unknown> } | undefined;
      let attempts = 0;
      for (let a = 0; a < MAX_ATTEMPTS; a++) {
        attempts = a + 1;
        const v = await verify(f.domain, f.raw, { live: true, only: ["rubric"] });
        g = v.per_guardian.find((x) => x.guardian === "rubric");
        if (g?.status !== "degraded") break;
        if (a < MAX_ATTEMPTS - 1) await sleep(BACKOFF_MS[a] ?? 12000);
      }
      const latency = Date.now() - t0;
      const axes = (g?.evidence?.axisScores as Record<string, number>) ?? {};
      const axisVals = Object.values(axes).filter((n) => Number.isFinite(n));
      scores.push({
        fixture: f.id,
        domain: f.domain,
        label: f.label,
        rep,
        overall: typeof g?.score === "number" ? g.score : null,
        min_axis: axisVals.length ? Math.min(...axisVals) : null,
        axes,
        model: String(g?.evidence?.model_used ?? "none"),
        status: String(g?.status ?? "missing"),
        reason: String(g?.reasons?.[0] ?? ""),
        latency_ms: latency,
        attempts,
      });
      await sleep(PACE_MS);
    }
    console.log(`  rep ${rep + 1}/${REPS} done: ${repFixtures.length} fixtures (${scores.length} scores total)`);
  }

  return deriveReport(scores, {
    mode: "live",
    source_artifact: null,
    reps: REPS,
    max_attempts: MAX_ATTEMPTS,
    n_fixtures_scored: fixtures.length,
    coverage_floor: COVERAGE_FLOOR,
  });
}

/**
 * Re-derive the report from an artifact's stored `scores` with no network access.
 *
 * Fixture count is recomputed from the live corpus rather than copied, so a corpus that has grown
 * since the scoring run shows up as LOWER coverage instead of silently inheriting a stale
 * denominator. reps/max_attempts come from the source artifact because they describe how the stored
 * calls were made and cannot be recovered from the scores alone.
 */
export function rescoreFromFile(path: string): RubricCalibrationReport {
  const prior = JSON.parse(readFileSync(path, "utf8")) as Partial<RubricCalibrationReport>;
  const scores = prior.scores;
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error(`${path} has no stored scores array to re-derive from`);
  }
  const reps = Number(prior.reps ?? Math.max(...scores.map((s) => s.rep)) + 1);
  return deriveReport(scores, {
    mode: "rescored",
    source_artifact: path,
    reps,
    max_attempts: Number(prior.max_attempts ?? MAX_ATTEMPTS),
    n_fixtures_scored: rubricFixtures().length,
    coverage_floor: COVERAGE_FLOOR,
  });
}

if (process.argv[1] && process.argv[1].includes("rubricCalibration")) {
  (async () => {
    const report = RESCORE_FROM
      ? (console.log(`rubric calibration: RE-DERIVING from ${RESCORE_FROM} (no model calls)`), rescoreFromFile(RESCORE_FROM))
      : (console.log(`rubric calibration: ${REPS} reps, pacing ${PACE_MS}ms`), await runRubricCalibration());
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "rubric_calibration.json"), JSON.stringify(report, null, 2));
    console.log(
      `\nmode ${report.mode} | ${report.n_fixtures_scored} rubric fixtures | ${report.scores.length} calls | ` +
        `degraded ${report.n_degraded} | rep-0 usable ${report.n_scored_rep0} (coverage ${(report.sweep_coverage * 100).toFixed(1)}%)`,
    );
    console.log(`sweep_underpowered=${report.sweep_underpowered} best_cut=${JSON.stringify(report.best_cut)}`);
    console.log("\n min_score |  TP  FN  TN  FP | recall  FRR");
    for (const p of report.sweep) {
      if (p.min_score % 0.1 !== 0 && p.min_score !== 0.75 && p.min_score !== 0.85) continue;
      console.log(
        `   ${p.min_score.toFixed(2)}    | ${String(p.tp).padStart(3)} ${String(p.fn).padStart(3)} ${String(p.tn).padStart(3)} ${String(p.fp).padStart(3)} | ` +
          `${(p.recall * 100).toFixed(1).padStart(5)}% ${(p.false_reject_rate * 100).toFixed(1).padStart(5)}%`,
      );
    }
    console.log(`\nvariance over fixtures with >= 2 usable scores (unmeasured=${report.variance.unmeasured}):`);
    for (const p of report.variance.per_fixture.slice(0, 8)) {
      console.log(`  ${p.fixture.padEnd(26)} ${JSON.stringify(p.scores)} reps_usable=${p.reps_usable} spread=${p.spread}`);
    }
    console.log("");
    for (const f of report.findings) console.log(`FINDING: ${f}`);
    console.log(`\nwrote ${join(OUT, "rubric_calibration.json")}`);
  })();
}
