/**
 * bench/rigorAudit.ts — audit of the benchmark's own methodology.
 *
 * Answers three questions the headline numbers do not:
 *   A. WHY is the LLM-judge rubric excluded from the offline score? Measure the rubric-included
 *      offline run and show what it actually produces, instead of asserting the reason.
 *   B. Does the panel genuinely need every guardian, or is one doing all the work? Ablate each
 *      guardian and measure the recall it is solely responsible for.
 *   C. How deep is the defense-in-depth? Count, per slop fixture, how many independent guardians
 *      caught it — a fixture caught by exactly one guardian has no redundancy.
 *
 * This replaces the hand-written self-grade baseline as the evidence for the panel's value. That
 * stub was a lower-bound illustration, not a measured judge; ablation is measured.
 */

import { allFixtures } from "./fixtures.js";
import { registerAllDomains } from "../registerAll.js";
import { verify } from "../verificationCore.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out";

export interface Conf { tp: number; fn: number; tn: number; fp: number; }
const emptyConf = (): Conf => ({ tp: 0, fn: 0, tn: 0, fp: 0 });
const recall = (c: Conf) => (c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn));
const frr = (c: Conf) => (c.fp + c.tn === 0 ? 0 : c.fp / (c.fp + c.tn));

export interface FixtureOutcome {
  id: string;
  domain: string;
  label: string;
  verdict: string;
  verified: boolean;
  failed_guardians: string[];   // guardians that returned a substantive "fail"
  degraded_guardians: string[]; // guardians that could not check at all
}

export interface PanelScore {
  conf: Conf;
  recall: number;
  false_reject_rate: number;
  /** fixtures the gate itself flagged as not-verifiable (verified === false) */
  n_unverifiable: number;
  /** fixtures with at least one substantive guardian failure (a real, located defect) */
  n_substantive_fail: number;
  outcomes: FixtureOutcome[];
}

export async function scorePanel(exclude: string[]): Promise<PanelScore> {
  const fixtures = allFixtures();
  const conf = emptyConf();
  const outcomes: FixtureOutcome[] = [];
  let n_unverifiable = 0;
  let n_substantive_fail = 0;

  for (const f of fixtures) {
    const v = await verify(f.domain, f.raw, { live: false, exclude });
    const failed = v.per_guardian.filter((g) => g.status === "fail").map((g) => g.guardian);
    const degraded = v.per_guardian.filter((g) => g.status === "degraded").map((g) => g.guardian);
    if (!v.verified) n_unverifiable++;
    if (failed.length) n_substantive_fail++;

    const rejected = v.verdict === "FAIL";
    if (f.label === "slop") { if (rejected) conf.tp++; else conf.fn++; }
    else { if (rejected) conf.fp++; else conf.tn++; }

    outcomes.push({
      id: f.id, domain: f.domain, label: f.label,
      verdict: v.verdict, verified: v.verified,
      failed_guardians: failed, degraded_guardians: degraded,
    });
  }
  return { conf, recall: recall(conf), false_reject_rate: frr(conf), n_unverifiable, n_substantive_fail, outcomes };
}

