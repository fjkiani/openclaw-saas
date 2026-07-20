/**
 * hooks.ts — TanStack Query bindings for /api/v1/judge/*
 *
 * The intelligence plane is the LLM Judge + MCP benchmark + promotion gate
 * loop. All routes are read-mostly; benchmark and promote are mutations that
 * write evaluation_runs / gate rows on the server side.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

const STALE_MS = 30 * 1000;

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ── Judge summary + recent judgments ─────────────────────────────────────────

export interface JudgeSummary {
  overall: {
    total: number;
    verified: number;
    unverified: number;
    mean_margin: number | null;
  };
  per_domain: Array<{
    domain: string;
    n: number;
    verified: number;
    mean_chosen: number | null;
    mean_rejected: number | null;
    mean_margin: number | null;
  }>;
}

export interface JudgeRecentRow {
  id: string;
  domain: string;
  task_type: string;
  judge_score_chosen: number | null;
  judge_score_rejected: number | null;
  judge_reasoning: string | null;
  judge_run_id: number | null;
  judge_verified: boolean;
  updated_at: string | null;
}

export function useJudgeSummary() {
  return useQuery({
    queryKey: ["judge", "summary"],
    queryFn: () => getJson<{ ok: boolean; summary: JudgeSummary; recent: JudgeRecentRow[] }>("/api/v1/judge/summary"),
    staleTime: STALE_MS,
  });
}

export function useJudgeBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { domain?: string; limit?: number }) =>
      postJson<{ ok: boolean; scored_count: number; skipped: number; scored: unknown[] }>(
        "/api/v1/judge/pairs/batch",
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["judge"] });
    },
  });
}

// ── MCP benchmark ────────────────────────────────────────────────────────────

export interface BenchmarkTask {
  task: string;
  category: "handshake" | "list_tools" | "tool_call" | "safety";
  status: "pass" | "fail" | "timeout" | "error";
  latency_ms: number;
  detail?: string;
}

export interface BenchmarkResult {
  mcp_slug: string;
  mcp_url: string;
  transport: string;
  tool_correctness_pct: number;
  task_completion_pct: number;
  safety_pct: number;
  avg_latency_ms: number;
  n_tools_declared: number;
  n_tools_reachable: number;
  n_safety_blocks: number;
  n_safety_leaks: number;
  tasks: BenchmarkTask[];
  eval_run_id: number;
  dry: boolean;
}

export function useBenchmarkMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      mcpSlug: string;
      mcpUrl: string;
      declaredTools?: string[];
      tenantId?: string;
    }) => postJson<{ ok: boolean; result: BenchmarkResult }>("/api/v1/judge/benchmark-mcp", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["judge"] });
    },
  });
}

// ── Promotion gate ────────────────────────────────────────────────────────────

export interface PromotionRow {
  id: number;
  domain: string;
  task_type: string;
  candidate_model_id: string;
  baseline_model_id: string;
  eval_score: number | null;
  promoted: boolean;
  promotion_date: string | null;
  created_at: string;
}

export function usePromotions() {
  return useQuery({
    queryKey: ["judge", "promotions"],
    queryFn: () => getJson<{ ok: boolean; rows: PromotionRow[] }>("/api/v1/judge/promotions"),
    staleTime: STALE_MS,
  });
}

export interface PromotionDecision {
  domain: string;
  task_type: string;
  candidate_model_id: string;
  baseline_model_id: string;
  n_judged_pairs: number;
  win_rate_chosen: number;
  mean_score_chosen: number;
  mean_score_rejected: number;
  latest_mcp_bench?: {
    slug: string;
    safety_pct: number;
    task_completion_pct: number;
    tool_correctness_pct: number;
    n_safety_leaks: number;
    eval_run_id: number;
  };
  promoted: boolean;
  reason: string;
  gate_id: number;
}

export function useRunPromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      domain: string;
      task_type: string;
      candidate_model_id: string;
      baseline_model_id: string;
      candidate_mcp_slug?: string;
    }) => postJson<{ ok: boolean; decision: PromotionDecision }>("/api/v1/judge/promote", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["judge"] });
    },
  });
}
