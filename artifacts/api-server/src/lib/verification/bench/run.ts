import { runBenchmark } from "./runBenchmark.js";
import { reconcile } from "../recon/reconcile.js";
import { RECON_INTAKES } from "./reconIntakes.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out"; // local disk first (S3 append/random-write unsafe)
mkdirSync(OUT, { recursive: true });

// Live mode is opt-in and requires a model key for the rubric guardian. With no key the rubric
// returns "degraded", and the fail-closed law then rejects clean output too (measured false-reject
// 77.8%) - see rigorAudit.ts. So offline is the default, and the exclusion is recorded in
// rubric_mode rather than hidden.
const LIVE = process.env.RIGOR_LIVE === "1";
// The two modes answer different questions and are both needed, so they write different files:
// the offline run is the deterministic panel on its own, the live run adds the LLM rubric on top.
// Writing both to one path would silently replace one measurement with the other.
const BENCH_FILE = LIVE ? "benchmark_multidomain_live.json" : "benchmark_multidomain.json";

async function main() {
  const bench = await runBenchmark({ live: LIVE });
  const recon = reconcile(RECON_INTAKES, 1.0);

  writeFileSync(`${OUT}/${BENCH_FILE}`, JSON.stringify(bench, null, 2));
  writeFileSync(`${OUT}/reconciliation_report.json`, JSON.stringify(recon, null, 2));

  // ── console summary ──
  console.log("========== MULTI-DOMAIN ANTI-SLOP BENCHMARK ==========");
  console.log(`rubric_mode: ${bench.rubric_mode} | live: ${bench.live}`);
  const o = bench.overall;
  console.log(`OVERALL  n=${o.n} clean=${o.n_clean} slop=${o.n_slop}  TP=${o.confusion.tp} FN=${o.confusion.fn} TN=${o.confusion.tn} FP=${o.confusion.fp}`);
  console.log(`  panel recall (caught slop)   = ${(o.recall * 100).toFixed(1)}%  (${o.confusion.tp}/${o.confusion.tp + o.confusion.fn})`);
  console.log(`  false-reject rate (clean)    = ${(o.false_reject_rate * 100).toFixed(1)}%  (${o.confusion.fp}/${o.confusion.fp + o.confusion.tn})`);
  console.log(`  self-grade STUB recall       = ${(bench.self_grade_baseline.recall * 100).toFixed(1)}%  (${bench.self_grade_baseline.tp}/${bench.self_grade_baseline.tp + bench.self_grade_baseline.fn})  <-- hand-written lower bound, NOT a measured LLM judge`);
  console.log(`  (measured per-guardian value: run bench/rigorAudit.ts for the ablation)`);
  console.log("\n-- per domain --");
  for (const d of bench.by_domain) {
    console.log(`  ${d.domain.padEnd(12)} recall=${(d.recall*100).toFixed(0)}% FRR=${(d.false_reject_rate*100).toFixed(0)}% (clean ${d.n_clean}/slop ${d.n_slop})`);
    for (const [g, s] of Object.entries(d.per_guardian_recall)) console.log(`      guardian ${g.padEnd(16)} recall ${(s.recall*100).toFixed(0)}% (${s.caught}/${s.of})`);
  }
  console.log("\n========== RECONCILIATION (OLD buildDraft vs NEW assembleFullTextV2) ==========");
  console.log(`  n=${recon.n}  exact=${recon.buckets.exactly_equal} equivalent=${recon.buckets.equivalent_formatted_differently} genuinely_different=${recon.buckets.genuinely_different}`);
  console.log(`  agreement_rate = ${(recon.agreement_rate*100).toFixed(1)}%  exact_rate = ${(recon.exact_rate*100).toFixed(1)}%`);
  console.log(`  cutover_recommended = ${recon.cutover_recommended} (threshold ${recon.cutover_threshold})`);
  if (recon.genuine_diffs.length) { console.log("  GENUINE DIFFS:"); recon.genuine_diffs.forEach(d => console.log(`    ${d.id}: ${d.detail}`)); }
  console.log("\nwrote:", `${OUT}/${BENCH_FILE}`, "and", `${OUT}/reconciliation_report.json`);
}
main().catch(e => { console.error("RUN ERROR:", e); process.exit(1); });
