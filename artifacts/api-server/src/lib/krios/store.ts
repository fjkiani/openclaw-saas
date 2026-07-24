/**
 * store.ts — persistence + projection for Krios.
 *
 * Two responsibilities, both read/write against REAL tables (never fabricated):
 *   1. append + read `zie_krios_events` (the append-only factory feed powering
 *      the SSE stream, the Control Room log, and Floor token motion).
 *   2. project a derived `KriosState` snapshot from `zie_agent_runs` /
 *      `zie_agent_steps` (runs launched by the conductor, i.e. created_by='krios')
 *      plus recent events — this is GET /v1/krios/state and the polling fallback.
 *
 * The conductor is the primary writer of events; routes are readers. Everything
 * here is defensive (best-effort, never throws into the daemon loop).
 */
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import {
  KRIOS_STAGES,
  stageForAction,
  type KriosEvent,
  type KriosEventInput,
  type KriosInflight,
  type KriosKpis,
  type KriosQueueItem,
  type KriosStage,
  type KriosState,
} from "./contract.js";
import { kriosConfig, kriosPublicConfig } from "./config.js";

/** Runs launched by the conductor carry this created_by marker. */
export const KRIOS_CREATED_BY = "krios";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// ── Event append ───────────────────────────────────────────────────────────────
/**
 * Append one factory event. Returns the new row id (cursor) or null on failure.
 * Best-effort: a logging failure must never break a real run's progress.
 */
export async function appendEvent(ev: KriosEventInput): Promise<number | null> {
  try {
    const r = await pool.query(
      `INSERT INTO "zie_krios_events" (kind, mcp_slug, tool_name, run_id, stage, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        ev.kind,
        ev.mcp_slug ?? null,
        ev.tool_name ?? null,
        ev.run_id ?? null,
        ev.stage ?? null,
        JSON.stringify(ev.detail ?? {}),
      ],
    );
    return Number(r.rows[0]?.id ?? 0) || null;
  } catch (err) {
    logger.warn({ err: String(err), kind: ev.kind }, "krios: appendEvent failed");
    return null;
  }
}

function rowToEvent(r: Record<string, unknown>): KriosEvent {
  const ts = r.ts instanceof Date ? r.ts.toISOString() : String(r.ts);
  let detail: Record<string, unknown> = {};
  const raw = r.detail;
  if (raw && typeof raw === "object") detail = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try {
      detail = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      detail = {};
    }
  }
  return {
    id: Number(r.id),
    ts,
    kind: r.kind as KriosEvent["kind"],
    mcp_slug: (r.mcp_slug as string | null) ?? null,
    tool_name: (r.tool_name as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    stage: (r.stage as KriosStage | null) ?? null,
    detail,
  };
}

/**
 * Events strictly after `since` (exclusive), oldest→newest, capped at `limit`.
 * `since=0` returns the most recent `limit` events (initial hydrate).
 */
export async function eventsSince(since = 0, limit = 200): Promise<KriosEvent[]> {
  const lim = Math.min(1000, Math.max(1, limit));
  try {
    if (since > 0) {
      const r = await pool.query(
        `SELECT * FROM "zie_krios_events" WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [since, lim],
      );
      return r.rows.map((x) => rowToEvent(x as Record<string, unknown>));
    }
    // Newest N, returned oldest→newest so the log renders in order.
    const r = await pool.query(
      `SELECT * FROM (
         SELECT * FROM "zie_krios_events" ORDER BY id DESC LIMIT $1
       ) t ORDER BY id ASC`,
      [lim],
    );
    return r.rows.map((x) => rowToEvent(x as Record<string, unknown>));
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: eventsSince failed");
    return [];
  }
}

