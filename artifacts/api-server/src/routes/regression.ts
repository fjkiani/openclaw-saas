/**
 * regression.ts — regression suite CRUD + on-demand runs.
 *
 *   POST /v1/regression/tasks                    upsert a suite row
 *   GET  /v1/regression/tasks/:slug/:tool        list active cases
 *   DELETE /v1/regression/tasks/:id              soft-delete (active=false)
 *   POST /v1/workflow/regression/:slug/:tool     run whole suite against adapter
 *
 * `POST /v1/workflow/regression/*` is also called internally by workflow.ts
 * during promotion — a failing gate blocks the promote.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { runRegression } from "../lib/regressionSuite.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_TOKEN) return true;
  const got = req.header("x-openclaw-admin-token") ?? "";
  if (got !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return false;
  }
  return true;
}

router.post("/v1/regression/tasks", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const {
    mcp_slug,
    tool_name,
    prompt,
    gold_response,
    rubric,
    category,
    source,
  } = req.body ?? {};
  if (!mcp_slug || !tool_name || !prompt) {
    res.status(400).json({ ok: false, error: "mcp_slug, tool_name, prompt required" });
    return;
  }
  const r = await pool.query(
    `INSERT INTO zie_regression_suite
       (mcp_slug, tool_name, prompt, gold_response, rubric, category, source)
     VALUES ($1, $2, $3, $4, COALESCE($5, '{}'::jsonb), $6, COALESCE($7, 'playground'))
     RETURNING id, created_at`,
    [mcp_slug, tool_name, prompt, gold_response ?? null, rubric ? JSON.stringify(rubric) : null, category ?? null, source ?? null]
  );
  res.json({ ok: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
});

router.get("/v1/regression/tasks/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const r = await pool.query(
    `SELECT id, prompt, gold_response, rubric, category, source, created_at
     FROM zie_regression_suite
     WHERE mcp_slug=$1 AND tool_name=$2 AND active=true
     ORDER BY id ASC`,
    [slug, tool]
  );
  res.json({ ok: true, mcp_slug: slug, tool_name: tool, cases: r.rows });
});

router.delete("/v1/regression/tasks/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  await pool.query(`UPDATE zie_regression_suite SET active=false WHERE id=$1`, [id]);
  res.json({ ok: true, id });
});

router.post("/v1/workflow/regression/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const { slug, tool } = req.params;
  const adapter_id = (req.body && req.body.adapter_id) || `${slug}__${tool}`;
  try {
    const summary = await runRegression(slug, tool, adapter_id);
    res.json({ ok: true, mcp_slug: slug, tool_name: tool, adapter_id, ...summary });
  } catch (err) {
    logger.error({ err }, "regression run failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
