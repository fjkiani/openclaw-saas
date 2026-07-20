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
