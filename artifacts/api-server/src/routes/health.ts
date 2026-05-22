import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Debug endpoint: look up what tenant + workspaces exist for a given userId.
// Used to diagnose ownership mismatches in dev/staging.
// GET /api/debug/user-context?userId=user_xxx
router.get("/debug/user-context", async (req, res) => {
  const { pool } = await import("@workspace/db");
  const userId = req.query.userId as string | undefined;
  if (!userId) { res.status(400).json({ error: "userId query param required" }); return; }
  const tenants = await pool.query("SELECT id, user_id, name FROM tenants WHERE user_id = $1", [userId]);
  const tenantIds = tenants.rows.map((r: any) => r.id);
  const workspaces = tenantIds.length
    ? await pool.query("SELECT id, tenant_id, name FROM model_workspaces WHERE tenant_id = ANY($1)", [tenantIds])
    : { rows: [] };
  res.json({ tenants: tenants.rows, workspaces: workspaces.rows });
});

export default router;