/** Runs the full methodology audit and returns the report. No file writes, no console output. */
export async function runAudit() {
  registerAllDomains();

  // ── A. rubric INCLUDED, offline (no model key) ─────────────────────────────
  const withRubric = await scorePanel([]);
  // ── the published configuration: deterministic guardians only ──────────────
  const deterministic = await scorePanel(["rubric"]);

  // ── B. ablation over the deterministic panel ───────────────────────────────
  // Ablate every guardian that appears in a deterministic panel run, including ones that never
  // fired, so a guardian contributing nothing would show up as a 0-point drop rather than be skipped.
  const allNames = new Set<string>();
  for (const f of allFixtures()) {
    const v = await verify(f.domain, f.raw, { live: false, exclude: ["rubric"] });
    for (const g of v.per_guardian) allNames.add(g.guardian);
  }
  const ablationTargets = [...allNames].sort();

  const ablation: Array<{
    removed: string;
    recall: number;
    false_reject_rate: number;
    recall_drop: number;
    newly_missed: string[];
  }> = [];

  for (const g of ablationTargets) {
    const s = await scorePanel(["rubric", g]);
    const missedNow = new Set(s.outcomes.filter((o) => o.label === "slop" && o.verdict === "PASS").map((o) => o.id));
    const missedBefore = new Set(deterministic.outcomes.filter((o) => o.label === "slop" && o.verdict === "PASS").map((o) => o.id));
    const newly = [...missedNow].filter((id) => !missedBefore.has(id)).sort();
    ablation.push({
      removed: g,
      recall: s.recall,
      false_reject_rate: s.false_reject_rate,
      recall_drop: deterministic.recall - s.recall,
      newly_missed: newly,
    });
  }

  // ── C. redundancy depth on slop fixtures ───────────────────────────────────
  const slop = deterministic.outcomes.filter((o) => o.label === "slop");
  const depthHist: Record<string, number> = {};
  for (const o of slop) {
    const k = String(o.failed_guardians.length);
    depthHist[k] = (depthHist[k] ?? 0) + 1;
  }
  const soleCatch: Record<string, string[]> = {};
  for (const o of slop) {
    if (o.failed_guardians.length === 1) {
      const g = o.failed_guardians[0]!;
      (soleCatch[g] ??= []).push(o.id);
    }
  }

  const nFixtures = withRubric.conf.tp + withRubric.conf.fn + withRubric.conf.tn + withRubric.conf.fp;
  const keysAvailable = Boolean(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
  const report = {
    generated_at: new Date().toISOString(),
    note:
      "Audit of benchmark methodology. Panel A deliberately runs the rubric guardian with the live path DISABLED, " +
      "to show what the gate does when the judge cannot be reached: every rubric result is 'degraded' (could-not-check), " +
      "never a simulated pass. The live rubric is measured separately in bench/rubricCalibration.ts. " +
      (keysAvailable
        ? "Model API keys WERE present in this environment, so panel A is a forced-degraded control, not a limitation."
        : "No model API key was available in this environment, so the live rubric could not be exercised at all."),
    keys_available: keysAvailable,
    n_fixtures: nFixtures,
    rubric_included_offline: {
      confusion: withRubric.conf,
      recall: withRubric.recall,
      false_reject_rate: withRubric.false_reject_rate,
      n_unverifiable: withRubric.n_unverifiable,
      n_substantive_fail: withRubric.n_substantive_fail,
      interpretation:
        "With the rubric in the panel and no key, every fixture is FAIL and verified=false. Recall is a vacuous 100% because clean fixtures are rejected too. This is why the offline score is computed on the deterministic subset the gate can actually verify.",
    },
    deterministic_panel: {
      confusion: deterministic.conf,
      recall: deterministic.recall,
      false_reject_rate: deterministic.false_reject_rate,
      n_unverifiable: deterministic.n_unverifiable,
      n_substantive_fail: deterministic.n_substantive_fail,
    },
    ablation,
    redundancy: {
      depth_histogram_slop: depthHist,
      sole_catch_by_guardian: soleCatch,
      n_slop_with_single_catcher: slop.filter((o) => o.failed_guardians.length === 1).length,
      n_slop: slop.length,
    },
  };

  return report;
}

async function main() {
  const report = await runAudit();
  const withRubric = { ...report.rubric_included_offline, conf: report.rubric_included_offline.confusion };
  const deterministic = { ...report.deterministic_panel, conf: report.deterministic_panel.confusion };
  const ablation = report.ablation;
  const depthHist = report.redundancy.depth_histogram_slop;
  const soleCatch = report.redundancy.sole_catch_by_guardian;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/rigor_audit.json`, JSON.stringify(report, null, 2));

  // ── console ──
  console.log("=========== A. WHY THE RUBRIC IS EXCLUDED OFFLINE ===========");
  console.log(`  rubric INCLUDED, no key:  TP=${withRubric.conf.tp} FN=${withRubric.conf.fn} TN=${withRubric.conf.tn} FP=${withRubric.conf.fp}`);
  console.log(`     recall = ${(withRubric.recall * 100).toFixed(1)}%  false-reject = ${(withRubric.false_reject_rate * 100).toFixed(1)}%   <-- vacuous`);
  const nAll = report.n_fixtures;
  console.log(`     gate flagged ${withRubric.n_unverifiable}/${nAll} as NOT verifiable (verified=false); only ${withRubric.n_substantive_fail}/${nAll} had a located defect`);
  console.log(`  deterministic only:       TP=${deterministic.conf.tp} FN=${deterministic.conf.fn} TN=${deterministic.conf.tn} FP=${deterministic.conf.fp}`);
  console.log(`     recall = ${(deterministic.recall * 100).toFixed(1)}%  false-reject = ${(deterministic.false_reject_rate * 100).toFixed(1)}%`);

  console.log("\n=========== B. ABLATION (remove one guardian) ===========");
  for (const a of ablation) {
    const drop = a.recall_drop * 100;
    console.log(`  without ${a.removed.padEnd(17)} recall ${(a.recall * 100).toFixed(1).padStart(5)}%  (drop ${drop.toFixed(1).padStart(4)} pts)  FRR ${(a.false_reject_rate * 100).toFixed(1)}%`);
    if (a.newly_missed.length) console.log(`      slop that escapes: ${a.newly_missed.join(", ")}`);
  }

  console.log("\n=========== C. DEFENSE-IN-DEPTH DEPTH (slop only) ===========");
  for (const k of Object.keys(depthHist).sort()) {
    console.log(`  caught by exactly ${k} guardian(s): ${depthHist[k]} fixture(s)`);
  }
  console.log(`  slop with only ONE catcher: ${report.redundancy.n_slop_with_single_catcher}/${report.redundancy.n_slop} (no redundancy for these)`);
  for (const [g, ids] of Object.entries(soleCatch)) {
    console.log(`     ${g}: sole catcher for ${ids.length} (${ids.join(", ")})`);
  }
  console.log(`\nwrote ${OUT}/rigor_audit.json`);
}

// CLI entry only: guarded so the test suite can import runAudit() without triggering a file write.
if ((process.argv[1] ?? "").includes("rigorAudit")) {
  main().catch((e) => { console.error("AUDIT ERROR:", e); process.exit(1); });
}
