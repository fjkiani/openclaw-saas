import { runBenchmark } from "../../src/lib/rigor/benchmark.js";
import { writeFileSync } from "node:fs";

(async () => {
  const m = await runBenchmark();
  console.log("=== Rigor-Gate benchmark (mode:" + m.mode + ") ===");
  console.log("n_fixtures:", m.n_fixtures, " n_verified (no dry fallback):", m.n_verified);
  console.log("overall recall (slop-rejection):", m.overall.slop_rejection_rate);
  console.log("overall false-reject:", m.overall.false_reject_rate);
  console.log("materiality-catch:", m.materiality_catch_rate);
  console.log("numerical-mismatch-catch:", m.numerical_mismatch_catch_rate);
  console.log("baseline self-judge recall:", m.baseline_self_judge.slop_rejection_rate);
  console.log("baseline self-judge false-reject:", m.baseline_self_judge.false_reject_rate);
  console.log("latency mean/p50/max ms:", m.latency_ms.mean, m.latency_ms.p50, m.latency_ms.max);
  console.log("per-guardian:", JSON.stringify(m.by_guardian));
  console.log("per-mode:", JSON.stringify(m.by_mode));
  const wrong = m.per_fixture.filter((f) => !f.correct);
  console.log("MISLABELED/INCORRECT (" + wrong.length + "):");
  for (const w of wrong)
    console.log(
      "  XX",
      w.id,
      w.mode,
      "label=" + w.label,
      "panel_pass=" + w.panel_pass,
      "verified=" + w.verified,
      "failing=[" + w.failing.join(",") + "]",
      "score=" + w.score,
    );
  if (wrong.length === 0) console.log("  (none — all fixture labels match panel verdicts)");
  const unverified = m.per_fixture.filter((f) => !f.verified);
  if (unverified.length > 0)
    console.log(
      "WARNING — UNVERIFIED (dry fallback) fixtures:",
      unverified.map((f) => f.id).join(","),
      "-> accuracy numbers CONTAMINATED",
    );
  const out = process.env.BENCH_OUT || "/workspace/bench_live_results.json";
  writeFileSync(out, JSON.stringify(m, null, 2));
  console.log("wrote full metrics ->", out);
})();
