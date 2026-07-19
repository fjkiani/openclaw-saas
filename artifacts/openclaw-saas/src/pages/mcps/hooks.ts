/**
 * hooks.ts — TanStack Query bindings for /api/mcps/*
 *
 * MCP registry is a governance surface: every row carries a gate report and
 * a grade. Read-only hooks: list/single/health. Mutations: register, scan,
 * deploy, evaluate. Metrics live in useMcpMetrics (proxies CF Workers MLOps).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

const STALE_MS = 5 * 60 * 1000;

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

export interface McpDeclaredTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface McpDeclaredPrivileges {
  net?: string[];
  fs?: string[];
  env?: string[];
}

export interface McpGateLevel {
  level: 0 | 1 | 2 | 3 | 4;
  name: string;
  pass: boolean;
  score: number;
  notes: string[];
}

export interface McpGateReport {
  slug: string;
  overallScore: number;
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE";
  levels: McpGateLevel[];
  ranAt: string;
  durationMs: number;
}

export interface McpRow {
  id?: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  vendor?: string;
  transport: string;
  entrypoint: string;
  entrypointType: string;
  declaredTools: McpDeclaredTool[];
  declaredPrivileges: McpDeclaredPrivileges;
  currentVersion: number;
  gateStatus: string;
  gateReport?: McpGateReport;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeployResult {
  slug: string;
  deploy_id: string;
  modal_app_url: string;
  py_path: string;
  dry_run: boolean;
  logs: string[];
}

export interface EvalReport {
  slug: string;
  n_prompts: number;
  n_blocked: number;
  n_leaked: number;
  n_partial: number;
  overall_grade: "SAFE" | "PARTIAL" | "UNSAFE";
  category_breakdown: Record<string, { blocked: number; leaked: number; partial: number }>;
  top_failures: Array<{ id: string; category: string; status: string; reason: string }>;
  mode: "dry" | "live";
  ran_at: string;
}

export interface MetricsSummary {
  slug: string;
  n: number;
  n_success: number;
  n_labelled_safe: number;
  n_labelled_unsafe: number;
  mean_latency_ms: number;
  p95_latency_ms: number;
  last_seen: string | null;
  source: "cf-worker" | "dry-mirror";
}

export function useMcpsHealth() {
  return useQuery({
    queryKey: ["mcps", "health"],
    queryFn: () => getJson<{ registry: { ok: boolean; n_mcps: number }; modal: unknown; eval: unknown; cloudflare_mlops: unknown }>("/api/mcps/health"),
    staleTime: STALE_MS,
  });
}

export function useMcpsList(filter?: { category?: string; gateStatus?: string }) {
  const params = new URLSearchParams();
  if (filter?.category) params.set("category", filter.category);
  if (filter?.gateStatus) params.set("gateStatus", filter.gateStatus);
  const qs = params.toString();
  return useQuery({
    queryKey: ["mcps", "list", qs],
    queryFn: () => getJson<{ total: number; rows: McpRow[] }>(`/api/mcps${qs ? `?${qs}` : ""}`),
    staleTime: STALE_MS,
  });
}

export function useMcp(slug: string | undefined) {
  return useQuery({
    queryKey: ["mcps", "single", slug],
    queryFn: () => getJson<McpRow>(`/api/mcps/${encodeURIComponent(slug!)}`),
    enabled: !!slug,
    staleTime: STALE_MS,
  });
}

export function useRegisterMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (manifest: Omit<McpRow, "id" | "currentVersion" | "gateStatus" | "gateReport" | "createdAt" | "updatedAt">) =>
      postJson<{ mcp: McpRow; report: McpGateReport }>("/api/mcps/register", manifest),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcps", "list"] }),
  });
}

export function useScanGithub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { url: string; slug?: string; category?: string }) =>
      postJson<{
        source_url: string;
        files_seen: string[];
        manifest: McpRow;
        mcp: McpRow;
        report: McpGateReport;
        gateStatus: string;
      }>("/api/mcps/scan-github", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcps", "list"] }),
  });
}

export function useDeployMcpToModal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      postJson<DeployResult>(`/api/mcps/${encodeURIComponent(slug)}/deploy-to-modal`, {}),
    onSuccess: (_data, slug) => {
      qc.invalidateQueries({ queryKey: ["mcps", "single", slug] });
    },
  });
}

export function useEvaluateMcp() {
  return useMutation({
    mutationFn: (slug: string) =>
      postJson<EvalReport>(`/api/mcps/${encodeURIComponent(slug)}/evaluate`, {}),
  });
}

export function useMcpMetrics(slug: string | undefined) {
  return useQuery({
    queryKey: ["mcps", "metrics", slug],
    queryFn: () => getJson<MetricsSummary>(`/api/mcps/${encodeURIComponent(slug!)}/metrics`),
    enabled: !!slug,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useMcpTrainingHealth() {
  return useQuery({
    queryKey: ["mcps", "training", "health"],
    queryFn: () => getJson<{ ok: boolean; n_records: number; buffer_path: string }>("/api/mcps/training/health"),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useMcpTrainingPairs() {
  return useQuery({
    queryKey: ["mcps", "training", "pairs"],
    queryFn: () =>
      getJson<{
        total: number;
        counts: Array<{
          mcp_slug: string;
          tool_name: string;
          verified_pairs: number;
          fires: boolean;
          reason: string;
        }>;
      }>("/api/mcps/training/pairs"),
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
}

export function useCheckThresholds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postJson<{
        results: Array<{
          mcp_slug: string;
          tool_name: string;
          dispatched: boolean;
          jobId?: string;
          functionCallId?: string;
          pairs_used?: number;
          dryRun: boolean;
          reason?: string;
        }>;
      }>("/api/mcps/training/check-thresholds", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcps", "training"] }),
  });
}
