/**
 * autopilotDaemon.ts — the autonomous side of the generic agent executor.
 *
 * Mirrors the archonDaemon lifecycle (module-level timer + re-entrancy guard,
 * env-gated, immediate first tick then interval, clean stop on SIGTERM). Where
 * archon dispatches single rule-based actions, autopilot launches a *full agent
 * run* (mode=autopilot) that plans and executes a DAG to drive a bucket toward
 * green. The executor itself handles auto-approval of gated steps within the
 * promotion gate (see executor.ts + actions.ts autoApprovable), so this daemon
 * only decides *when* to launch and guards against stacking runs.
 *
 * Opt-in per bucket via zie_autopilot_settings.enabled (toggled from the fleet
 * grid). Nothing runs unless a bucket is explicitly enabled AND AUTOPILOT_ENABLED=1.
 *
 * Env:
 *   AUTOPILOT_ENABLED     enable the daemon (default 0)
 *   AUTOPILOT_POLL_MS     poll interval (default 60000, min 10000)
 *   AUTOPILOT_MAX_PER_PASS max launches per tick (default 3)
 *   AUTOPILOT_DEDUP_MIN   suppress a new run for a bucket if one launched within
 *                         this many minutes (default 5) — the dedupe window.
 */
import type { Pool } from "pg";
import { logger } from "../logger.js";
import { startRun } from "./executor.js";
import { listRunsForBucket } from "./agentRunStore.js";

const ENABLED = () => (process.env.AUTOPILOT_ENABLED ?? "0") === "1";
const POLL_MS = () => Math.max(10_000, Number(process.env.AUTOPILOT_POLL_MS ?? 60_000));
const MAX_PER_PASS = () => Math.max(1, Number(process.env.AUTOPILOT_MAX_PER_PASS ?? 3));
const DEDUP_MIN = () => Math.max(1, Number(process.env.AUTOPILOT_DEDUP_MIN ?? 5));

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Worded to trigger the full diagnose->repair->verify->promote DAG in the mock
// planner (the "fix/green" rule). The fix DAG already includes a regression
// step, and its terminal promote_policy step is auto-approved by the executor
// only when the promotion gate is ready (see actions.ts autoApprovable) — this
// is what lets Autopilot actually drive a bucket toward green.
const AUTOPILOT_GOAL =
  "Autopilot: diagnose this broken bucket, repair the failing tool, and get it green by promoting the winner once it clears the gate.";

let _timer: NodeJS.Timeout | null = null;
let _running = false;

interface EnabledBucket {
  mcp_slug: string;
  tool_name: string;
}

/** Buckets the operator has switched Autopilot on for. */
async function enabledBuckets(pool: Pool): Promise<EnabledBucket[]> {
  try {
    const r = await pool.query(
      `SELECT mcp_slug, tool_name FROM "zie_autopilot_settings"
       WHERE enabled = true ORDER BY updated_at DESC`,
    );
    return r.rows.map((row: { mcp_slug: string; tool_name: string }) => ({
      mcp_slug: row.mcp_slug,
      tool_name: row.tool_name,
    }));
  } catch (err) {
    logger.warn({ err: String(err) }, "autopilot: settings query failed");
    return [];
  }
}

/** route stage green == lifecycle complete == nothing for autopilot to do. */
async function bucketIsGreen(base_url: string, slug: string, tool: string): Promise<boolean> {
  try {
    const r = await fetch(`${base_url}/api/v1/workflow/fleet`);
    const j = (await r.json()) as { rows?: Array<Record<string, any>> };
    const row = (j.rows ?? []).find((x) => x.mcp_slug === slug && x.tool_name === tool);
    if (!row) return false;
    return (row.stages?.route?.status ?? "grey") === "green";
  } catch {
    return false;
  }
}

/**
 * In-flight / dedupe guard: skip if this bucket already has a non-terminal
 * autopilot run, or launched one inside the dedupe window.
 */
async function hasRecentOrActiveRun(slug: string, tool: string): Promise<boolean> {
  try {
    const runs = await listRunsForBucket(slug, tool, 5);
    const cutoff = Date.now() - DEDUP_MIN() * 60_000;
    for (const run of runs) {
      if (run.mode !== "autopilot") continue;
      // active run of any age blocks a new launch
      if (!TERMINAL.has(run.status)) return true;
      // recently launched (even if done) → respect dedupe window
      const created = run.created_at ? new Date(run.created_at).getTime() : 0;
      if (created >= cutoff) return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err: String(err), slug, tool }, "autopilot: run-history check failed");
    // Fail safe: if we can't tell, do NOT launch (avoid stacking).
    return true;
  }
}

async function markLastRun(pool: Pool, slug: string, tool: string, runId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE "zie_autopilot_settings" SET last_run_id = $1, updated_at = now()
       WHERE mcp_slug = $2 AND tool_name = $3`,
      [runId, slug, tool],
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "autopilot: last_run_id update failed");
  }
}

async function tick(pool: Pool, base_url: string): Promise<void> {
  const buckets = await enabledBuckets(pool);
  if (buckets.length === 0) {
    logger.debug("autopilot: no enabled buckets");
    return;
  }
  let launched = 0;
  for (const b of buckets) {
    if (launched >= MAX_PER_PASS()) break;
    // Already green → nothing to drive.
    if (await bucketIsGreen(base_url, b.mcp_slug, b.tool_name)) {
      logger.debug({ slug: b.mcp_slug, tool: b.tool_name }, "autopilot: bucket green, skip");
      continue;
    }
    // Guard against stacking.
    if (await hasRecentOrActiveRun(b.mcp_slug, b.tool_name)) {
      logger.debug({ slug: b.mcp_slug, tool: b.tool_name }, "autopilot: active/recent run, skip");
      continue;
    }
    try {
      const run = await startRun({
        goal: AUTOPILOT_GOAL,
        mode: "autopilot",
        mcp_slug: b.mcp_slug,
        tool_name: b.tool_name,
        created_by: "autopilot",
      });
      await markLastRun(pool, b.mcp_slug, b.tool_name, run.id);
      launched += 1;
      logger.info(
        { slug: b.mcp_slug, tool: b.tool_name, run_id: run.id },
        "autopilot: launched agent run",
      );
    } catch (err) {
      logger.warn({ err: String(err), slug: b.mcp_slug, tool: b.tool_name }, "autopilot: launch failed");
    }
  }
  if (launched > 0) {
    logger.info({ launched }, "autopilot: pass complete");
  }
}

export function startAutopilotDaemon(pool: Pool, base_url = "http://localhost:3001"): void {
  if (!ENABLED()) {
    logger.info({ enabled: false }, "autopilot daemon disabled (AUTOPILOT_ENABLED != 1)");
    return;
  }
  if (_timer) return;
  logger.info({ poll_ms: POLL_MS() }, "autopilot daemon starting");
  const run = async () => {
    if (_running) return;
    _running = true;
    try {
      await tick(pool, base_url);
    } catch (err) {
      logger.warn({ err: String(err) }, "autopilot tick failed");
    } finally {
      _running = false;
    }
  };
  void run();
  _timer = setInterval(run, POLL_MS());
}

export function stopAutopilotDaemon(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
