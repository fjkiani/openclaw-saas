/**
 * archonDaemon.ts — polls the fleet snapshot every 30s (configurable) and
 * dispatches automated actions when a bucket enters a "needs attention" state.
 *
 * Rules (per plan §Archon triage):
 *   judge.status=red AND unverified>=10  → POST /judge/next-batch (label pairs)
 *   benchmark.status in {amber,red} AND last_run>=24h  → POST /workflow/benchmark
 *   train.eligible>=25 AND no adapter    → dispatch training
 *   route.status=green AND policy_age>=7d → dispatch regression run
 *
 * All dispatches are logged into zie_archon_triage (append-only).
 *
 * Enable with env ARCHON_TRIAGE_ENABLED=1
 * Interval: ARCHON_POLL_MS (default 30000, min 5000)
 * Max dispatches per pass: ARCHON_MAX_PER_PASS (default 5)
 */
import type { Pool } from "pg";
import { logger } from "./logger.js";

interface TriageAction {
  mcp_slug: string;
  tool_name: string | null;
  action: string;
  reason: string;
  dispatch: () => Promise<{ ok: boolean; ref?: string; err?: string }>;
}

const ENABLED = () => (process.env.ARCHON_TRIAGE_ENABLED ?? "0") === "1";
const POLL_MS = () => Math.max(5000, Number(process.env.ARCHON_POLL_MS ?? 30_000));
const MAX_PER_PASS = () => Math.max(1, Number(process.env.ARCHON_MAX_PER_PASS ?? 5));

let _timer: NodeJS.Timeout | null = null;
let _running = false;

const DEDUP_WINDOW_MIN = () => Math.max(1, Number(process.env.ARCHON_DEDUP_MIN ?? 30));

