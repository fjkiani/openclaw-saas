/**
 * agentRunStore.ts — DB-backed write-through store for agent runs + steps.
 *
 * Same architecture as archon/runStore.ts:
 *   - In-memory Map is the fast path for reads during an active run.
 *   - Every write also persists to zie_agent_runs / zie_agent_steps.
 *   - On a getRun() cache miss (e.g. after a restart) we hydrate from DB.
 *   - listRuns() always reads DB so it is authoritative across restarts.
 *
 * A restart therefore never loses run state: in-flight runs show their last
 * persisted status, terminal runs stay fully readable, no 404 after restart.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import type {
  AgentMode,
  AgentRun,
  AgentStep,
  PlanStep,
  RunStatus,
  StepStatus,
} from "./contract.js";

const _cache = new Map<string, AgentRun>();
const MAX_CACHE = 200;

function pruneCache(): void {
  if (_cache.size > MAX_CACHE) {
    const oldest = [..._cache.entries()]
      .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at))
      .slice(0, 50);
    for (const [k] of oldest) _cache.delete(k);
  }
}

// ── row mappers ────────────────────────────────────────────────────────────────
function rowToRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    goal: row.goal as string,
    mode: (row.mode as AgentMode) ?? "console",
    mcp_slug: (row.mcp_slug as string) ?? null,
    tool_name: (row.tool_name as string) ?? null,
    status: (row.status as RunStatus) ?? "planning",
    plan: (row.plan as PlanStep[]) ?? [],
    current_step: Number(row.current_step ?? 0),
    replans: Number(row.replans ?? 0),
    planner: (row.planner as string) ?? null,
    summary: (row.summary as string) ?? null,
    error: (row.error as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    created_at: (row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)),
    completed_at: row.completed_at
      ? (row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at))
      : null,
  };
}

function rowToStep(row: Record<string, unknown>): AgentStep {
  return {
    idx: Number(row.idx),
    action_type: row.action_type as AgentStep["action_type"],
    args: (row.args as Record<string, unknown>) ?? {},
    rationale: (row.rationale as string) ?? "",
    requires_approval: Boolean(row.requires_approval),
    status: (row.status as StepStatus) ?? "pending",
    approved: row.approved === null || row.approved === undefined ? null : Boolean(row.approved),
    approved_by: (row.approved_by as string) ?? null,
    result: row.result ?? null,
    error: (row.error as string) ?? null,
    started_at: row.started_at
      ? (row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at))
      : null,
    ended_at: row.ended_at
      ? (row.ended_at instanceof Date ? row.ended_at.toISOString() : String(row.ended_at))
      : null,
  };
}

// ── create ───────────────────────────────────────────────────────────────────
export async function createRun(input: {
  goal: string;
  mode: AgentMode;
  mcp_slug?: string | null;
  tool_name?: string | null;
  created_by?: string | null;
}): Promise<AgentRun> {
  const res = await pool.query(
    `INSERT INTO "zie_agent_runs" (goal, mode, mcp_slug, tool_name, status, plan, created_by)
     VALUES ($1,$2,$3,$4,'planning','[]'::jsonb,$5)
     RETURNING *`,
    [input.goal, input.mode, input.mcp_slug ?? null, input.tool_name ?? null, input.created_by ?? null]
  );
  const run = rowToRun(res.rows[0] as Record<string, unknown>);
  run.steps = [];
  _cache.set(run.id, run);
  pruneCache();
  return run;
}

// ── persist plan (run + steps) ──────────────────────────────────────────────────
export async function savePlan(
  runId: string,
  steps: PlanStep[],
  planner: string
): Promise<void> {
  await pool.query(
    `UPDATE "zie_agent_runs" SET plan=$2::jsonb, planner=$3, status='running' WHERE id=$1`,
    [runId, JSON.stringify(steps), planner]
  );
  // Replace any existing steps (idempotent on re-plan).
  await pool.query(`DELETE FROM "zie_agent_steps" WHERE run_id=$1`, [runId]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await pool.query(
      `INSERT INTO "zie_agent_steps" (run_id, idx, action_type, args, rationale, status, requires_approval)
       VALUES ($1,$2,$3,$4::jsonb,$5,'pending',$6)`,
      [runId, i, s.action_type, JSON.stringify(s.args ?? {}), s.rationale ?? "", s.requires_approval]
    );
  }
  const cached = _cache.get(runId);
  if (cached) {
    cached.plan = steps;
    cached.planner = planner;
    cached.status = "running";
    cached.steps = steps.map((s, i) => ({
      ...s,
      idx: i,
      status: "pending",
      approved: null,
      approved_by: null,
      result: null,
      error: null,
      started_at: null,
      ended_at: null,
    }));
  }
}

// ── run-level updates ────────────────────────────────────────────────────────
export async function updateRun(
  runId: string,
  patch: Partial<Pick<AgentRun, "status" | "current_step" | "replans" | "summary" | "error">> & {
    completed?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [runId];
  let idx = 2;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "completed") {
      if (v) sets.push(`completed_at = now()`);
      continue;
    }
    sets.push(`"${k}" = $${idx}`);
    vals.push(v);
    idx++;
  }
  if (!sets.length) return;
  await pool.query(`UPDATE "zie_agent_runs" SET ${sets.join(", ")} WHERE id=$1`, vals);
  const cached = _cache.get(runId);
  if (cached) {
    if (patch.status !== undefined) cached.status = patch.status;
    if (patch.current_step !== undefined) cached.current_step = patch.current_step;
    if (patch.replans !== undefined) cached.replans = patch.replans;
    if (patch.summary !== undefined) cached.summary = patch.summary ?? null;
    if (patch.error !== undefined) cached.error = patch.error ?? null;
    if (patch.completed) cached.completed_at = new Date().toISOString();
  }
}

// ── step-level updates ───────────────────────────────────────────────────────
export async function updateStep(
  runId: string,
  idx: number,
  patch: Partial<Pick<AgentStep, "status" | "result" | "error" | "approved" | "approved_by">> & {
    started?: boolean;
    ended?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [runId, idx];
  let p = 3;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "started") {
      if (v) sets.push(`started_at = now()`);
      continue;
    }
    if (k === "ended") {
      if (v) sets.push(`ended_at = now()`);
      continue;
    }
    if (k === "result") {
      sets.push(`result = $${p}::jsonb`);
      vals.push(JSON.stringify(v ?? null));
      p++;
      continue;
    }
    sets.push(`"${k}" = $${p}`);
    vals.push(v);
    p++;
  }
  if (!sets.length) return;
  await pool.query(
    `UPDATE "zie_agent_steps" SET ${sets.join(", ")} WHERE run_id=$1 AND idx=$2`,
    vals
  );
  const cached = _cache.get(runId);
  if (cached?.steps?.[idx]) {
    const st = cached.steps[idx];
    if (patch.status !== undefined) st.status = patch.status;
    if (patch.result !== undefined) st.result = patch.result;
    if (patch.error !== undefined) st.error = patch.error ?? null;
    if (patch.approved !== undefined) st.approved = patch.approved;
    if (patch.approved_by !== undefined) st.approved_by = patch.approved_by ?? null;
    if (patch.started) st.started_at = new Date().toISOString();
    if (patch.ended) st.ended_at = new Date().toISOString();
  }
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function getRun(runId: string, hydrate = true): Promise<AgentRun | null> {
  const cached = _cache.get(runId);
  if (cached && cached.steps) return cached;

  const res = await pool.query(`SELECT * FROM "zie_agent_runs" WHERE id=$1`, [runId]);
  if (!res.rows.length) return null;
  const run = rowToRun(res.rows[0] as Record<string, unknown>);
  if (hydrate) {
    const steps = await pool.query(
      `SELECT * FROM "zie_agent_steps" WHERE run_id=$1 ORDER BY idx ASC`,
      [runId]
    );
    run.steps = steps.rows.map((r) => rowToStep(r as Record<string, unknown>));
  }
  _cache.set(run.id, run);
  pruneCache();
  return run;
}

export async function listRuns(limit = 20, mode?: AgentMode): Promise<AgentRun[]> {
  const clause = mode ? `WHERE mode=$2` : ``;
  const vals: unknown[] = mode ? [limit, mode] : [limit];
  const res = await pool.query(
    `SELECT * FROM "zie_agent_runs" ${clause} ORDER BY created_at DESC LIMIT $1`,
    vals
  );
  return res.rows.map((r) => rowToRun(r as Record<string, unknown>));
}

export async function listRunsForBucket(
  mcp_slug: string,
  tool_name: string | null,
  limit = 10
): Promise<AgentRun[]> {
  const res = await pool.query(
    `SELECT * FROM "zie_agent_runs"
     WHERE mcp_slug=$1 ${tool_name ? "AND tool_name=$3" : ""}
     ORDER BY created_at DESC LIMIT $2`,
    tool_name ? [mcp_slug, limit, tool_name] : [mcp_slug, limit]
  );
  return res.rows.map((r) => rowToRun(r as Record<string, unknown>));
}

// Best-effort cache drop (used by tests / long-running daemons).
export function evict(runId: string): void {
  _cache.delete(runId);
}

export { logger as _agentStoreLogger };
