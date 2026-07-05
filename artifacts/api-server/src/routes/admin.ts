/**
 * admin.ts — Internal admin endpoints for DB management and debugging.
 *
 * Routes:
 *   POST /api/admin/migrate   — trigger runMigrations() on demand (service token required)
 *   GET  /api/admin/tables    — list all tables in the public schema (service token required)
 */

import { Router, Request, Response } from "express";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAdminRouter(pool: any, runMigrations: () => Promise<void>): Router {
  const router = Router();

  // Service token guard
  function requireServiceToken(req: Request, res: Response, next: () => void): void {
    const envToken = process.env.OPENCLAW_SERVICE_TOKEN;
    if (!envToken) {
      res.status(503).json({ error: "Service token not configured" });
      return;
    }
    const bearer = (req.headers.authorization ?? "").startsWith("Bearer ")
      ? (req.headers.authorization as string).slice(7)
      : "";
    if (bearer !== envToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  /**
   * POST /api/admin/migrate
   * Trigger runMigrations() on demand. Useful when async startup migration failed.
   */
  router.post("/migrate", requireServiceToken as any, async (_req: Request, res: Response) => {
    logger.info("[admin] Manual migration triggered");
    try {
      await runMigrations();
      logger.info("[admin] Manual migration complete");
      res.json({ ok: true, message: "Migrations complete" });
    } catch (err: unknown) {
      logger.error({ err }, "[admin] Manual migration failed");
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /api/admin/tables
   * List all tables in the public schema with row counts.
   */
  router.get("/tables", requireServiceToken as any, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT
          t.table_name,
          (SELECT COUNT(*) FROM information_schema.columns c
           WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS column_count,
          pg_total_relation_size(quote_ident(t.table_name)) AS size_bytes
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);
      res.json({
        tables: result.rows,
        count: result.rows.length,
        has_workflow_definitions: result.rows.some(
          (r: { table_name: string }) => r.table_name === "workflow_definitions"
        ),
      });
    } catch (err: unknown) {
      logger.error({ err }, "[admin] GET /tables failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
