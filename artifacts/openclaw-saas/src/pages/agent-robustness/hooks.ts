/**
 * hooks.ts — TanStack Query bindings for /api/stress-benchmarks/*
 *
 * All queries are read-only and idempotent. The corpus is baked at build
 * time (see api-server/corpus/stress-benchmarks/PROVENANCE.md), so a
 * generous staleTime is safe.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

const STALE_MS = 5 * 60 * 1000; // 5 min

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface StressHealth {
  ok: boolean;
  n_runs: number;
  runs_path: string;
  loaded_at: string | null;
  error?: string;
}

export interface StressLeaderboardEntry {
  model: string;
  n_runs: number;
  pass_rate: number;
  pass_at_1_mean: number;
  pass_at_3_mean: number;
  pass_at_5_mean: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface StressCategory {
  category: string;
  n_runs: number;
  n_passed: number;
  pass_rate: number;
  p50_ms: number;
  p95_ms: number;
}

export interface StressDomain {
  domain: string;
  n_runs: number;
  n_passed: number;
  pass_rate: number;
}

export interface StressFailureClass {
  failure_class: string;
  count: number;
  share: number;
}

export interface StressSummary {
  n_runs: number;
  n_models: number;
  n_categories: number;
  n_domains: number;
  provenance: {
    source_repo: string;
    branch: string;
    commit: string;
    generated_at: string;
  };
  leaderboard: StressLeaderboardEntry[];
  categories: StressCategory[];
  domains: StressDomain[];
  failure_classes: StressFailureClass[];
}

export interface StressRun {
  worker_id: string;
  category: string;
  perturbation_id: string;
  task: string;
  domain: string;
  model: string;
  run_id: number;
  passed: boolean;
  failure_class: string;
  evaluator: string;
  feedback: string;
  iterations: number;
  max_iterations: number;
  tool_calls: number;
  per_tool_calls: Array<{ tool: string; count: number }>;
  finish_reason: string;
  token_usage: { prompt: number; completion: number; total: number };
  latency_seconds: number;
  latency_ms: number;
  error: string | null;
  traceback: string | null;
  response_preview: string;
  timestamp: string;
}

export interface StressRunsPage {
  total: number;
  limit: number;
  offset: number;
  runs: StressRun[];
}

export interface StressFacets {
  models: string[];
  categories: string[];
  domains: string[];
  perturbations: string[];
}

export function useStressHealth() {
  return useQuery({
    queryKey: ["stress", "health"],
    queryFn: () => getJson<StressHealth>("/api/stress-benchmarks/health"),
    staleTime: STALE_MS,
  });
}

export function useStressSummary() {
  return useQuery({
    queryKey: ["stress", "summary"],
    queryFn: () => getJson<StressSummary>("/api/stress-benchmarks/summary"),
    staleTime: STALE_MS,
  });
}

export function useStressFacets() {
  return useQuery({
    queryKey: ["stress", "facets"],
    queryFn: () => getJson<StressFacets>("/api/stress-benchmarks/facets"),
    staleTime: STALE_MS,
  });
}

export interface RunsFilters {
  category?: string;
  model?: string;
  domain?: string;
  perturbation_id?: string;
  passed?: boolean;
  limit?: number;
  offset?: number;
}

export function useStressRuns(filters: RunsFilters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return useQuery({
    queryKey: ["stress", "runs", filters],
    queryFn: () =>
      getJson<StressRunsPage>(
        `/api/stress-benchmarks/runs${qs ? `?${qs}` : ""}`,
      ),
    staleTime: STALE_MS,
  });
}
