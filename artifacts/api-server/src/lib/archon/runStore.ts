/**
 * runStore.ts — DB-backed store for Archon skill forge runs.
 *
 * Architecture: write-through cache.
 *   - In-memory Map is the fast path for reads during an active run.
 *   - Every write also goes to the `archon_runs` DB table.
 *   - On getRun() miss (e.g. after a Render restart), falls back to DB SELECT.
 *   - listRuns() always reads from DB so it's authoritative across restarts.
 *
 * This means a Render restart no longer silently loses run state:
 *   - In-flight runs show their last persisted status (generating/benchmarking/etc.)
 *   - Completed/failed runs are fully readable
 *   - The run record never returns 404 after a restart
 */

import { randomUUID } from "crypto";
import { pool } from "@workspace/db";

export type RunStatus =
  | "pending" | "generating" | "validating" | "fixing"
  | "benchmarking" | "cataloging" | "completed" | "failed";

export interface FactoryRun {
  runId: string;
  description: string;
  status: RunStatus;
  stage: string;
  skill?: {
    name: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    implementation: string;
  };
  l0Result?: { l0_pass: boolean; error?: string };
  benchmarkResult?: {
    grade: string;
    overall_score: number | null;
    level_scores?: Record<string, unknown>;
  };
  cataloged?: boolean;
  skillId?: number;
  retryCount: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

// ── In-memory write-through cache ────────────────────────────────────────────
const _cache = new Map<string, FactoryRun>();
const MAX_CACHE = 200;

function pruneCache(): void {
  if (_cache.size > MAX_CACHE) {
    const oldest = [..._cache.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .slice(0, 50);
    for (const [k] of oldest) _cache.delete(k);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function rowToRun(row: Record<string, unknown>): FactoryRun {
  return {
    runId: row.run_id as string,
    description: row.description as string,
    status: row.status as RunStatus,
    stage: (row.stage as string) ?? "queued",
    skill: row.skill ? (row.skill as FactoryRun["skill"]) : undefined,
    l0Result: row.l0_result ? (row.l0_result as FactoryRun["l0Result"]) : undefined,
    benchmarkResult: row.benchmark_result
      ? (row.benchmark_result as FactoryRun["benchmarkResult"])
      : undefined,
    cataloged: row.cataloged as boolean | undefined,
    skillId: row.skill_id ? Number(row.skill_id) : undefined,
    retryCount: Number(row.retry_count ?? 0),
    error: row.error as string | undefined,
    createdAt: row.created_at
      ? new Date(row.created_at as string).getTime()
      : Date.now(),
    completedAt: row.completed_at
      ? new Date(row.completed_at as string).getTime()
      : undefined,
  };
}

async function dbInsert(run: FactoryRun): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO archon_runs
         (run_id, description, status, stage, skill, l0_result, benchmark_result,
          cataloged, skill_id, retry_count, error, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),$13)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        run.runId,
        run.description,
        run.status,
        run.stage,
        run.skill ? JSON.stringify(run.skill) : null,
        run.l0Result ? JSON.stringify(run.l0Result) : null,
        run.benchmarkResult ? JSON.stringify(run.benchmarkResult) : null,
        run.cataloged ?? null,
        run.skillId ?? null,
        run.retryCount,
        run.error ?? null,
        run.createdAt,
        run.completedAt ? new Date(run.completedAt).toISOString() : null,
      ]
    );
  } catch (err) {
    // Non-fatal — in-memory cache still works; log and continue
    console.error("[runStore] dbInsert failed:", err instanceof Error ? err.message : err);
  }
}

async function dbUpdate(runId: string, updates: Partial<FactoryRun>): Promise<void> {
  try {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    const addField = (col: string, val: unknown, asJson = false) => {
      sets.push(`"${col}" = $${idx++}`);
      vals.push(asJson && val != null ? JSON.stringify(val) : val);
    };

    if (updates.status !== undefined) addField("status", updates.status);
    if (updates.stage !== undefined) addField("stage", updates.stage);
    if (updates.skill !== undefined) addField("skill", updates.skill, true);
    if (updates.l0Result !== undefined) addField("l0_result", updates.l0Result, true);
    if (updates.benchmarkResult !== undefined) addField("benchmark_result", updates.benchmarkResult, true);
    if (updates.cataloged !== undefined) addField("cataloged", updates.cataloged);
    if (updates.skillId !== undefined) addField("skill_id", updates.skillId);
    if (updates.retryCount !== undefined) addField("retry_count", updates.retryCount);
    if (updates.error !== undefined) addField("error", updates.error);
    if (updates.completedAt !== undefined) {
      sets.push(`"completed_at" = to_timestamp($${idx++}/1000.0)`);
      vals.push(updates.completedAt);
    }

    if (sets.length === 0) return;
    vals.push(runId);

    await pool.query(
      `UPDATE archon_runs SET ${sets.join(", ")} WHERE run_id = $${idx}`,
      vals
    );
  } catch (err) {
    console.error("[runStore] dbUpdate failed:", err instanceof Error ? err.message : err);
  }
}

async function dbGet(runId: string): Promise<FactoryRun | undefined> {
  try {
    const res = await pool.query(
      `SELECT * FROM archon_runs WHERE run_id = $1`,
      [runId]
    );
    if (res.rows.length === 0) return undefined;
    return rowToRun(res.rows[0] as Record<string, unknown>);
  } catch (err) {
    console.error("[runStore] dbGet failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function dbList(limit: number): Promise<FactoryRun[]> {
  try {
    const res = await pool.query(
      `SELECT * FROM archon_runs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => rowToRun(r as Record<string, unknown>));
  } catch (err) {
    console.error("[runStore] dbList failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createRun(description: string): FactoryRun {
  const run: FactoryRun = {
    runId: randomUUID(),
    description,
    status: "pending",
    stage: "queued",
    retryCount: 0,
    createdAt: Date.now(),
  };
  _cache.set(run.runId, run);
  pruneCache();
  // Fire-and-forget DB insert (non-blocking)
  void dbInsert(run);
  return run;
}

/** Sync read from cache; async DB fallback on miss (returns undefined synchronously if not cached). */
export function getRun(runId: string): FactoryRun | undefined {
  return _cache.get(runId);
}

/** Async read — checks cache first, then DB. Use this in HTTP handlers after a restart. */
export async function getRunAsync(runId: string): Promise<FactoryRun | undefined> {
  const cached = _cache.get(runId);
  if (cached) return cached;
  const fromDb = await dbGet(runId);
  if (fromDb) {
    _cache.set(fromDb.runId, fromDb);
  }
  return fromDb;
}

export function updateRun(runId: string, updates: Partial<FactoryRun>): void {
  const run = _cache.get(runId);
  if (run) Object.assign(run, updates);
  // Always persist to DB regardless of cache hit (handles post-restart updates)
  void dbUpdate(runId, updates);
}

/** Always reads from DB — authoritative across restarts. */
export async function listRuns(limit = 20): Promise<FactoryRun[]> {
  const dbRuns = await dbList(limit);
  // Merge with cache so in-flight runs show latest state
  return dbRuns.map((r) => _cache.get(r.runId) ?? r);
}
