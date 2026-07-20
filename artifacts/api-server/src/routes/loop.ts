/**
 * loop.ts — agentic self-correcting loop endpoints.
 *
 * Mounted at /api/v1/loop by src/routes/index.ts.
 *
 * Endpoints:
 *   POST /v1/loop/run                          judge-then-A/B-repair one prompt
 *   POST /v1/loop/promote                      manual promotion of a loop run (admin)
 *   GET  /v1/loop/runs/:slug/:tool?limit=20    recent runs for a bucket
 *   GET  /v1/loop/settings/:slug/:tool         per-bucket auto-promote config
 *   PUT  /v1/loop/settings/:slug/:tool         update thresholds (admin)
 *
 * Rate limit: honors LOOP_MAX_RUNS_PER_HOUR (default 500) in an in-memory
 * sliding window (per api-server process).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "crypto";
import { pool } from "@workspace/db";
import { runInference } from "../lib/modal/inferenceClient.js";
import { runJudge } from "../lib/modal/loopJudgeClient.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";
const MAX_PER_HOUR = Number(process.env.LOOP_MAX_RUNS_PER_HOUR ?? 500);
const _rateStamps: number[] = [];

function checkRate(): { ok: boolean; retry_ms?: number } {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  while (_rateStamps.length && _rateStamps[0] < cutoff) _rateStamps.shift();
  if (_rateStamps.length >= MAX_PER_HOUR) {
    return { ok: false, retry_ms: _rateStamps[0] + 60 * 60 * 1000 - now };
  }
  _rateStamps.push(now);
  return { ok: true };
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_TOKEN) return true;
  const got = req.header("x-openclaw-admin-token") ?? "";
  if (got !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return false;
  }
  return true;
}

function pshash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

async function loadSettings(slug: string, tool: string) {
  const q = await pool.query(
    `SELECT auto_promote, min_margin::float AS min_margin,
            min_pairs_agree, min_confidence::float AS min_confidence
     FROM zie_loop_settings
     WHERE mcp_slug=$1 AND tool_name=$2`,
    [slug, tool]
  );
  if (q.rowCount) return q.rows[0];
  return {
    auto_promote: (process.env.AUTO_PROMOTE_DEFAULT ?? "false") === "true",
    min_margin: 0.6,
    min_pairs_agree: 25,
    min_confidence: 0.7,
  };
}

async function countAgreeingPairs(slug: string, tool: string, winner_model: string) {
  const q = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM zie_loop_runs
     WHERE mcp_slug=$1 AND tool_name=$2
       AND (
         (winner='a' AND repair_a_model=$3)
         OR (winner='b' AND repair_b_model=$3)
       )`,
    [slug, tool, winner_model]
  );
  return q.rows[0]?.n ?? 0;
}

async function insertPreferencePair(
  slug: string,
  tool: string,
  prompt: string,
  chosen: string,
  rejected: string,
  chosen_model: string,
  rejected_model: string,
  chosen_score: number,
  rejected_score: number,
  reasoning: string
): Promise<number | null> {
  try {
    const r = await pool.query(
      `INSERT INTO zie_preference_pairs
         (domain, task_type, source_kind, preference_source, prompt_hash,
          chosen_response_json, rejected_response_json,
          judge_verified, judge_score_chosen, judge_score_rejected, judge_reasoning,
          used_for_dpo)
       VALUES ($1, $2, 'loop_repair', 'judge_ab', $3,
               jsonb_build_object('response', $4::text, 'model', $5::text),
               jsonb_build_object('response', $6::text, 'model', $7::text),
               true, $8::numeric, $9::numeric, $10, false)
       RETURNING id`,
      [
        slug,
        tool,
        pshash(prompt),
        chosen,
        chosen_model,
        rejected,
        rejected_model,
        chosen_score,
        rejected_score,
        reasoning.slice(0, 500),
      ]
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "insertPreferencePair failed");
    return null;
  }
}

async function flipRouterPolicy(slug: string, tool: string, candidate_model: string): Promise<void> {
  const task_type = `${slug}:${tool}`;
  await pool.query(`DELETE FROM zie_router_policies WHERE task_type=$1`, [task_type]);
  await pool.query(
    `INSERT INTO zie_router_policies (task_type, fast_model_id, fast_provider, premium_model_id, confidence_threshold)
     VALUES ($1, $2, 'openrouter', $3, 0.7)`,
    [task_type, candidate_model, candidate_model]
  );
}

async function recordPromotionGate(
  slug: string,
  tool: string,
  candidate_model: string,
  baseline_model: string,
  eval_score: number,
  promoted: boolean
): Promise<number | null> {
  const r = await pool.query(
    `INSERT INTO zie_model_promotion_gates
       (domain, task_type, candidate_model_id, baseline_model_id, eval_score, promoted, promotion_date)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END)
     RETURNING id`,
    [slug, tool, candidate_model, baseline_model, eval_score, promoted]
  );
  return r.rows[0]?.id ?? null;
}

// ── POST /run ────────────────────────────────────────────────────────────────
router.post("/v1/loop/run", async (req: Request, res: Response): Promise<void> => {
  const t0 = Date.now();
  const rate = checkRate();
  if (!rate.ok) {
    res.status(429).json({ ok: false, error: "rate limit", retry_ms: rate.retry_ms });
    return;
  }
  const { mcp_slug, tool_name, prompt, adapter_id, orig_response: origOverride } = req.body ?? {};
  if (!mcp_slug || !tool_name || !prompt) {
    res.status(400).json({ ok: false, error: "mcp_slug, tool_name, prompt required" });
    return;
  }

  try {
    let orig_response = origOverride;
    let orig_model = "fast:inference";
    let cold_start = false;
    let inference_latency = 0;
    if (!orig_response) {
      const inf = await runInference({ mcp_slug, tool_name, prompt, adapter_id, max_new_tokens: 80 });
      orig_response = inf.completion;
      orig_model = inf.adapter_used;
      cold_start = inf.cold_start;
      inference_latency = inf.latency_ms;
    }

    const jud = await runJudge({ mcp_slug, tool_name, prompt, orig_response });

    const chosen = jud.winner === "b" ? jud.repair_b : jud.repair_a;
    const rejected = jud.winner === "b" ? jud.repair_a : jud.repair_b;

    const pref_pair_id = await insertPreferencePair(
      mcp_slug,
      tool_name,
      prompt,
      chosen.response,
      rejected.response,
      chosen.model,
      rejected.model,
      chosen.score,
      rejected.score,
      jud.reasoning
    );

    const runIns = await pool.query(
      `INSERT INTO zie_loop_runs
         (mcp_slug, tool_name, prompt, prompt_hash,
          orig_model, orig_response, orig_score,
          repair_a_model, repair_a_response, repair_a_score,
          repair_b_model, repair_b_response, repair_b_score,
          winner, judge_reasoning, judge_version, judge_margin, pref_pair_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, created_at`,
      [
        mcp_slug, tool_name, prompt, pshash(prompt),
        orig_model, orig_response, jud.orig_score,
        jud.repair_a.model, jud.repair_a.response, jud.repair_a.score,
        jud.repair_b.model, jud.repair_b.response, jud.repair_b.score,
        jud.winner, jud.reasoning, jud.judge_version, jud.margin, pref_pair_id,
      ]
    );
    const loop_run_id = runIns.rows[0].id;
    const created_at = runIns.rows[0].created_at;

    const settings = await loadSettings(mcp_slug, tool_name);
    let auto_promoted = false;
    let gate_id: number | null = null;
    let policy_flipped = false;
    const gate_reason: string[] = [];
    const agree_count = await countAgreeingPairs(mcp_slug, tool_name, chosen.model);
    if (
      settings.auto_promote &&
      jud.margin >= Number(settings.min_margin) &&
      agree_count >= Number(settings.min_pairs_agree) &&
      chosen.score >= Number(settings.min_confidence)
    ) {
      try {
        await flipRouterPolicy(mcp_slug, tool_name, chosen.model);
        policy_flipped = true;
        gate_id = await recordPromotionGate(
          mcp_slug, tool_name, chosen.model, rejected.model, chosen.score, true
        );
        await pool.query(
          `INSERT INTO zie_loop_promotions (loop_run_id, promoted, auto, gate_snapshot, promoted_by, reason)
           VALUES ($1, true, true, $2::jsonb, 'archon', $3)`,
          [
            loop_run_id,
            JSON.stringify({
              margin: jud.margin,
              min_margin: settings.min_margin,
              agree: agree_count,
              min_pairs_agree: settings.min_pairs_agree,
              confidence: chosen.score,
              min_confidence: settings.min_confidence,
              chosen_model: chosen.model,
              rejected_model: rejected.model,
            }),
            `auto: margin ${jud.margin.toFixed(2)} >= ${settings.min_margin} + agree ${agree_count} >= ${settings.min_pairs_agree}`,
          ]
        );
        auto_promoted = true;
      } catch (err) {
        gate_reason.push(`policy flip failed: ${(err as Error).message}`);
        logger.warn({ err }, "auto-promote failed after gate passed");
      }
    } else {
      if (!settings.auto_promote) gate_reason.push("auto_promote disabled for bucket");
      if (jud.margin < Number(settings.min_margin))
        gate_reason.push(`margin ${jud.margin.toFixed(2)} < ${settings.min_margin}`);
      if (agree_count < Number(settings.min_pairs_agree))
        gate_reason.push(`agreeing pairs ${agree_count} < ${settings.min_pairs_agree}`);
      if (chosen.score < Number(settings.min_confidence))
        gate_reason.push(`winner score ${chosen.score.toFixed(2)} < ${settings.min_confidence}`);
    }

    res.json({
      ok: true,
      loop_run_id,
      created_at,
      pref_pair_id,
      orig: { model: orig_model, response: orig_response, score: jud.orig_score, cold_start, inference_latency },
      judge: {
        version: jud.judge_version,
        winner: jud.winner,
        margin: jud.margin,
        reasoning: jud.reasoning,
        mode: jud.mode,
      },
      repair_a: jud.repair_a,
      repair_b: jud.repair_b,
      gate: {
        auto_promoted,
        policy_flipped,
        promotion_gate_id: gate_id,
        agree_count,
        settings,
        reason: gate_reason,
      },
      total_latency_ms: Date.now() - t0,
    });
  } catch (err) {
    logger.error({ err }, "loop/run failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── POST /promote ──────────────────────────────────────────────────────────
router.post("/v1/loop/promote", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const { loop_run_id, promoted_by } = req.body ?? {};
  if (!loop_run_id) {
    res.status(400).json({ ok: false, error: "loop_run_id required" });
    return;
  }
  const r = await pool.query(
    `SELECT id, mcp_slug, tool_name, winner, repair_a_model, repair_a_score,
            repair_b_model, repair_b_score, judge_margin
     FROM zie_loop_runs WHERE id=$1`,
    [loop_run_id]
  );
  if (!r.rowCount) {
    res.status(404).json({ ok: false, error: "loop_run not found" });
    return;
  }
  const run = r.rows[0];
  const chosen_model = run.winner === "b" ? run.repair_b_model : run.repair_a_model;
  const rejected_model = run.winner === "b" ? run.repair_a_model : run.repair_b_model;
  const chosen_score = Number(run.winner === "b" ? run.repair_b_score : run.repair_a_score);
  await flipRouterPolicy(run.mcp_slug, run.tool_name, chosen_model);
  const gate_id = await recordPromotionGate(
    run.mcp_slug, run.tool_name, chosen_model, rejected_model, chosen_score, true
  );
  await pool.query(
    `INSERT INTO zie_loop_promotions (loop_run_id, promoted, auto, gate_snapshot, promoted_by, reason)
     VALUES ($1, true, false, $2::jsonb, $3, 'manual promotion')`,
    [
      loop_run_id,
      JSON.stringify({
        chosen_model, rejected_model, chosen_score, margin: Number(run.judge_margin),
      }),
      promoted_by ?? "operator",
    ]
  );
  res.json({ ok: true, loop_run_id, promotion_gate_id: gate_id, chosen_model });
});

// ── GET /runs/:slug/:tool ──────────────────────────────────────────────────
router.get("/v1/loop/runs/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const r = await pool.query(
    `SELECT r.id, r.created_at, r.prompt, r.orig_score::float AS orig_score,
            r.repair_a_model, r.repair_a_score::float AS repair_a_score,
            r.repair_b_model, r.repair_b_score::float AS repair_b_score,
            r.winner, r.judge_margin::float AS judge_margin, r.judge_version,
            r.pref_pair_id,
            (SELECT p.promoted FROM zie_loop_promotions p
               WHERE p.loop_run_id=r.id ORDER BY p.created_at DESC LIMIT 1) AS promoted,
            (SELECT p.auto FROM zie_loop_promotions p
               WHERE p.loop_run_id=r.id ORDER BY p.created_at DESC LIMIT 1) AS promoted_auto
     FROM zie_loop_runs r
     WHERE r.mcp_slug=$1 AND r.tool_name=$2
     ORDER BY r.created_at DESC LIMIT $3`,
    [slug, tool, limit]
  );
  res.json({ ok: true, runs: r.rows, count: r.rowCount });
});

// ── GET /settings/:slug/:tool ──────────────────────────────────────────────
router.get("/v1/loop/settings/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const s = await loadSettings(slug, tool);
  res.json({ ok: true, mcp_slug: slug, tool_name: tool, settings: s });
});

// ── PUT /settings/:slug/:tool ──────────────────────────────────────────────
router.put("/v1/loop/settings/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const { slug, tool } = req.params;
  const { auto_promote, min_margin, min_pairs_agree, min_confidence } = req.body ?? {};
  const r = await pool.query(
    `INSERT INTO zie_loop_settings
       (mcp_slug, tool_name, auto_promote, min_margin, min_pairs_agree, min_confidence, updated_at)
     VALUES ($1, $2, COALESCE($3, false), COALESCE($4, 0.6), COALESCE($5, 25), COALESCE($6, 0.7), now())
     ON CONFLICT (mcp_slug, tool_name) DO UPDATE
       SET auto_promote = COALESCE(EXCLUDED.auto_promote, zie_loop_settings.auto_promote),
           min_margin = COALESCE(EXCLUDED.min_margin, zie_loop_settings.min_margin),
           min_pairs_agree = COALESCE(EXCLUDED.min_pairs_agree, zie_loop_settings.min_pairs_agree),
           min_confidence = COALESCE(EXCLUDED.min_confidence, zie_loop_settings.min_confidence),
           updated_at = now()
     RETURNING auto_promote, min_margin::float AS min_margin, min_pairs_agree, min_confidence::float AS min_confidence`,
    [slug, tool, auto_promote, min_margin, min_pairs_agree, min_confidence]
  );
  res.json({ ok: true, mcp_slug: slug, tool_name: tool, settings: r.rows[0] });
});

export default router;
