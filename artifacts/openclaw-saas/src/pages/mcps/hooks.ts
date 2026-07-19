/**
 * hooks.ts — TanStack Query bindings for /api/mcps/*
 *
 * MCP registry is a governance surface: every row carries a gate report and
 * a grade. Hooks are all read-only except useRegisterMcp.
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

export function useMcpsHealth() {
  return useQuery({
    queryKey: ["mcps", "health"],
    queryFn: () => getJson<{ ok: boolean; n_mcps: number; seed_path: string | null }>("/api/mcps/health"),
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
