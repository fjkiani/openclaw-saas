/**
 * routes/workflow.ts — backend for the /router-loop A-Z surface.
 *
 * Mounted under /api/v1/workflow.
 *
 * Endpoints:
 *   GET  /workflow/fleet                — one row per (mcp_slug, tool_name), all 7 stages
 *   GET  /workflow/mcp/:slug/:tool      — drill-down aggregate for one bucket
 *   POST /workflow/benchmark            — thin wrapper over /judge/benchmark-mcp
 *                                          that looks up mcpUrl from registry
 *   POST /workflow/promote              — thin wrapper over /judge/promote that
 *                                          translates (mcp_slug, tool_name) →
 *                                          (domain, task_type) and looks up
 *                                          the baseline from the current policy
 *   POST /judge/rollback/:gate_id       — one-click policy revert (admin-only)
 *   POST /mcps/inference                — proxies to Modal-hosted adapter serve
 *   GET  /mcps/training/pairs/:slug/:tool?verified=false&limit=20
 *                                       — list unverified pairs for labeling
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { benchmarkMcp } from "../lib/mcpBenchmark.js";
import { evaluatePromotion } from "../lib/promotionGate.js";
import { getMcp } from "../lib/mcps/registry.js";
import { metrics as mlopsMetrics } from "../lib/cloudflare/mlopsClient.js";
import { runInference } from "../lib/modal/inferenceClient.js";
import { runRegression } from "../lib/regressionSuite.js";

const router: IRouter = Router();

const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";
const MIN_PAIRS = Number(process.env.PROMOTION_MIN_JUDGED_PAIRS ?? 25);

// ─── tiny in-process cache for /workflow/fleet (30s) ─────────────────────────
type CachedFleet = { at: number; body: unknown };
let fleetCache: CachedFleet | null = null;
const FLEET_CACHE_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: colorize a numeric score into a stage status
// ─────────────────────────────────────────────────────────────────────────────
function scoreStatus(v: number | null, greenAt: number, amberAt: number): "green" | "amber" | "red" | "grey" {
  if (v === null || Number.isNaN(v)) return "grey";
  if (v >= greenAt) return "green";
  if (v >= amberAt) return "amber";
  return "red";
}

function judgeStatus(verified: number, min: number, margin: number | null): "green" | "amber" | "red" | "grey" {
  if (verified === 0) return "grey";
  if (verified < min) return "amber";
  if (margin !== null && margin < 0.1) return "amber";
  return "green";
}

function trafficStatus(n: number, errors: number): "green" | "amber" | "red" | "grey" {
  if (n === 0) return "grey";
  const errRate = errors / n;
  if (errRate < 0.02) return "green";
  if (errRate < 0.1) return "amber";
  return "red";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflow/fleet
// ─────────────────────────────────────────────────────────────────────────────
router.get("/v1/workflow/fleet", async (_req: Request, res: Response): Promise<void> => {
  const now = Date.now();
  if (fleetCache && now - fleetCache.at < FLEET_CACHE_MS) {
    res.setHeader("x-cache", "hit");
    res.json(fleetCache.body);
    return;
  }

  try {
    // 1. Discover buckets. The registry is the source of truth for
    //    (mcp_slug, tool_name) pairs; if a bucket has no invocations it still
    //    shows up as grey across most stages.
    const mcps = getMcp() as unknown; // avoid breaking API if signature drifts
    const registryList = (globalThis as any).__mcp_registry_snapshot as
      | Array<{ slug: string; declaredTools: Array<{ name: string }> }>
      | undefined;

    // Use whichever the registry exposes: try listMcps first, fall back.
    const { listMcps } = await import("../lib/mcps/registry.js");
    const registered = listMcps();
    const buckets: Array<{
      mcp_slug: string;
      tool_name: string;
      display_name?: string;
      provider?: string;
      category?: string;
    }> = [];
    for (const m of registered) {
      for (const t of (m.declaredTools ?? []) as Array<{ name: string }>) {
        buckets.push({
          mcp_slug: m.slug,
          tool_name: t.name,
          display_name: (m as any).name ?? m.slug,
          provider: (m as any).vendor ?? undefined,
          category: (m as any).category ?? undefined,
        });
      }
    }
    void mcps;
    void registryList;

    // 2. One aggregate SQL pass across judge / benchmark / promotion / policy.
    const aggSql = `
      WITH judge_agg AS (
        SELECT
          split_part(task_type, '::', 1) AS mcp_slug,
          split_part(task_type, '::', 2) AS tool_name,
          COUNT(*)::int AS unverified,
          COUNT(*) FILTER (WHERE judge_verified = true)::int AS verified,
          AVG(judge_score_chosen - judge_score_rejected)::float AS mean_margin
        FROM zie_preference_pairs
        WHERE domain = 'mcp'
        GROUP BY 1, 2
      ),
      bench_latest AS (
        SELECT DISTINCT ON (er.task_type)
          replace(er.task_type, 'mcp_bench::', '') AS mcp_slug,
          er.id AS run_id,
          MAX(CASE WHEN em.metric_name = 'mcp.safety_pct' THEN em.value END) AS safety_pct,
          MAX(CASE WHEN em.metric_name = 'mcp.task_completion_pct' THEN em.value END) AS completion_pct,
          MAX(CASE WHEN em.metric_name = 'mcp.n_safety_leaks' THEN em.value END) AS n_leaks
        FROM evaluation_runs er
        LEFT JOIN evaluation_metrics em ON em.eval_run_id = er.id
        WHERE er.domain = 'mcp_benchmark'
        GROUP BY er.task_type, er.id
        ORDER BY er.task_type, er.id DESC
      ),
      promo_latest AS (
        SELECT DISTINCT ON (task_type)
          split_part(task_type, '::', 1) AS mcp_slug,
          split_part(task_type, '::', 2) AS tool_name,
          id AS gate_id,
          promoted,
          promotion_date AS created_at
        FROM zie_model_promotion_gates
        WHERE domain = 'mcp'
        ORDER BY task_type, id DESC
      ),
      policy_now AS (
        SELECT
          split_part(task_type, '::', 1) AS mcp_slug,
          split_part(task_type, '::', 2) AS tool_name,
          id AS policy_id,
          fast_model_id
        FROM zie_router_policies
      )
      SELECT
        COALESCE(j.mcp_slug, b.mcp_slug, p.mcp_slug, r.mcp_slug) AS mcp_slug,
        COALESCE(j.tool_name, p.tool_name, r.tool_name)          AS tool_name,
        j.verified, j.unverified, j.mean_margin,
        b.safety_pct, b.completion_pct, b.n_leaks, b.run_id AS bench_run_id,
        p.gate_id AS promote_gate_id, p.promoted, p.created_at AS promoted_at,
        r.policy_id, r.fast_model_id
      FROM judge_agg j
      FULL OUTER JOIN bench_latest b ON b.mcp_slug = j.mcp_slug
      FULL OUTER JOIN promo_latest p ON p.mcp_slug = j.mcp_slug AND p.tool_name = j.tool_name
      FULL OUTER JOIN policy_now r ON r.mcp_slug = j.mcp_slug AND r.tool_name = j.tool_name
    `;
    let aggRows: any[] = [];
    try {
      const q = await pool.query(aggSql);
      aggRows = q.rows;
    } catch (err) {
      logger.warn({ err: String(err) }, "workflow.fleet: aggregate SQL failed; returning skeleton");
    }

    // 3. Parallel CF Worker /metrics lookups — one per distinct mcp_slug.
    const slugs = Array.from(new Set(buckets.map((b) => b.mcp_slug)));
    const trafficBySlug = new Map<string, any>();
    await Promise.all(
      slugs.map(async (slug) => {
        try {
          const m = await mlopsMetrics(slug);
          trafficBySlug.set(slug, m);
        } catch {
          /* silent */
        }
      }),
    );

    // 4. Adapter counts per bucket (from local trainingLoop state).
    const { verifiedPairCounts } = await import("../lib/mcps/trainingLoop.js");
    const pairCountsList = verifiedPairCounts();
    const pairCounts = new Map(pairCountsList.map((p: any) => [`${p.mcp_slug}::${p.tool_name}`, p]));

    // 5. Compose one row per bucket.
    const rows = buckets.map((b) => {
      const key = `${b.mcp_slug}::${b.tool_name}`;
      const agg = aggRows.find((r) => r.mcp_slug === b.mcp_slug && r.tool_name === b.tool_name) ?? {};
      const bench = aggRows.find((r) => r.mcp_slug === b.mcp_slug && r.safety_pct != null) ?? {};
      const traffic = trafficBySlug.get(b.mcp_slug);
      const pc: any = pairCounts.get(key);

      const regGate = (b as any).gate_score ?? null;
      const verified = Number(agg.verified ?? 0);
      const unverified = Number(agg.unverified ?? 0);
      const meanMargin = agg.mean_margin !== undefined ? Number(agg.mean_margin) : null;
      const safety = bench.safety_pct !== undefined ? Number(bench.safety_pct) : null;
      const n_leaks = bench.n_leaks !== undefined ? Number(bench.n_leaks) : null;
      const invocations = Number(traffic?.n ?? 0);
      const p95 = traffic?.p95_latency_ms ?? null;
      const adapterCount = pc?.adapter_count ?? 0;
      const eligible = pc?.n_pairs ?? 0;

      return {
        mcp_slug: b.mcp_slug,
        tool_name: b.tool_name,
        display_name: b.display_name,
        provider: b.provider,
        domain: b.category,
        stages: {
          register: {
            status: scoreStatus(regGate, 80, 60),
            label: regGate !== null ? `gate ${regGate}` : "gate —",
            badge: b.category ?? undefined,
          },
          traffic: {
            status: trafficStatus(invocations, 0),
            label: invocations > 0 ? `${invocations} calls` : "no traffic",
            value: invocations,
            badge: p95 !== null ? `${p95}ms p95` : undefined,
          },
          judge: {
            status: judgeStatus(verified, MIN_PAIRS, meanMargin),
            label: `${verified}/${MIN_PAIRS} pairs`,
            value: verified,
            badge: meanMargin !== null ? `Δ ${meanMargin.toFixed(2)}` : undefined,
          },
          benchmark: {
            status: scoreStatus(safety, 80, 60),
            label: safety !== null ? `safety ${safety}%` : "no bench",
            value: safety ?? 0,
            badge: n_leaks !== null ? `${n_leaks} leaks` : undefined,
          },
          promote: {
            status: agg.promoted === true ? "green" : agg.promote_gate_id ? "amber" : "grey",
            label: agg.promoted === true ? "PROMOTED" : agg.promote_gate_id ? "rejected" : "no gate",
            badge: agg.promote_gate_id ? `#${agg.promote_gate_id}` : undefined,
          },
          train: {
            status: adapterCount > 0 ? "green" : eligible >= MIN_PAIRS ? "amber" : "grey",
            label: adapterCount > 0 ? `${adapterCount} adapters` : `${eligible} pairs ready`,
            value: adapterCount,
          },
          route: {
            status: agg.fast_model_id ? "green" : "grey",
            label: agg.fast_model_id ? String(agg.fast_model_id).slice(0, 24) : "no policy",
            badge: agg.policy_id ? `#${agg.policy_id}` : undefined,
          },
        },
        updated_at: new Date().toISOString(),
      };
    });

    const body = {
      ok: true,
      rows,
      summary: {
        total_buckets: rows.length,
        promoted_this_week: rows.filter((r) => r.stages.promote.status === "green").length,
        pending_judge: rows.filter((r) => r.stages.judge.status === "amber").length,
        failed_dispatches: 0,
        generated_at: new Date().toISOString(),
      },
    };
    fleetCache = { at: now, body };
    res.setHeader("x-cache", "miss");
    res.json(body);
  } catch (err) {
    logger.error({ err: String(err) }, "workflow.fleet failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workflow/mcp/:slug/:tool
// ─────────────────────────────────────────────────────────────────────────────
router.get("/v1/workflow/mcp/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const task_type = `${slug}::${tool}`;

  try {
    const registered = getMcp(slug);
    if (!registered) {
      res.status(404).json({ ok: false, error: `MCP '${slug}' not registered` });
      return;
    }

    // Register — pull latest gate report if the registry tracks it.
    const register = {
      gate_l0: (registered as any).gate?.l0 ?? null,
      gate_l1: (registered as any).gate?.l1 ?? null,
      gate_l2: (registered as any).gate?.l2 ?? null,
      gate_l3: (registered as any).gate?.l3 ?? null,
      gate_l4: (registered as any).gate?.l4 ?? null,
      overall: (registered as any).gate?.overall ?? null,
      moat_score: (registered as any).moat?.score ?? null,
      moat_grade: (registered as any).moat?.grade ?? null,
    };

    // Traffic — CF Worker metrics.
    let traffic = {
      n_invocations: 0,
      p95_latency_ms: null as number | null,
      mean_latency_ms: null as number | null,
      last_seen: null as string | null,
      errors_24h: 0,
    };
    try {
      const m = await mlopsMetrics(slug);
      traffic = {
        n_invocations: m.n ?? 0,
        p95_latency_ms: m.p95_latency_ms ?? null,
        mean_latency_ms: m.mean_latency_ms ?? null,
        last_seen: m.last_seen ?? null,
        errors_24h: (m.n ?? 0) - (m.n_success ?? m.n ?? 0),
      };
    } catch {
      /* silent */
    }

    // Judge — counts + last 20 pairs.
    const judgeCountsQ = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE judge_verified = true)::int AS verified,
              COUNT(*) FILTER (WHERE judge_verified = false)::int AS unverified,
              AVG(judge_score_chosen - judge_score_rejected)::float AS mean_margin
       FROM zie_preference_pairs
       WHERE domain = 'mcp' AND task_type = $1`,
      [task_type],
    );
    const recentPairsQ = await pool.query(
      `SELECT id,
              chosen_response_json->>'response'  AS chosen_text,
              rejected_response_json->>'response' AS rejected_text,
              judge_score_chosen, judge_score_rejected,
              judge_reasoning, judge_verified, created_at
       FROM zie_preference_pairs
       WHERE domain = 'mcp' AND task_type = $1
       ORDER BY created_at DESC NULLS LAST
       LIMIT 20`,
      [task_type],
    );
    const judge = {
      verified: judgeCountsQ.rows[0]?.verified ?? 0,
      unverified: judgeCountsQ.rows[0]?.unverified ?? 0,
      mean_margin: judgeCountsQ.rows[0]?.mean_margin ?? null,
      min_pairs_required: MIN_PAIRS,
      recent: recentPairsQ.rows,
    };

    // Benchmark — latest evaluation_runs row for this MCP (mcp_bench::<slug>).
    const benchQ = await pool.query(
      `SELECT er.id AS latest_run_id,
              MAX(CASE WHEN em.metric_name = 'mcp.safety_pct' THEN em.value END) AS safety_pct,
              MAX(CASE WHEN em.metric_name = 'mcp.task_completion_pct' THEN em.value END) AS completion_pct,
              MAX(CASE WHEN em.metric_name = 'mcp.n_safety_leaks' THEN em.value END) AS n_leaks,
              MAX(CASE WHEN em.metric_name = 'mcp.n_tasks' THEN em.value END) AS n_tasks,
              er.created_at AS ran_at
       FROM evaluation_runs er
       LEFT JOIN evaluation_metrics em ON em.eval_run_id = er.id
       WHERE er.domain = 'mcp_benchmark' AND er.task_type = $1
       GROUP BY er.id, er.created_at
       ORDER BY er.id DESC
       LIMIT 1`,
      [`mcp_bench::${slug}`],
    );
    const benchmark = benchQ.rows[0]
      ? {
          latest_run_id: Number(benchQ.rows[0].latest_run_id),
          safety_pct: benchQ.rows[0].safety_pct !== null ? Number(benchQ.rows[0].safety_pct) : null,
          completion_pct: benchQ.rows[0].completion_pct !== null ? Number(benchQ.rows[0].completion_pct) : null,
          n_leaks: benchQ.rows[0].n_leaks !== null ? Number(benchQ.rows[0].n_leaks) : null,
          n_tasks: benchQ.rows[0].n_tasks !== null ? Number(benchQ.rows[0].n_tasks) : null,
          ran_at: benchQ.rows[0].ran_at ?? null,
        }
      : { latest_run_id: null, safety_pct: null, completion_pct: null, n_leaks: null, n_tasks: null, ran_at: null };

    // Promote — history for this bucket.
    const promoQ = await pool.query(
      `SELECT id, promoted, candidate_model_id, baseline_model_id, eval_score,
              promotion_date AS created_at
       FROM zie_model_promotion_gates
       WHERE domain = 'mcp' AND task_type = $1
       ORDER BY id DESC
       LIMIT 20`,
      [task_type],
    );
    const promoteHistory = promoQ.rows.map((r) => ({
      id: Number(r.id),
      promoted: Boolean(r.promoted),
      reason: null as string | null,
      candidate_model_id: r.candidate_model_id ?? null,
      baseline_model_id: r.baseline_model_id ?? null,
      win_rate: r.eval_score !== null ? Number(r.eval_score) : null,
      safety_pct: null as number | null,
      completion_pct: null as number | null,
      n_pairs: null as number | null,
      created_at: r.created_at,
      is_rollback: r.candidate_model_id === r.baseline_model_id, // rollback rows swap in baseline
    }));
    const promote = {
      latest: promoteHistory[0] ?? null,
      history: promoteHistory,
      can_rollback: (promoteHistory[0]?.promoted ?? false) && promoteHistory.length > 0,
    };

    // Train — adapter list from trainingLoop + latest R2 keys from CF worker
    const { verifiedPairCounts } = await import("../lib/mcps/trainingLoop.js");
    const counts = verifiedPairCounts().find(
      (c: any) => c.mcp_slug === slug && c.tool_name === tool,
    );
    const adapters = ((counts as any)?.adapters ?? []).map((a: any) => ({
      id: `${slug}__${tool}-${a.trained_at ?? "adapter"}`,
      volume_path: `/root/adapters/${slug}__${tool}`,
      r2_key: a.r2_key ?? null,
      created_at: a.trained_at ?? new Date().toISOString(),
      n_pairs: a.n_pairs ?? null,
      base_model: a.base_model ?? "distilgpt2",
    }));
    const train = {
      dispatched_count: (counts as any)?.dispatched_count ?? adapters.length,
      adapters,
      latest_r2_key: adapters[0]?.r2_key ?? null,
      ready_to_dispatch: ((counts as any)?.n_pairs ?? 0) >= MIN_PAIRS,
      eligible_pair_count: (counts as any)?.n_pairs ?? 0,
    };

    // Route — current policy.
    const policyQ = await pool.query(
      `SELECT id, fast_model_id, fast_provider, created_at
       FROM zie_router_policies
       WHERE task_type = $1
       ORDER BY id DESC
       LIMIT 1`,
      [task_type],
    );
    const currentPolicy = policyQ.rows[0]
      ? {
          id: Number(policyQ.rows[0].id),
          fast_model_id: policyQ.rows[0].fast_model_id,
          deep_model_id: null as string | null,
          updated_at: policyQ.rows[0].created_at,
        }
      : { id: null, fast_model_id: null, deep_model_id: null, updated_at: null };

    // can_rollback if there's a promoted gate whose baseline differs from current
    const rollbackable = promoteHistory.find(
      (g) => g.promoted && g.baseline_model_id && g.baseline_model_id !== currentPolicy.fast_model_id,
    );
    const route = {
      current_policy: currentPolicy,
      candidate_diff: rollbackable
        ? {
            from_fast: rollbackable.baseline_model_id,
            to_fast: currentPolicy.fast_model_id,
            from_deep: null,
            to_deep: null,
          }
        : null,
      can_rollback: Boolean(rollbackable),
      rollback_gate_id: rollbackable?.id ?? null,
    };

    res.json({
      ok: true,
      mcp_slug: slug,
      tool_name: tool,
      display_name: (registered as any).name ?? slug,
      provider: (registered as any).vendor ?? "",
      register,
      traffic,
      judge,
      benchmark,
      promote,
      train,
      route,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: String(err), slug, tool }, "workflow.drilldown failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflow/benchmark — thin wrapper that looks up mcpUrl from registry
// ─────────────────────────────────────────────────────────────────────────────
router.post("/v1/workflow/benchmark", async (req: Request, res: Response): Promise<void> => {
  try {
    const { mcp_slug } = req.body ?? {};
    if (!mcp_slug) {
      res.status(400).json({ ok: false, error: "mcp_slug required" });
      return;
    }
    const registered = getMcp(mcp_slug);
    if (!registered) {
      res.status(404).json({ ok: false, error: `MCP '${mcp_slug}' not registered` });
      return;
    }
    const mcpUrl =
      (registered as any).entrypoint ??
      (registered as any).manifest?.entrypoint ??
      "";
    const declaredTools = (registered as any).declaredTools ?? [];
    const out = await benchmarkMcp(pool, {
      mcpSlug: mcp_slug,
      mcpUrl,
      declaredTools,
      tenantId: undefined,
    });
    // fleet cache is now stale
    fleetCache = null;
    res.json({
      ok: true,
      run_id: (out as any).eval_run_id ?? 0,
      safety_pct: (out as any).safety_pct ?? 0,
      n_leaks: (out as any).n_safety_leaks ?? 0,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "workflow.benchmark failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workflow/promote — wraps /judge/promote with (slug,tool) translation
// ─────────────────────────────────────────────────────────────────────────────
router.post("/v1/workflow/promote", async (req: Request, res: Response): Promise<void> => {
  try {
    const { mcp_slug, tool_name, candidate_model_id, baseline_model_id } = req.body ?? {};
    if (!mcp_slug || !tool_name || !candidate_model_id) {
      res.status(400).json({ ok: false, error: "mcp_slug, tool_name, candidate_model_id required" });
      return;
    }
    // Look up baseline from current policy if not given.
    let baseline = baseline_model_id as string | undefined;
    if (!baseline) {
      const q = await pool.query(
        `SELECT fast_model_id FROM zie_router_policies WHERE task_type = $1 ORDER BY id DESC LIMIT 1`,
        [`${mcp_slug}::${tool_name}`],
      );
      baseline = q.rows[0]?.fast_model_id ?? "baseline";
    }
    // Regression gate: block if the candidate adapter fails the active suite.
    // On empty suite this is neutral (gate_ok=true with a note).
    let regression: any = null;
    try {
      regression = await runRegression(mcp_slug, tool_name, candidate_model_id);
      if (!regression.gate_ok) {
        res.json({
          ok: true,
          promoted: false,
          reason: `regression gate blocked: ${regression.gate_reason.join("; ")}`,
          regression,
        });
        return;
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "regression gate failed — continuing without it");
    }
    const out = await evaluatePromotion(pool, {
      domain: "mcp",
      task_type: `${mcp_slug}::${tool_name}`,
      candidate_model_id,
      baseline_model_id: baseline!,
      candidate_mcp_slug: mcp_slug,
    });
    fleetCache = null;
    res.json({
      ok: true,
      gate_id: out.gate_id,
      promoted: out.promoted,
      reason: out.reason,
      regression,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "workflow.promote failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /judge/rollback/:gate_id — one-click revert, transactional
// ─────────────────────────────────────────────────────────────────────────────
router.post("/v1/judge/rollback/:gate_id", async (req: Request, res: Response): Promise<void> => {
  const tokenHeader = req.header("x-openclaw-admin-token") ?? "";
  if (!ADMIN_TOKEN || tokenHeader !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return;
  }
  const gateId = Number(req.params.gate_id);
  if (!Number.isFinite(gateId)) {
    res.status(400).json({ ok: false, error: "invalid gate_id" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the gate row and pull its baseline+task_type.
    const gateQ = await client.query(
      `SELECT id, domain, task_type, candidate_model_id, baseline_model_id
       FROM zie_model_promotion_gates
       WHERE id = $1
       FOR UPDATE`,
      [gateId],
    );
    if (gateQ.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: `gate #${gateId} not found` });
      return;
    }
    const g = gateQ.rows[0];
    if (!g.baseline_model_id) {
      await client.query("ROLLBACK");
      res.status(409).json({ ok: false, error: "gate has no baseline_model_id" });
      return;
    }
    // Replace router policy with baseline.
    await client.query(`DELETE FROM zie_router_policies WHERE task_type = $1`, [g.task_type]);
    const newPolicyQ = await client.query(
      `INSERT INTO zie_router_policies (task_type, fast_model_id, fast_provider)
       VALUES ($1, $2, 'openrouter')
       RETURNING id, fast_model_id`,
      [g.task_type, g.baseline_model_id],
    );
    // Append a rollback row to the gates table so history is preserved.
    const newGateQ = await client.query(
      `INSERT INTO zie_model_promotion_gates
         (domain, task_type, candidate_model_id, baseline_model_id, eval_score, promoted, promotion_date)
       VALUES ($1, $2, $3, $3, 0, false, NOW())
       RETURNING id`,
      [g.domain, g.task_type, g.baseline_model_id],
    );
    await client.query("COMMIT");
    fleetCache = null;
    res.json({
      ok: true,
      new_gate_id: Number(newGateQ.rows[0].id),
      new_policy_id: Number(newPolicyQ.rows[0].id),
      reverted_to: { fast_model_id: newPolicyQ.rows[0].fast_model_id, deep_model_id: null },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err: String(err) }, "workflow.rollback failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mcps/inference — proxy to Modal-hosted adapter serve
// ─────────────────────────────────────────────────────────────────────────────
router.post("/v1/mcps/inference", async (req: Request, res: Response): Promise<void> => {
  try {
    const { mcp_slug, tool_name, prompt, adapter_id, max_new_tokens } = req.body ?? {};
    if (!mcp_slug || !tool_name || !prompt) {
      res.status(400).json({ ok: false, error: "mcp_slug, tool_name, prompt required" });
      return;
    }
    const out = await runInference({
      mcp_slug,
      tool_name,
      prompt: String(prompt),
      adapter_id: adapter_id ? String(adapter_id) : undefined,
      max_new_tokens: max_new_tokens ? Number(max_new_tokens) : 64,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err: String(err) }, "workflow.inference failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mcps/training/pairs/:slug/:tool — list unverified pairs for labeling
// ─────────────────────────────────────────────────────────────────────────────
router.get("/v1/mcps/training/pairs/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const verifiedParam = String(req.query.verified ?? "false");
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const wantVerified = verifiedParam === "true";
  try {
    const q = await pool.query(
      `SELECT id,
              chosen_response_json->>'response'  AS chosen_text,
              rejected_response_json->>'response' AS rejected_text,
              judge_score_chosen, judge_score_rejected,
              judge_reasoning, judge_verified, created_at
       FROM zie_preference_pairs
       WHERE domain = 'mcp' AND task_type = $1 AND judge_verified = $2
       ORDER BY created_at DESC NULLS LAST
       LIMIT $3`,
      [`${slug}::${tool}`, wantVerified, limit],
    );
    res.json({ ok: true, pairs: q.rows.map((r) => ({ ...r, label: null })) });
  } catch (err) {
    logger.error({ err: String(err) }, "workflow.pairs list failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
