/**
 * benchmarkStore.ts — In-process store for skill benchmark runs.
 *
 * Replaces the dead openclaw-benchmark.onrender.com external service.
 * Benchmark runs are keyed by benchmark_id (UUID) and stored in memory.
 * Results are also persisted to skill_benchmarks table in the DB.
 */

import { randomUUID } from "crypto";

export interface BenchmarkRun {
  benchmark_id: string;
  skill_id: number;
  skill_name: string;
  status: "running" | "completed" | "failed";
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE" | null;
  overall_score: number | null;
  level_scores: Record<string, unknown> | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

const store = new Map<string, BenchmarkRun>();

export function createBenchmarkRun(skillId: number, skillName: string): BenchmarkRun {
  const run: BenchmarkRun = {
    benchmark_id: randomUUID(),
    skill_id: skillId,
    skill_name: skillName,
    status: "running",
    grade: null,
    overall_score: null,
    level_scores: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
    error: null,
  };
  store.set(run.benchmark_id, run);
  return run;
}

export function updateBenchmarkRun(benchmarkId: string, update: Partial<BenchmarkRun>): void {
  const run = store.get(benchmarkId);
  if (run) Object.assign(run, update);
}

export function getBenchmarkRun(benchmarkId: string): BenchmarkRun | undefined {
  return store.get(benchmarkId);
}

/** Keep last 200 runs in memory */
export function pruneBenchmarkStore(): void {
  if (store.size > 200) {
    const oldest = [...store.keys()].slice(0, store.size - 200);
    oldest.forEach((k) => store.delete(k));
  }
}