/** Current max event id (SSE stream starting cursor). */
export async function maxCursor(): Promise<number> {
  try {
    const r = await pool.query(`SELECT COALESCE(MAX(id), 0) AS c FROM "zie_krios_events"`);
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Durable dedup: what the reconciler has ALREADY emitted for a run, read back
 * from zie_krios_events. The conductor's in-memory high-water map is seeded from
 * this on first touch so that, after a server restart, previously-emitted
 * step_done / promoted / awaiting_approval / terminal events are NOT re-emitted
 * (which would spam the Floor + log on every boot). Returns null on error so the
 * caller can fall back to the empty (fresh) high-water mark.
 */
export interface EmittedProgress {
  /** Highest step index for which a step_done/promoted event already exists, +1. */
  emittedSteps: number;
  /** A completed/failed event already exists for this run. */
  terminalDone: boolean;
  /** The step idx we already emitted awaiting_approval for (else null). */
  awaitingIdx: number | null;
}
export async function progressForRun(runId: string): Promise<EmittedProgress | null> {
  try {
    const r = await pool.query(
      `SELECT kind, (detail->>'step_idx') AS step_idx
         FROM "zie_krios_events"
        WHERE run_id = $1`,
      [runId],
    );
    if (r.rows.length === 0) {
      return { emittedSteps: 0, terminalDone: false, awaitingIdx: null };
    }
    let maxDoneIdx = -1;
    let awaitingIdx: number | null = null;
    let terminalDone = false;
    for (const row of r.rows as Record<string, unknown>[]) {
      const kind = String(row.kind);
      const idx = row.step_idx != null ? Number(row.step_idx) : null;
      if ((kind === "step_done" || kind === "promoted") && idx != null && idx > maxDoneIdx) {
        maxDoneIdx = idx;
      }
      if (kind === "awaiting_approval" && idx != null) {
        // If multiple, keep the highest (the currently-parked step).
        if (awaitingIdx == null || idx > awaitingIdx) awaitingIdx = idx;
      }
      if (kind === "completed" || kind === "failed") terminalDone = true;
    }
    // If the awaiting step was later emitted as done/promoted, it's resolved.
    if (awaitingIdx != null && awaitingIdx <= maxDoneIdx) awaitingIdx = null;
    return { emittedSteps: maxDoneIdx + 1, terminalDone, awaitingIdx };
  } catch (err) {
    logger.warn({ err: String(err), runId }, "krios: progressForRun failed");
    return null;
  }
}

// ── State projection ─────────────────────────────────────────────────────────
function emptyStageCounts(): Record<KriosStage, number> {
  const out = {} as Record<KriosStage, number>;
  for (const s of KRIOS_STAGES) out[s] = 0;
  return out;
}

/** In-flight (non-terminal) runs the conductor launched, newest first. */
async function inflightRuns(): Promise<KriosInflight[]> {
  try {
    const r = await pool.query(
      `SELECT r.id, r.goal, r.mcp_slug, r.tool_name, r.status, r.current_step,
              r.created_at,
              COALESCE(jsonb_array_length(r.plan), 0) AS total_steps
         FROM "zie_agent_runs" r
        WHERE r.created_by = $1
          AND r.status NOT IN ('completed','failed','cancelled')
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [KRIOS_CREATED_BY],
    );
    const out: KriosInflight[] = [];
    for (const row of r.rows as Record<string, unknown>[]) {
      const runId = String(row.id);
      const plan = (row_plan(row) ?? []) as Array<{ action_type?: string }>;
      const idx = Number(row.current_step ?? 0);
      const total = Number(row.total_steps ?? plan.length ?? 0);
      const curAction = plan[idx]?.action_type ?? plan[Math.max(0, total - 1)]?.action_type ?? "inspect_bucket";
      out.push({
        run_id: runId,
        goal: String(row.goal ?? ""),
        mcp_slug: (row.mcp_slug as string | null) ?? null,
        tool_name: (row.tool_name as string | null) ?? null,
        status: String(row.status ?? "running"),
        stage: stageForAction(curAction),
        current_step: idx,
        total_steps: total,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: inflightRuns failed");
    return [];
  }
}

// plan may arrive as a JS array (pg jsonb) — normalize.
function row_plan(row: Record<string, unknown>): unknown[] | null {
  const p = (row as { plan?: unknown }).plan;
  if (Array.isArray(p)) return p;
  return null;
}

/** KPI rollup over the trailing window (minutes). */
async function kpis(windowMin = 15): Promise<KriosKpis> {
  const out: KriosKpis = {
    in_flight: 0,
    queue_depth: 0,
    runs_per_min: 0,
    promotions_today: 0,
    failures_today: 0,
    pass_rate: 0,
  };
  try {
    const since = `now() - interval '${Math.max(1, windowMin)} minutes'`;
    // launches / completed / failed within the window, from events (authoritative feed)
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE kind='launched'   AND ts > ${since}) AS launches,
         COUNT(*) FILTER (WHERE kind='completed'  AND ts > ${since}) AS completed,
         COUNT(*) FILTER (WHERE kind='failed'     AND ts > ${since}) AS failed,
         COUNT(*) FILTER (WHERE kind='promoted'   AND ts > now() - interval '1 day') AS promos_today,
         COUNT(*) FILTER (WHERE kind='failed'     AND ts > now() - interval '1 day') AS fails_today
       FROM "zie_krios_events"`,
    );
    const row = r.rows[0] ?? {};
    const launches = Number(row.launches ?? 0);
    const completed = Number(row.completed ?? 0);
    const failed = Number(row.failed ?? 0);
    out.runs_per_min = Number((launches / Math.max(1, windowMin)).toFixed(2));
    out.promotions_today = Number(row.promos_today ?? 0);
    out.failures_today = Number(row.fails_today ?? 0);
    const denom = completed + failed;
    out.pass_rate = denom > 0 ? Number((completed / denom).toFixed(3)) : 0;
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: kpis failed");
  }
  return out;
}

/**
 * The queue is transient (rebuilt each tick by the conductor). We surface the
 * most recent tick's queued items from the event feed so the UI shows what the
 * conductor *intends* to launch next, without a separate table.
 */
async function currentQueue(): Promise<KriosQueueItem[]> {
  try {
    // Find the latest tick, then the queued events that belong to it (same or
    // newer id). Cheap + good-enough projection for the UI.
    const t = await pool.query(
      `SELECT id FROM "zie_krios_events" WHERE kind='tick' ORDER BY id DESC LIMIT 1`,
    );
    const tickId = Number(t.rows[0]?.id ?? 0);
    const r = await pool.query(
      `SELECT mcp_slug, tool_name, detail FROM "zie_krios_events"
        WHERE kind='queued' AND id >= $1 ORDER BY id ASC LIMIT 50`,
      [tickId],
    );
    return (r.rows as Record<string, unknown>[]).map((row) => {
      let detail: Record<string, unknown> = {};
      if (row.detail && typeof row.detail === "object") detail = row.detail as Record<string, unknown>;
      const kind = (detail.kind as string) === "train" ? "train" : "repair";
      return {
        mcp_slug: String(row.mcp_slug ?? ""),
        tool_name: (row.tool_name as string | null) ?? null,
        kind: kind as "repair" | "train",
        reason: String(detail.reason ?? ""),
      };
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: currentQueue failed");
    return [];
  }
}

async function lastTickTs(): Promise<string | null> {
  try {
    const r = await pool.query(
      `SELECT ts FROM "zie_krios_events" WHERE kind='tick' ORDER BY id DESC LIMIT 1`,
    );
    const ts = r.rows[0]?.ts;
    if (!ts) return null;
    return ts instanceof Date ? ts.toISOString() : String(ts);
  } catch {
    return null;
  }
}

/**
 * Full derived snapshot for GET /v1/krios/state. `enabled` reflects whether the
 * conductor timer is currently running (passed in by the route, which knows the
 * live daemon state); we also fold the config bounds in for the UI.
 */
export async function buildState(enabledNow: boolean): Promise<KriosState> {
  const [inflight, k, queue, tickTs, cursor] = await Promise.all([
    inflightRuns(),
    kpis(),
    currentQueue(),
    lastTickTs(),
    maxCursor(),
  ]);

  const stageCounts = emptyStageCounts();
  for (const run of inflight) stageCounts[run.stage] += 1;

  k.in_flight = inflight.length;
  k.queue_depth = queue.length;

  return {
    enabled: enabledNow,
    config: kriosPublicConfig(),
    stage_counts: stageCounts,
    in_flight: inflight,
    queue,
    kpis: k,
    last_tick_ts: tickTs,
    cursor,
  };
}

/** Count non-terminal Krios-launched runs (conductor capacity check). */
export async function inflightCount(): Promise<number> {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "zie_agent_runs"
        WHERE created_by = $1 AND status NOT IN ('completed','failed','cancelled')`,
      [KRIOS_CREATED_BY],
    );
    return Number(r.rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: inflightCount failed");
    // Fail safe: report at capacity so the conductor does not over-launch.
    return kriosConfig().maxInflight;
  }
}

export { TERMINAL as _KRIOS_TERMINAL };
