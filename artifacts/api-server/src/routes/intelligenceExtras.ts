/**
 * intelligenceExtras.ts — MCP benchmark + promotion gate + judge batch HTTP surface.
 *
 * Layered on top of the existing routes/judge.ts (single-pair judging via
 * lib/judgePair.ts). This router adds:
 *   • POST /api/v1/judge/pairs/batch     — judge N unverified pairs at once
 *   • GET  /api/v1/judge/summary          — counts + means per domain
 *   • POST /api/v1/judge/benchmark-mcp    — probe a real MCP server + score it
 *   • POST /api/v1/judge/promote          — read judge + bench signals, promote or not
 *   • GET  /api/v1/judge/promotions       — recent promotion gate decisions
 *
 * All routes are unprotected (like /api/mcps) so automation/dashboards can hit
 * them without a Clerk session.
 */
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";

import { judgePairById } from "../lib/judgePair.js";
import { benchmarkMcp } from "../lib/mcpBenchmark.js";
import { evaluatePromotion, listRecentPromotions } from "../lib/promotionGate.js";

export function intelligenceExtrasRouter(pool: Pool): Router {
  const router = Router();

  router.post("/judge/pairs/batch", async (req: Request, res: Response) => {
    try {
      const { domain, limit } = req.body ?? {};
      const list = await pool.query<{ id: string }>(
        `SELECT id FROM "zie_preference_pairs"
         WHERE judge_verified = false ${domain ? "AND domain = $1" : ""}
         ORDER BY created_at ASC
         LIMIT ${domain ? "$2" : "$1"}`,
        domain ? [domain, Number(limit ?? 25)] : [Number(limit ?? 25)],
      );
      const scored: unknown[] = [];
      let skipped = 0;
      for (const r of list.rows) {
        // eslint-disable-next-line no-await-in-loop
        const result = await judgePairById(r.id, pool);
        if (result.kind === "ok") scored.push(result.receipt);
        else skipped += 1;
      }
      res.json({ ok: true, scored_count: scored.length, skipped, scored });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/judge/benchmark-mcp", async (req: Request, res: Response) => {
    try {
      const { mcpSlug, mcpUrl, declaredTools, tenantId } = req.body ?? {};
      if (!mcpSlug || !mcpUrl) {
        res.status(400).json({ ok: false, error: "mcpSlug and mcpUrl required" });
        return;
      }
      const out = await benchmarkMcp(pool, { mcpSlug, mcpUrl, declaredTools, tenantId });
      res.json({ ok: true, result: out });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/judge/promote", async (req: Request, res: Response) => {
    try {
      const { domain, task_type, candidate_model_id, baseline_model_id, candidate_mcp_slug } =
        req.body ?? {};
      if (!domain || !task_type || !candidate_model_id || !baseline_model_id) {
        res.status(400).json({
          ok: false,
          error: "domain, task_type, candidate_model_id, baseline_model_id required",
        });
        return;
      }
      const out = await evaluatePromotion(pool, {
        domain,
        task_type,
        candidate_model_id,
        baseline_model_id,
        candidate_mcp_slug,
      });
      res.json({ ok: true, decision: out });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/judge/promotions", async (_req: Request, res: Response) => {
    try {
      const rows = await listRecentPromotions(pool, 25);
      res.json({ ok: true, rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/judge/summary", async (_req: Request, res: Response) => {
    try {
      const q = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE judge_verified = true)   AS verified,
           COUNT(*) FILTER (WHERE judge_verified = false)  AS unverified,
           COUNT(*)                                          AS total,
           AVG(judge_score_chosen)   FILTER (WHERE judge_verified = true) AS mean_chosen,
           AVG(judge_score_rejected) FILTER (WHERE judge_verified = true) AS mean_rejected
         FROM "zie_preference_pairs"`,
      );
      const perDomain = await pool.query(
        `SELECT domain, task_type,
                COUNT(*) FILTER (WHERE judge_verified = true) AS verified,
                COUNT(*)                                        AS total,
                AVG(judge_score_chosen - judge_score_rejected) FILTER (WHERE judge_verified = true) AS mean_margin
         FROM "zie_preference_pairs"
         GROUP BY domain, task_type
         ORDER BY total DESC
         LIMIT 20`,
      );
      res.json({ ok: true, overall: q.rows[0], per_domain: perDomain.rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
