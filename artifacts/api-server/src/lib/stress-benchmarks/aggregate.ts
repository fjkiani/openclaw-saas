/**
 * aggregate.ts — On-the-fly aggregations over the stress corpus.
 *
 * All functions are pure and operate on the in-memory rows returned by
 * runStore.loadRuns(). Aggregations are cheap for the current corpus size
 * (909 rows) — recomputed per request. If the corpus grows past ~50k rows,
 * precompute and cache these per-model / per-category rollups.
 */
import type {
  CategoryBreakdown,
  DomainBreakdown,
  FailureClassBreakdown,
  LeaderboardEntry,
  RunsPage,
  RunsQuery,
  StressRun,
  StressSummary,
} from "./types.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[idx] * 100) / 100;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * pass@k for a set of attempts, computed as: probability that at least one of
 * k attempts passes, given the observed pass rate. Uses the standard
 * unbiased pass@k estimator (Chen et al., HumanEval 2021):
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 * where n = total attempts, c = correct attempts.
 * For k >= n, returns c/n * 1 (or 1 if any passed).
 */
function passAtK(passed: number, total: number, k: number): number {
  if (total === 0) return 0;
  if (k >= total) return passed > 0 ? 1 : 0;
  const n_minus_c = total - passed;
  if (n_minus_c < k) return 1;
  // 1 - prod(i=0..k-1) (n_minus_c - i) / (n - i)
  let prod = 1;
  for (let i = 0; i < k; i++) {
    prod *= (n_minus_c - i) / (total - i);
  }
  return 1 - prod;
}

export function leaderboard(runs: StressRun[]): LeaderboardEntry[] {
  const byModel = new Map<string, StressRun[]>();
  for (const r of runs) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const out: LeaderboardEntry[] = [];
  for (const [model, rows] of byModel.entries()) {
    const passed = rows.filter((r) => r.passed).length;
    const latencies = rows.map((r) => r.latency_ms);
    out.push({
      model,
      n_runs: rows.length,
      pass_rate: rows.length ? passed / rows.length : 0,
      pass_at_1_mean: passAtK(passed, rows.length, 1),
      pass_at_3_mean: passAtK(passed, rows.length, 3),
      pass_at_5_mean: passAtK(passed, rows.length, 5),
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
    });
  }
  return out.sort((a, b) => b.pass_rate - a.pass_rate || a.p50_ms - b.p50_ms);
}

export function categoryBreakdown(runs: StressRun[]): CategoryBreakdown[] {
  const byCat = new Map<string, StressRun[]>();
  for (const r of runs) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  return [...byCat.entries()]
    .map(([category, rows]) => {
      const passed = rows.filter((r) => r.passed).length;
      const latencies = rows.map((r) => r.latency_ms);
      return {
        category,
        n_runs: rows.length,
        n_passed: passed,
        pass_rate: rows.length ? passed / rows.length : 0,
        p50_ms: percentile(latencies, 50),
        p95_ms: percentile(latencies, 95),
      };
    })
    .sort((a, b) => b.n_runs - a.n_runs);
}

export function domainBreakdown(runs: StressRun[]): DomainBreakdown[] {
  const byDomain = new Map<string, StressRun[]>();
  for (const r of runs) {
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }
  return [...byDomain.entries()]
    .map(([domain, rows]) => {
      const passed = rows.filter((r) => r.passed).length;
      return {
        domain,
        n_runs: rows.length,
        n_passed: passed,
        pass_rate: rows.length ? passed / rows.length : 0,
      };
    })
    .sort((a, b) => b.n_runs - a.n_runs);
}

export function failureClassBreakdown(runs: StressRun[]): FailureClassBreakdown[] {
  const failed = runs.filter((r) => !r.passed);
  if (failed.length === 0) return [];
  const byClass = new Map<string, number>();
  for (const r of failed) {
    const cls = r.failure_class || "unknown";
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
  }
  return [...byClass.entries()]
    .map(([failure_class, count]) => ({
      failure_class,
      count,
      share: count / failed.length,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface SummaryOpts {
  provenance: StressSummary["provenance"];
}

export function summary(runs: StressRun[], opts: SummaryOpts): StressSummary {
  const models = new Set(runs.map((r) => r.model));
  const categories = new Set(runs.map((r) => r.category));
  const domains = new Set(runs.map((r) => r.domain));
  return {
    n_runs: runs.length,
    n_models: models.size,
    n_categories: categories.size,
    n_domains: domains.size,
    provenance: opts.provenance,
    leaderboard: leaderboard(runs),
    categories: categoryBreakdown(runs),
    domains: domainBreakdown(runs),
    failure_classes: failureClassBreakdown(runs),
  };
}

/**
 * Filtered + paginated runs.
 */
export function queryRuns(all: StressRun[], q: RunsQuery): RunsPage {
  let filtered = all;
  if (q.model) filtered = filtered.filter((r) => r.model === q.model);
  if (q.category) filtered = filtered.filter((r) => r.category === q.category);
  if (q.domain) filtered = filtered.filter((r) => r.domain === q.domain);
  if (q.perturbation_id) filtered = filtered.filter((r) => r.perturbation_id === q.perturbation_id);
  if (typeof q.passed === "boolean") filtered = filtered.filter((r) => r.passed === q.passed);

  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    limit,
    offset,
    runs: page,
  };
}

/**
 * Distinct models/categories/domains for facet UIs.
 */
export function facets(runs: StressRun[]): {
  models: string[];
  categories: string[];
  domains: string[];
  perturbations: string[];
} {
  const s = <K extends keyof StressRun>(k: K) =>
    [...new Set(runs.map((r) => String(r[k])))].sort();
  return {
    models: s("model"),
    categories: s("category"),
    domains: s("domain"),
    perturbations: s("perturbation_id"),
  };
}
