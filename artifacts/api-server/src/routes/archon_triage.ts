/**
 * archon_triage.ts — read-only view of dispatched Archon actions.
 *
 *   GET  /v1/archon/triage?limit=50&slug=xxx    action log (append-only)
 *   POST /v1/archon/triage/tick                 manually trigger one Archon pass (admin)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { startArchonDaemon } from "../lib/archonDaemon.js";

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

router.get("/v1/archon/triage", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const slug = req.query.slug as string | undefined;
  const q = slug
    ? await pool.query(
        `SELECT id, mcp_slug, tool_name, action, reason, dispatched_at, result_ref, status
         FROM zie_archon_triage WHERE mcp_slug=$1
         ORDER BY dispatched_at DESC LIMIT $2`,
        [slug, limit]
      )
    : await pool.query(
        `SELECT id, mcp_slug, tool_name, action, reason, dispatched_at, result_ref, status
         FROM zie_archon_triage ORDER BY dispatched_at DESC LIMIT $1`,
        [limit]
      );
  res.json({ ok: true, count: q.rowCount, actions: q.rows });
});

router.post("/v1/archon/triage/tick", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  // Force one pass by temporarily flipping ENABLED and calling startArchonDaemon
  // once. Because the daemon is idempotent-ish, we just poke it manually by
  // running the compute function through a dynamic import.
  const { startArchonDaemon: _s } = await import("../lib/archonDaemon.js");
  process.env.ARCHON_TRIAGE_ENABLED = "1";
  _s(pool);
  res.json({ ok: true, dispatched: true, note: "daemon started; next tick will dispatch" });
});

export default router;