async function dispatchAction(
  pool: Pool,
  base_url: string,
  admin_token: string,
  action: TriageAction
): Promise<void> {
  // Suppress duplicate (slug, tool, action) dispatches inside the dedupe window.
  const dup = await pool.query(
    `SELECT 1 FROM zie_archon_triage
     WHERE mcp_slug=$1 AND tool_name=$2 AND action=$3
       AND dispatched_at > now() - ($4 || ' minutes')::interval
     LIMIT 1`,
    [action.mcp_slug, action.tool_name, action.action, String(DEDUP_WINDOW_MIN())],
  );
  if ((dup.rowCount ?? 0) > 0) return;
  const ins = await pool.query(
    `INSERT INTO zie_archon_triage (mcp_slug, tool_name, action, reason)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [action.mcp_slug, action.tool_name, action.action, action.reason]
  );
  const id = ins.rows[0].id;
  try {
    const result = await action.dispatch();
    await pool.query(
      `UPDATE zie_archon_triage SET status=$1, result_ref=$2 WHERE id=$3`,
      [result.ok ? "ok" : "failed", result.ref ?? result.err ?? null, id]
    );
  } catch (err) {
    await pool.query(
      `UPDATE zie_archon_triage SET status='failed', result_ref=$1 WHERE id=$2`,
      [(err as Error).message.slice(0, 200), id]
    );
  }
}

async function computeActions(pool: Pool, base_url: string, admin_token: string): Promise<TriageAction[]> {
  // Snapshot fleet via internal fetch (keeps rule logic in one place).
  let rows: any[] = [];
  try {
    const r = await fetch(`${base_url}/api/v1/workflow/fleet`);
    const j = await r.json();
    rows = j?.rows ?? [];
  } catch (err) {
    logger.warn({ err: String(err) }, "archon: fleet fetch failed");
    return [];
  }

  const actions: TriageAction[] = [];
  for (const row of rows) {
    const s = row.stages ?? {};
    const slug = row.mcp_slug as string;
    const tool = row.tool_name as string;

    // Rule 1: judge red/amber + unverified queue.
    // fleet judge.status never returns "red" today (only grey/amber/green), so
    // treat amber+high-unverified as the same trigger. Query pref_pairs directly
    // because the fleet response doesn't carry an unverified count.
    const judge = s.judge ?? {};
    let unverified = Number(judge.badge?.match?.(/(\d+)\s*unverified/)?.[1] ?? judge.unverified ?? 0);
    if (!unverified) {
      try {
        const q = await pool.query(
          `SELECT COUNT(*)::int AS c FROM zie_preference_pairs
           WHERE domain=$1 AND task_type=$2 AND judge_verified=false`,
          [slug, tool],
        );
        unverified = q.rows[0]?.c ?? 0;
      } catch {
        unverified = 0;
      }
    }
    // grey buckets with deep unverified queues also warrant a batch — that's
    // the "cold start" case where we've never judged anything but pairs exist.
    if (unverified >= 10) {
      logger.debug({ slug, tool, judge_status: judge.status, unverified }, "archon rule1 check");
    }
    if (
      (judge.status === "red" || judge.status === "amber" || (judge.status === "grey" && unverified >= 25)) &&
      unverified >= 10
    ) {
      actions.push({
        mcp_slug: slug, tool_name: tool, action: "judge_batch",
        reason: `judge red + ${unverified} unverified`,
        dispatch: async () => {
          // Batch-verify: create N judged pairs via POST /judge/next-batch (best effort).
          // If endpoint absent, just log a stub — we don't want to block the daemon.
          const r = await fetch(`${base_url}/api/v1/judge/next-batch`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-openclaw-admin-token": admin_token },
            body: JSON.stringify({ mcp_slug: slug, tool_name: tool, limit: 25 }),
          }).catch(() => null);
          if (!r) return { ok: false, err: "judge next-batch unreachable" };
          const j = await r.json().catch(() => ({}));
          return { ok: r.ok, ref: j?.batch_id ? String(j.batch_id) : `http-${r.status}` };
        },
      });
    }

    // Rule 2: benchmark stale/red
    const bench = s.benchmark ?? {};
    const benchStale = bench.last_run_age_hours && bench.last_run_age_hours >= 24;
    if ((bench.status === "red" || bench.status === "amber") && benchStale) {
      actions.push({
        mcp_slug: slug, tool_name: tool, action: "benchmark",
        reason: `benchmark ${bench.status} + ${bench.last_run_age_hours}h stale`,
        dispatch: async () => {
          const r = await fetch(`${base_url}/api/v1/workflow/benchmark`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-openclaw-admin-token": admin_token },
            body: JSON.stringify({ mcp_slug: slug, tool_name: tool }),
          }).catch(() => null);
          if (!r) return { ok: false, err: "benchmark unreachable" };
          const j = await r.json().catch(() => ({}));
          return { ok: r.ok, ref: j?.evaluation_run_id ? `evrun-${j.evaluation_run_id}` : `http-${r.status}` };
        },
      });
    }

    // Rule 3: training eligible + no adapter
    const train = s.train ?? {};
    const eligible = Number(train.eligible ?? train.badge?.match?.(/(\d+)\s*eligible/)?.[1] ?? 0);
    const hasAdapter = Boolean(train.adapter_id || (s.route?.badge ?? "").includes("adapter"));
    if (eligible >= 25 && !hasAdapter) {
      actions.push({
        mcp_slug: slug, tool_name: tool, action: "train",
        reason: `${eligible} eligible pairs + no adapter`,
        dispatch: async () => {
          const r = await fetch(`${base_url}/api/v1/mcps/training/dispatch`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-openclaw-admin-token": admin_token },
            body: JSON.stringify({ mcp_slug: slug, tool_name: tool }),
          }).catch(() => null);
          if (!r) return { ok: false, err: "dispatch unreachable" };
          const j = await r.json().catch(() => ({}));
          return { ok: r.ok, ref: j?.job_id ? String(j.job_id) : `http-${r.status}` };
        },
      });
    }

    // Rule 4: green + stale policy → regression check
    const route = s.route ?? {};
    const policyAge = Number(route.policy_age_days ?? 0);
    if (route.status === "green" && policyAge >= 7) {
      actions.push({
        mcp_slug: slug, tool_name: tool, action: "regression",
        reason: `policy age ${policyAge}d — periodic regression`,
        dispatch: async () => {
          const r = await fetch(`${base_url}/api/v1/workflow/regression/${slug}/${tool}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ adapter_id: `${slug}__${tool}` }),
          }).catch(() => null);
          if (!r) return { ok: false, err: "regression unreachable" };
          const j = await r.json().catch(() => ({}));
          return { ok: r.ok, ref: j?.pass_rate !== undefined ? `pr=${j.pass_rate}` : `http-${r.status}` };
        },
      });
    }
  }

  // Dedupe: only one action per (slug, tool, action) per pass.
  const seen = new Set<string>();
  const unique: TriageAction[] = [];
  for (const a of actions) {
    const k = `${a.mcp_slug}|${a.tool_name}|${a.action}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(a);
    }
  }
  return unique.slice(0, MAX_PER_PASS());
}

export function startArchonDaemon(pool: Pool, base_url = "http://localhost:3001", admin_token = process.env.OPENCLAW_ADMIN_TOKEN ?? ""): void {
  if (!ENABLED()) {
    logger.info({ enabled: false }, "archon daemon disabled (ARCHON_TRIAGE_ENABLED != 1)");
    return;
  }
  if (_timer) return;
  logger.info({ poll_ms: POLL_MS() }, "archon daemon starting");
  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const actions = await computeActions(pool, base_url, admin_token);
      if (actions.length) {
        logger.info({ count: actions.length }, "archon: dispatching");
      } else {
        logger.debug({ count: 0 }, "archon: tick idle");
      }
      for (const a of actions) {
        await dispatchAction(pool, base_url, admin_token, a);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "archon tick failed");
    } finally {
      _running = false;
    }
  };
  // First tick immediate, then interval.
  void tick();
  _timer = setInterval(tick, POLL_MS());
}

export function stopArchonDaemon(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
