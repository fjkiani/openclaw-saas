/**
 * workflow-hooks.ts — TanStack Query bindings for the Router Loop A-Z surface.
 *
 * Consumers: fleet grid, drill-down cards, stage drawers (W2/W3/W4).
 * Backend contracts: /api/v1/workflow/*, /api/v1/judge/rollback/*, /api/v1/mcps/inference.
 *
 * Refetch cadence:
 *   • Fleet grid: 15s idle (30s server cache; polling is cheap).
 *   • Drill-down: 3s while an action is in flight, 15s idle.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";
import type {
  FleetResponse,
  DrilldownResponse,
  RollbackResponse,
  InferenceRequest,
  InferenceResponse,
  LabelRequest,
  LabelResponse,
} from "./workflow-types";

const STALE_MS = 15 * 1000;
const REFETCH_IDLE_MS = 15 * 1000;
const REFETCH_ACTIVE_MS = 3 * 1000;

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ────────────────────────────────────────────────────────────────────────────
// Fleet grid (landing)
// ────────────────────────────────────────────────────────────────────────────
export function useFleet() {
  return useQuery({
    queryKey: ["workflow", "fleet"],
    queryFn: () => getJson<FleetResponse>("/api/v1/workflow/fleet"),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_IDLE_MS,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Drill-down (per bucket)
// ────────────────────────────────────────────────────────────────────────────
export function useDrilldown(mcpSlug?: string, toolName?: string, active = false) {
  return useQuery({
    queryKey: ["workflow", "drilldown", mcpSlug, toolName],
    queryFn: () =>
      getJson<DrilldownResponse>(
        `/api/v1/workflow/mcp/${encodeURIComponent(mcpSlug!)}/${encodeURIComponent(toolName!)}`,
      ),
    staleTime: STALE_MS,
    refetchInterval: active ? REFETCH_ACTIVE_MS : REFETCH_IDLE_MS,
    enabled: Boolean(mcpSlug && toolName),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Mutations — Judge batch, Benchmark, Promote (wrap existing endpoints)
// ────────────────────────────────────────────────────────────────────────────
export function useJudgeNextBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { domain?: string; task_type?: string; limit?: number }) =>
      postJson<{ ok: boolean; scored_count: number; skipped: number }>("/api/v1/judge/pairs/batch", body),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ["workflow", "fleet"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

export function useRebenchmark() {
  const qc = useQueryClient();
  // Wraps the new workflow endpoint that internally calls benchmarkMcp with
  // the correct mcpUrl looked up from the registry — the FE doesn't need it.
  return useMutation({
    mutationFn: (body: { mcp_slug: string; tool_name: string; live?: boolean }) =>
      postJson<{ ok: boolean; run_id: number; safety_pct: number; n_leaks: number }>(
        "/api/v1/workflow/benchmark",
        { ...body, live: body.live ?? true },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "fleet"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

export function usePromoteGate() {
  const qc = useQueryClient();
  // Wraps /judge/promote — workflow endpoint translates (mcp_slug, tool_name)
  // → (domain='mcp', task_type='mcp_slug::tool_name') and looks up baseline.
  return useMutation({
    mutationFn: (body: {
      mcp_slug: string;
      tool_name: string;
      candidate_model_id: string;
      baseline_model_id?: string;
    }) =>
      postJson<{ ok: boolean; gate_id: number; promoted: boolean; reason?: string }>(
        "/api/v1/workflow/promote",
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "fleet"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

export function useDispatchTraining() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mcp_slug: string; tool_name: string; min_pairs?: number }) =>
      postJson<{ ok: boolean; dispatched: Array<{ mcp_slug: string; tool_name: string; run_id: string }> }>(
        "/api/v1/mcps/training/check-thresholds",
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "fleet"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// One-click rollback (destructive, requires admin header)
// ────────────────────────────────────────────────────────────────────────────
export function useRollbackGate(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gateId: number) =>
      postJson<RollbackResponse>(
        `/api/v1/judge/rollback/${gateId}`,
        {},
        adminToken ? { "x-openclaw-admin-token": adminToken } : undefined,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "fleet"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Inference (test the served adapter)
// ────────────────────────────────────────────────────────────────────────────
export function useInference() {
  return useMutation({
    mutationFn: (body: InferenceRequest) => postJson<InferenceResponse>("/api/v1/mcps/inference", body),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Labeling drawer
// ────────────────────────────────────────────────────────────────────────────
export function useUnverifiedPairs(mcpSlug?: string, toolName?: string, limit = 20) {
  return useQuery({
    queryKey: ["workflow", "pairs", mcpSlug, toolName, "unverified", limit],
    queryFn: () =>
      getJson<{ ok: boolean; pairs: Array<import("./workflow-types").DrilldownJudgeRow> }>(
        `/api/v1/mcps/training/pairs/${encodeURIComponent(mcpSlug!)}/${encodeURIComponent(toolName!)}?verified=false&limit=${limit}`,
      ),
    staleTime: STALE_MS,
    enabled: Boolean(mcpSlug && toolName),
  });
}

export function useLabelPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LabelRequest) =>
      postJson<LabelResponse>(`/api/v1/mcps/training/invocations/${encodeURIComponent(body.invocation_id)}/label`, {
        label: body.label,
        note: body.note,
      }),
    // Optimistic UI — flip the row locally before the server confirms.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["workflow", "pairs"] });
      const prev = qc.getQueriesData({ queryKey: ["workflow", "pairs"] });
      qc.setQueriesData({ queryKey: ["workflow", "pairs"] }, (old: any) => {
        if (!old?.pairs) return old;
        return { ...old, pairs: old.pairs.map((p: any) => (p.id === body.invocation_id ? { ...p, label: body.label } : p)) };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) for (const [k, v] of ctx.prev) qc.setQueryData(k, v);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["workflow", "pairs"] });
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Loop (W1/W2/W5) — agentic correction: runs, settings, run-once, promote
// ────────────────────────────────────────────────────────────────────────────
export type LoopRun = {
  id: number;
  created_at: string;
  prompt: string;
  orig_score: number;
  repair_a_model: string;
  repair_a_score: number;
  repair_b_model: string;
  repair_b_score: number;
  winner: "a" | "b";
  judge_margin: number;
  judge_version: string;
  pref_pair_id: string | null;
  promoted: boolean | null;
  promoted_auto: boolean | null;
};

export type LoopSettings = {
  auto_promote: boolean;
  min_margin: number;
  min_pairs_agree: number;
  min_confidence: number;
};

export function useLoopRuns(mcpSlug?: string, toolName?: string, limit = 20) {
  return useQuery({
    queryKey: ["loop", "runs", mcpSlug, toolName, limit],
    queryFn: () =>
      getJson<{ ok: boolean; runs: LoopRun[]; count: number }>(
        `/api/v1/loop/runs/${encodeURIComponent(mcpSlug!)}/${encodeURIComponent(toolName!)}?limit=${limit}`,
      ),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_IDLE_MS,
    enabled: Boolean(mcpSlug && toolName),
  });
}

export function useLoopSettings(mcpSlug?: string, toolName?: string) {
  return useQuery({
    queryKey: ["loop", "settings", mcpSlug, toolName],
    queryFn: () =>
      getJson<{ ok: boolean; settings: LoopSettings }>(
        `/api/v1/loop/settings/${encodeURIComponent(mcpSlug!)}/${encodeURIComponent(toolName!)}`,
      ),
    staleTime: STALE_MS,
    enabled: Boolean(mcpSlug && toolName),
  });
}

export function useUpdateLoopSettings(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      mcp_slug: string;
      tool_name: string;
      auto_promote?: boolean;
      min_margin?: number;
      min_pairs_agree?: number;
      min_confidence?: number;
    }) =>
      apiFetch(`/api/v1/loop/settings/${encodeURIComponent(body.mcp_slug)}/${encodeURIComponent(body.tool_name)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "x-openclaw-admin-token": adminToken } : {}),
        },
        body: JSON.stringify({
          auto_promote: body.auto_promote,
          min_margin: body.min_margin,
          min_pairs_agree: body.min_pairs_agree,
          min_confidence: body.min_confidence,
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`settings PUT ${r.status}`);
        return r.json();
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["loop", "settings", v.mcp_slug, v.tool_name] });
    },
  });
}

export function useRunLoop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      mcp_slug: string;
      tool_name: string;
      prompt: string;
      adapter_id?: string;
      orig_response?: string;
    }) => postJson<any>("/api/v1/loop/run", body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["loop", "runs", v.mcp_slug, v.tool_name] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown", v.mcp_slug, v.tool_name] });
    },
  });
}

export function usePromoteLoop(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { loop_run_id: number }) =>
      apiFetch("/api/v1/loop/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "x-openclaw-admin-token": adminToken } : {}),
        },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`promote ${r.status}`);
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loop", "runs"] });
      qc.invalidateQueries({ queryKey: ["workflow", "drilldown"] });
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Agent executor (Agent Console + Autopilot)  — added for the internal
// platform-agent iteration. Polls at REFETCH_ACTIVE_MS while a run is active.
// ────────────────────────────────────────────────────────────────────────────
export type AgentStepStatus =
  | "pending" | "running" | "awaiting_approval" | "done" | "failed" | "skipped";
export type AgentRunStatus =
  | "planning" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export interface AgentStepT {
  idx: number;
  action_type: string;
  args: Record<string, unknown>;
  rationale: string;
  requires_approval: boolean;
  status: AgentStepStatus;
  approved: boolean | null;
  approved_by: string | null;
  result: { summary?: string; data?: unknown; ok?: boolean; error?: string | null } | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}
export interface AgentRunT {
  id: string;
  goal: string;
  mode: "console" | "autopilot";
  mcp_slug: string | null;
  tool_name: string | null;
  status: AgentRunStatus;
  plan: unknown[];
  current_step: number;
  replans: number;
  planner: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  steps?: AgentStepT[];
}
export interface AgentActionT {
  action_type: string;
  describe: string;
  mutating: boolean;
}

const ACTIVE_RUN_STATES: AgentRunStatus[] = ["planning", "running", "awaiting_approval"];

export function useAgentActions() {
  return useQuery({
    queryKey: ["agent", "actions"],
    queryFn: () => getJson<{ ok: boolean; actions: AgentActionT[] }>("/api/v1/agent/actions"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgentRuns(limit = 20, mode?: "console" | "autopilot") {
  return useQuery({
    queryKey: ["agent", "runs", limit, mode],
    queryFn: () =>
      getJson<{ ok: boolean; runs: AgentRunT[]; count: number }>(
        `/api/v1/agent/runs?limit=${limit}${mode ? `&mode=${mode}` : ""}`,
      ),
    refetchInterval: REFETCH_ACTIVE_MS,
  });
}

export function useAgentRunDetail(runId?: string) {
  return useQuery({
    queryKey: ["agent", "run", runId],
    queryFn: () => getJson<{ ok: boolean; run: AgentRunT }>(`/api/v1/agent/run/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => {
      const st = (q.state.data as { run?: AgentRunT } | undefined)?.run?.status;
      return st && ACTIVE_RUN_STATES.includes(st) ? REFETCH_ACTIVE_MS : false;
    },
  });
}

export function useStartAgentRun(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { goal: string; mode?: string; mcp_slug?: string | null; tool_name?: string | null }) =>
      postJson<{ ok: boolean; run_id: string; pollUrl: string }>(
        "/api/v1/agent/run",
        body,
        adminToken ? { "x-openclaw-admin-token": adminToken } : undefined,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "runs"] }),
  });
}

export function useApproveAgentStep(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { runId: string; step_idx: number; decision: "approve" | "reject" }) =>
      postJson<{ ok: boolean; run: AgentRunT }>(
        `/api/v1/agent/run/${body.runId}/approve`,
        { step_idx: body.step_idx, decision: body.decision },
        adminToken ? { "x-openclaw-admin-token": adminToken } : undefined,
      ),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["agent", "run", v.runId] });
      qc.invalidateQueries({ queryKey: ["agent", "runs"] });
    },
  });
}

export function useCancelAgentRun(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      postJson<{ ok: boolean; run: AgentRunT }>(
        `/api/v1/agent/run/${runId}/cancel`,
        {},
        adminToken ? { "x-openclaw-admin-token": adminToken } : undefined,
      ),
    onSuccess: (_d, runId) => {
      qc.invalidateQueries({ queryKey: ["agent", "run", runId] });
      qc.invalidateQueries({ queryKey: ["agent", "runs"] });
    },
  });
}

export function useAutopilotSettings() {
  return useQuery({
    queryKey: ["agent", "autopilot"],
    queryFn: () =>
      getJson<{ ok: boolean; settings: Array<{ mcp_slug: string; tool_name: string; enabled: boolean; last_run_id: string | null }> }>(
        "/api/v1/agent/autopilot",
      ),
    refetchInterval: REFETCH_ACTIVE_MS,
  });
}

export function useToggleAutopilot(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mcp_slug: string; tool_name: string; enabled: boolean }) =>
      postJson<{ ok: boolean }>(
        "/api/v1/agent/autopilot",
        body,
        adminToken ? { "x-openclaw-admin-token": adminToken } : undefined,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "autopilot"] }),
  });
}

export function useAgentRunsForBucket(mcpSlug?: string, toolName?: string, limit = 5) {
  return useQuery({
    queryKey: ["agent", "runs", "bucket", mcpSlug, toolName, limit],
    queryFn: () =>
      getJson<{ ok: boolean; runs: AgentRunT[]; count: number }>(
        `/api/v1/agent/runs/bucket/${encodeURIComponent(mcpSlug!)}/${encodeURIComponent(toolName!)}?limit=${limit}`,
      ),
    enabled: Boolean(mcpSlug && toolName),
    refetchInterval: REFETCH_ACTIVE_MS,
  });
}
