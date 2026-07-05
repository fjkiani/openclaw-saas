/**
 * routes/status.ts — GET /api/status
 *
 * Returns a comprehensive health summary of all subsystems:
 *   - database connectivity
 *   - archon (OpenRouter key presence)
 *   - workflow engine
 *   - forge (DRY_RUN mode)
 *   - env var checklist
 *
 * No auth required — safe to call from monitoring / CI.
 */
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

router.get("/status", async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Database
  try {
    const { pool } = await import("@workspace/db");
    const client = await pool.connect();
    const r = await client.query("SELECT current_database() AS db, version() AS ver");
    client.release();
    const row = r.rows[0];
    checks.database = {
      ok: true,
      detail: `${row.db} — ${String(row.ver).split(" ").slice(0, 2).join(" ")}`,
    };
  } catch (err: any) {
    checks.database = { ok: false, detail: err.message };
  }

  // 2. Archon / OpenRouter
  const hasOrKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2);
  checks.archon = {
    ok: hasOrKey,
    detail: hasOrKey ? "OPENROUTER_API_KEY set" : "OPENROUTER_API_KEY missing — skill generation disabled",
  };

  // 3. Workflow engine
  try {
    const { workflowEngine } = await import("../lib/workflowEngine.js");
    const skills = workflowEngine.listSkills();
    checks.workflow_engine = {
      ok: true,
      detail: `${skills.length} skill(s) registered: ${skills.join(", ")}`,
    };
  } catch (err: any) {
    checks.workflow_engine = { ok: false, detail: err.message };
  }

  // 4. Forge / DRY_RUN
  const dryRun = process.env.DRY_RUN === "true";
  checks.forge = {
    ok: true,
    detail: dryRun ? "DRY_RUN=true (Modal calls stubbed)" : "DRY_RUN=false (live Modal dispatch)",
  };

  // 5. Env var checklist
  const requiredVars = [
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "OPENCLAW_SERVICE_TOKEN",
    "NODE_ENV",
  ];
  const missingVars = requiredVars.filter((v) => !process.env[v]);
  checks.env_vars = {
    ok: missingVars.length === 0,
    detail:
      missingVars.length === 0
        ? `All ${requiredVars.length} required vars present`
        : `Missing: ${missingVars.join(", ")}`,
  };

  const allOk = Object.values(checks).every((c) => c.ok);

  res.status(allOk ? 200 : 207).json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
