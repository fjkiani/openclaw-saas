/**
 * workflow-types.ts — SHARED CONTRACT for the Router Loop A-Z surface.
 *
 * This file is the source of truth consumed by all router-loop FE workers
 * (fleet grid, drill-down cards, drawers) and produced by BE workflow routes:
 *   • GET  /api/v1/workflow/fleet
 *   • GET  /api/v1/workflow/mcp/:slug/:tool
 *   • POST /api/v1/judge/rollback/:gate_id
 *   • POST /api/v1/mcps/inference
 *
 * Any shape change lands here first. FE workers refetch off this file.
 */

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle stages (in exact display order)
// ────────────────────────────────────────────────────────────────────────────
export const STAGES = [
  "register",
  "traffic",
  "judge",
  "benchmark",
  "promote",
  "train",
  "route",
] as const;
export type Stage = (typeof STAGES)[number];

export type StageStatus = "green" | "amber" | "red" | "grey";

export interface StageBadge {
  status: StageStatus;
  label: string; // short human summary, e.g. "42/25 pairs", "safety 92%"
  value?: number; // primary numeric (for sparkline / progress)
  badge?: string; // small chip text, e.g. "L3", "promoted"
  hint?: string; // tooltip / long-form
}

export const STAGE_LABELS: Record<Stage, string> = {
  register: "Register",
  traffic: "Traffic",
  judge: "Judge",
  benchmark: "Benchmark",
  promote: "Promote",
  train: "Train",
  route: "Route",
};

// ────────────────────────────────────────────────────────────────────────────
// Fleet grid row (one per mcp_slug × tool_name)
// ────────────────────────────────────────────────────────────────────────────
export interface FleetRow {
  mcp_slug: string;
  tool_name: string;
  display_name?: string;
  provider?: string;
  domain?: string; // e.g. "database", "web"
  stages: Record<Stage, StageBadge>;
  updated_at?: string | null;
}

export interface FleetResponse {
  ok: boolean;
  rows: FleetRow[];
  summary: {
    total_buckets: number;
    promoted_this_week: number;
    pending_judge: number;
    failed_dispatches: number;
    generated_at: string;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Drill-down aggregate (one per mcp_slug × tool_name)
// ────────────────────────────────────────────────────────────────────────────
export interface DrilldownRegister {
  gate_l0: number | null;
  gate_l1: number | null;
  gate_l2: number | null;
  gate_l3: number | null;
  gate_l4: number | null;
  overall: number | null;
  moat_score?: number | null;
  moat_grade?: string | null;
}

export interface DrilldownTraffic {
  n_invocations: number;
  p95_latency_ms: number | null;
  mean_latency_ms: number | null;
  last_seen: string | null;
  errors_24h: number;
}

export interface DrilldownJudgeRow {
  id: string;
  chosen_text: string;
  rejected_text: string;
  judge_score_chosen: number | null;
  judge_score_rejected: number | null;
  judge_reasoning: string | null;
  judge_verified: boolean;
  label?: "safe" | "unsafe" | "defer" | null;
  updated_at: string | null;
}

export interface DrilldownJudge {
  verified: number;
  unverified: number;
  mean_margin: number | null;
  min_pairs_required: number;
  recent: DrilldownJudgeRow[];
}

export interface DrilldownBenchmark {
  latest_run_id: number | null;
  safety_pct: number | null;
  completion_pct: number | null;
  n_leaks: number | null;
  n_tasks: number | null;
  ran_at: string | null;
}

export interface DrilldownPromoteGate {
  id: number;
  promoted: boolean;
  reason: string | null;
  candidate_model_id: string | null;
  baseline_model_id: string | null;
  win_rate: number | null;
  safety_pct: number | null;
  completion_pct: number | null;
  n_pairs: number | null;
  created_at: string;
  is_rollback?: boolean;
}

export interface DrilldownPromote {
  latest: DrilldownPromoteGate | null;
  history: DrilldownPromoteGate[];
  can_rollback: boolean;
}

export interface DrilldownAdapter {
  id: string;
  volume_path: string; // "/root/adapters/<slug>__<tool>/adapter"
  r2_key: string | null;
  created_at: string;
  n_pairs: number | null;
  base_model: string;
}

export interface DrilldownTrain {
  dispatched_count: number;
  adapters: DrilldownAdapter[];
  latest_r2_key: string | null;
  ready_to_dispatch: boolean;
  eligible_pair_count: number;
}

export interface DrilldownRoute {
  current_policy: {
    id: number | null;
    fast_model_id: string | null;
    deep_model_id: string | null;
    updated_at: string | null;
  };
  candidate_diff: {
    from_fast: string | null;
    to_fast: string | null;
    from_deep: string | null;
    to_deep: string | null;
  } | null;
  can_rollback: boolean;
  rollback_gate_id: number | null;
}

export interface DrilldownResponse {
  ok: boolean;
  mcp_slug: string;
  tool_name: string;
  display_name: string;
  provider: string;
  register: DrilldownRegister;
  traffic: DrilldownTraffic;
  judge: DrilldownJudge;
  benchmark: DrilldownBenchmark;
  promote: DrilldownPromote;
  train: DrilldownTrain;
  route: DrilldownRoute;
  generated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────────────────
export interface RollbackRequest {
  gate_id: number;
}
export interface RollbackResponse {
  ok: boolean;
  new_gate_id: number;
  new_policy_id: number;
  reverted_to: { fast_model_id: string; deep_model_id: string };
}

export interface InferenceRequest {
  mcp_slug: string;
  tool_name: string;
  prompt: string;
  adapter_id?: string; // optional: pin a specific adapter, otherwise latest
  max_new_tokens?: number;
}
export interface InferenceResponse {
  ok: boolean;
  completion: string;
  adapter_used: string; // "<slug>__<tool>" or "baseline"
  latency_ms: number;
  cold_start: boolean;
}

export interface LabelRequest {
  invocation_id: string;
  label: "safe" | "unsafe" | "defer";
  note?: string;
}
export interface LabelResponse {
  ok: boolean;
  id: string;
  label: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// URL state helpers (drill-down deep-links)
// ────────────────────────────────────────────────────────────────────────────
export interface UrlState {
  mcp?: string;
  tool?: string;
  stage?: Stage;
  labeling?: boolean;
}

export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const stage = q.get("stage");
  return {
    mcp: q.get("mcp") ?? undefined,
    tool: q.get("tool") ?? undefined,
    stage: STAGES.includes(stage as Stage) ? (stage as Stage) : undefined,
    labeling: q.get("labeling") === "1",
  };
}

export function encodeUrlState(state: UrlState): string {
  const q = new URLSearchParams();
  if (state.mcp) q.set("mcp", state.mcp);
  if (state.tool) q.set("tool", state.tool);
  if (state.stage) q.set("stage", state.stage);
  if (state.labeling) q.set("labeling", "1");
  const s = q.toString();
  return s ? `?${s}` : "";
}
