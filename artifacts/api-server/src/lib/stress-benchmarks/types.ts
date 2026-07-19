/**
 * types.ts — Agent Robustness Benchmarks (stress-benchmarks) shared types
 *
 * Mirrors the JSONL schema emitted by mcp-universe-benchmarks stress harness.
 * Source repo: github.com/fjkiani/mcp-universe-benchmarks
 * Source branch/commit: sprint-4-stress-suite @ d1e22ab
 *
 * This module and its sibling files replace the (dead) external
 * openclaw-benchmark FastAPI service for the "Agent Robustness" domain.
 * Data is loaded from a JSONL corpus committed alongside the API server.
 */

export type StressCategory =
  | "baseline"
  | "concurrency"
  | "adversarial"
  | "faults"
  | "ratelimit";

export interface StressTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StressPerToolCall {
  tool: string;
  count: number;
}

/**
 * One row of the stress-benchmark JSONL corpus.
 * Exactly the fields the harness writes; keep in lockstep with
 * mcp-universe-benchmarks/scripts/stress.py.
 */
export interface StressRun {
  worker_id: string;
  category: StressCategory | string;
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
  per_tool_calls: StressPerToolCall[];
  finish_reason: string;
  token_usage: StressTokenUsage;
  latency_seconds: number;
  latency_ms: number;
  error: string | null;
  traceback: string | null;
  response_preview: string;
  timestamp: string;
}

export interface LeaderboardEntry {
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

export interface CategoryBreakdown {
  category: string;
  n_runs: number;
  n_passed: number;
  pass_rate: number;
  p50_ms: number;
  p95_ms: number;
}

export interface DomainBreakdown {
  domain: string;
  n_runs: number;
  n_passed: number;
  pass_rate: number;
}

export interface FailureClassBreakdown {
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
  leaderboard: LeaderboardEntry[];
  categories: CategoryBreakdown[];
  domains: DomainBreakdown[];
  failure_classes: FailureClassBreakdown[];
}

export interface RunsQuery {
  model?: string;
  category?: string;
  domain?: string;
  perturbation_id?: string;
  passed?: boolean;
  limit?: number;
  offset?: number;
}

export interface RunsPage {
  total: number;
  limit: number;
  offset: number;
  runs: StressRun[];
}
