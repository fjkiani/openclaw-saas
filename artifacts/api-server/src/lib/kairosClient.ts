/**
 * kairosClient.ts — Server-side typed client for the Kairos execution API.
 *
 * Reads KAIROS_SERVICE_URL env var.
 * Base path: ${KAIROS_SERVICE_URL}/api/v1/zoa/kairos
 */

const KAIROS_SERVICE_URL = process.env.KAIROS_SERVICE_URL || "http://localhost:8002";
const KAIROS_BASE = `${KAIROS_SERVICE_URL}/api/v1/zoa/kairos`;

// ─── Request / Response Types ─────────────────────────────────────────────────

export interface KairosWorkflowRequest {
  skill_id: string;   // "forge-job-{jobId}"
  goal: string;       // structured goal string
  tenant_id: string;
  max_turns?: number; // default 10
}

export interface KairosRunResponse {
  run_id: string;
  skill_id: string;
  phase: string;
  status: string;
  started_at: string;
}

export interface KairosRunStatus {
  run_id: string;
  skill_id: string;
  phase: string;
  status: "running" | "done" | "failed";
  turn_count: number;
  tool_calls_made: number;
  violations: Array<{ tool_name: string; reason: string; benchmark_score: number }>;
  degraded: boolean;
  result: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  archon_reforge_ready: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function kairosPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${KAIROS_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kairos POST ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function kairosGet<T>(path: string): Promise<T> {
  const res = await fetch(`${KAIROS_BASE}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kairos GET ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export const kairosClient = {
  /**
   * Launch a Kairos workflow. POST /run
   */
  async runWorkflow(req: KairosWorkflowRequest): Promise<KairosRunResponse> {
    return kairosPost<KairosRunResponse>("/run", req);
  },

  /**
   * Poll run status. GET /run/{id}
   */
  async getRunStatus(runId: string): Promise<KairosRunStatus> {
    return kairosGet<KairosRunStatus>(`/run/${encodeURIComponent(runId)}`);
  },

  /**
   * Return the SSE stream URL for the frontend to connect to directly.
   * GET /run/{id}/stream — no fetch performed here.
   */
  getRunStreamUrl(runId: string): string {
    return `${KAIROS_BASE}/run/${encodeURIComponent(runId)}/stream`;
  },

  /**
   * List runs, optionally filtered by skill_id and/or tenant_id. GET /runs
   */
  async listRuns(
    skillId?: string,
    tenantId?: string,
  ): Promise<{ runs: KairosRunStatus[]; total: number }> {
    const params = new URLSearchParams();
    if (skillId) params.set("skill_id", skillId);
    if (tenantId) params.set("tenant_id", tenantId);
    const qs = params.toString();
    const path = qs ? `/runs?${qs}` : "/runs";
    return kairosGet<{ runs: KairosRunStatus[]; total: number }>(path);
  },
};
