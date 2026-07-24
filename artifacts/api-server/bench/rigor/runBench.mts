import { runBenchmark } from "../../src/lib/rigor/benchmark.js";

(async () => {
  const m = await runBenchmark();
  console.log("=== Rigor-Gate benchmark (mode:" + m.mode + ") ===");
  console.log("n_fixtures:", m.n_fixtures);
  console.log("overall recall (slop-rejection):", m.overall.slop_rejection_rate);
  console.log("overall false-reject:", m.overall.false_reject_rate);
  console.log("materiality-catch:", m.materiality_catch_rate);
  console.log("numerical-mismatch-catch:", m.numerical_mismatch_catch_rate);
  console.log("baseline self-judge recall:", m.baseline_self_judge.slop_rejection_rate);
  console.log("latency mean/p50/max ms:", m.latency_ms.mean, m.latency_ms.p50, m.latency_ms.max);
  const wrong = m.per_fixture.filter((f) => !f.correct);
  console.log("MISLABELED/INCORRECT (" + wrong.length + "):");
  for (const w of wrong) console.log("  XX", w.id, w.mode, "label=" + w.label, "panel_pass=" + w.panel_pass, "failing=[" + w.failing.join(",") + "]", "score=" + w.score);
  if (wrong.length === 0) console.log("  (none — all fixture labels match panel verdicts)");
})();
