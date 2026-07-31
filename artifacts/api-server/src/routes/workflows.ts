/**
 * workflows.ts — REST API for workflow definitions and runs.
 *
 * Routes:
 *   GET    /api/workflows/definitions          — list workflow definitions for tenant
 *   POST   /api/workflows/definitions          — create a new workflow definition
 *   GET    /api/workflows/definitions/:id      — get a single definition
 *   DELETE /api/workflows/definitions/:id      — deactivate a definition
 *
 *   POST   /api/workflows/runs                 — start a new run
 *   GET    /api/workflows/runs                 — list runs for tenant (paginated)
 *   GET    /api/workflows/runs/:id             — get run status + output
 *   GET    /api/workflows/runs/:id/steps       — get step results for a run
 *   POST   /api/workflows/runs/:id/cancel      — cancel a pending/running run
 *
 *   GET    /api/workflows/policies             — list platform policies for tenant
 *   POST   /api/workflows/policies             — create a platform policy
 *   DELETE /api/workflows/policies/:id         — deactivate a policy
 *
 *   GET    /api/workflows/skills               — list registered skill handlers
 *
 * Auth: requireAuth (Clerk JWT) on all routes.
 */

import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger.js";
import { workflowEngine } from "../lib/workflowEngine.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper (matches pattern in tenants.ts / intelligence.ts)
// Supports three auth methods:
//   1. OPENCLAW_SERVICE_TOKEN (Bearer header)
//   2. OPENCLAW_ADMIN_TOKEN (x-openclaw-admin-token header)
//   3. Clerk JWT
// ─────────────────────────────────────────────────────────────────────────────

function isServiceTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_SERVICE_TOKEN;
  if (!envToken) return false;
  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return bearer.length > 0 && bearer === envToken;
}

function isAdminTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!envToken) return false;
  const headerToken = req.headers["x-openclaw-admin-token"] as string | undefined;
  return !!headerToken && headerToken === envToken;
}

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (isServiceTokenRequest(req)) { next(); return; }
  if (isAdminTokenRequest(req)) { next(); return; }
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function getUserId(req: Request): string {
  // Service token requests use DEMO_USER_ID as the tenant
  if (isServiceTokenRequest(req)) {
    return process.env.DEMO_USER_ID ?? "user_3DhVktxcTmcEqDWgYpMihDOy00t";
  }
  // Admin token requests also use DEMO_USER_ID
  if (isAdminTokenRequest(req)) {
    return process.env.DEMO_USER_ID ?? "user_3DhVktxcTmcEqDWgYpMihDOy00t";
  }
  return getAuth(req)?.userId ?? "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/workflows/definitions
 * List all active workflow definitions for the authenticated user's tenant.
 */
router.get(
  "/workflows/definitions",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 200);
    const offset = parseInt(String(req.query.offset ?? "0"));

    try {
      const result = await pool.query(
        `SELECT wd.*
         FROM workflow_definitions wd
         WHERE wd.tenant_id = $1
           AND wd.is_active = true
         ORDER BY wd.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      res.json({ definitions: result.rows, count: result.rows.length });
    } catch (err: unknown) {
      // 42P01 = "undefined_table" — migrations haven't run yet (async startup race).
      // Return empty array instead of 500 so the client can handle gracefully.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === "42P01") {
        logger.warn("workflow_definitions table not yet created — returning empty list");
        res.json({ definitions: [], count: 0, migrating: true }); return;
      }
      logger.error({ err }, "GET /workflows/definitions failed");
      res.status(500).json({ error: "Failed to fetch workflow definitions" });
    }
  }
);

/**
 * POST /api/workflows/definitions
 * Create a new workflow definition.
 */
router.post(
  "/workflows/definitions",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { name, description, trigger = "manual", steps = [], workspace_id, policy_id } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!Array.isArray(steps)) {
      res.status(400).json({ error: "steps must be an array" });
      return;
    }

    try {
      const result = await pool.query(
        `INSERT INTO workflow_definitions
           (tenant_id, workspace_id, name, description, trigger, steps, policy_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          userId,
          workspace_id ?? null,
          name,
          description ?? null,
          trigger,
          JSON.stringify(steps),
          policy_id ?? null,
          userId,
        ]
      );
      res.status(201).json({ definition: result.rows[0] });
    } catch (err: unknown) {
      logger.error({ err }, "POST /workflows/definitions failed");
      res.status(500).json({ error: "Failed to create workflow definition" });
    }
  }
);

/**
 * GET /api/workflows/definitions/:id
 */
router.get(
  "/workflows/definitions/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      const result = await pool.query(
        `SELECT * FROM workflow_definitions WHERE id = $1 AND tenant_id = $2`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Workflow definition not found" });
        return;
      }
      res.json({ definition: result.rows[0] });
    } catch (err: unknown) {
      logger.error({ err }, "GET /workflows/definitions/:id failed");
      res.status(500).json({ error: "Failed to fetch workflow definition" });
    }
  }
);

/**
 * DELETE /api/workflows/definitions/:id
 * Soft-delete (deactivate) a workflow definition.
 */
router.delete(
  "/workflows/definitions/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      const result = await pool.query(
        `UPDATE workflow_definitions
         SET is_active = false, updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Workflow definition not found" });
        return;
      }
      res.json({ success: true, id });
    } catch (err: unknown) {
      logger.error({ err }, "DELETE /workflows/definitions/:id failed");
      res.status(500).json({ error: "Failed to deactivate workflow definition" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/workflows/runs
 * Start a new workflow run.
 * Body: { definition_id, input?, trigger_kind? }
 */
router.post(
  "/workflows/runs",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { definition_id, input = {}, trigger_kind = "manual" } = req.body;

    if (!definition_id) {
      res.status(400).json({ error: "definition_id is required" });
      return;
    }

    try {
      const runId = await workflowEngine.startRun(
        definition_id,
        userId,
        input,
        { createdBy: userId, triggerKind: trigger_kind }
      );
      res.status(202).json({ run_id: runId, status: "pending" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "POST /workflows/runs failed");
      if (msg.includes("not found or inactive")) {
        res.status(404).json({ error: msg });
      } else {
        res.status(500).json({ error: "Failed to start workflow run" });
      }
    }
  }
);

/**
 * GET /api/workflows/runs
 * List runs for the authenticated user (paginated).
 */
router.get(
  "/workflows/runs",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const limit = Math.min(parseInt(String(req.query.limit ?? "20")), 100);
    const offset = parseInt(String(req.query.offset ?? "0"));
    const status = req.query.status as string | undefined;

    try {
      const params: unknown[] = [userId, limit, offset];
      let statusClause = "";
      if (status) {
        params.push(status);
        statusClause = `AND wr.status = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT wr.*, wd.name AS definition_name
         FROM workflow_runs wr
         LEFT JOIN workflow_definitions wd ON wd.id = wr.definition_id
         WHERE wr.tenant_id = $1
         ${statusClause}
         ORDER BY wr.created_at DESC
         LIMIT $2 OFFSET $3`,
        params
      );
      res.json({ runs: result.rows, count: result.rows.length });
    } catch (err: unknown) {
      logger.error({ err }, "GET /workflows/runs failed");
      res.status(500).json({ error: "Failed to fetch workflow runs" });
    }
  }
);

/**
 * GET /api/workflows/runs/:id
 */
router.get(
  "/workflows/runs/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      const run = await workflowEngine.getRun(id, userId);
      if (!run) {
        res.status(404).json({ error: "Workflow run not found" });
        return;
      }
      res.json({ run });
    } catch (err: unknown) {
      logger.error({ err }, "GET /workflows/runs/:id failed");
      res.status(500).json({ error: "Failed to fetch workflow run" });
    }
  }
);

/**
 * GET /api/workflows/runs/:id/steps
 */
router.get(
  "/workflows/runs/:id/steps",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      // Verify ownership
      const run = await workflowEngine.getRun(id, userId);
      if (!run) {
        res.status(404).json({ error: "Workflow run not found" });
        return;
      }
      const steps = await workflowEngine.getStepResults(id);
      res.json({ run_id: id, steps });
    } catch (err: unknown) {
      logger.error({ err }, "GET /workflows/runs/:id/steps failed");
      res.status(500).json({ error: "Failed to fetch step results" });
    }
  }
);

/**
 * POST /api/workflows/runs/:id/cancel
 */
router.post(
  "/workflows/runs/:id/cancel",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      const cancelled = await workflowEngine.cancelRun(id, userId);
      if (!cancelled) {
        res.status(404).json({ error: "Run not found or already completed" });
        return;
      }
      res.json({ success: true, run_id: id, status: "cancelled" });
    } catch (err: unknown) {
      logger.error({ err }, "POST /workflows/runs/:id/cancel failed");
      res.status(500).json({ error: "Failed to cancel workflow run" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Platform Policies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/workflows/policies
 */
router.get(
  "/workflows/policies",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const policy_type = req.query.policy_type as string | undefined;

    try {
      const params: unknown[] = [userId];
      let typeClause = "";
      if (policy_type) {
        params.push(policy_type);
        typeClause = `AND policy_type = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT * FROM platform_policies
         WHERE tenant_id = $1 AND is_active = true
         ${typeClause}
         ORDER BY created_at DESC`,
        params
      );
      res.json({ policies: result.rows });
    } catch (err: unknown) {
      logger.error({ err }, "GET /workflows/policies failed");
      res.status(500).json({ error: "Failed to fetch platform policies" });
    }
  }
);

/**
 * POST /api/workflows/policies
 */
router.post(
  "/workflows/policies",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { policy_type, name, description, rules = {} } = req.body;

    if (!policy_type || !name) {
      res.status(400).json({ error: "policy_type and name are required" });
      return;
    }

    try {
      const result = await pool.query(
        `INSERT INTO platform_policies
           (tenant_id, policy_type, name, description, rules, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, policy_type, name, description ?? null, JSON.stringify(rules), userId]
      );
      res.status(201).json({ policy: result.rows[0] });
    } catch (err: unknown) {
      logger.error({ err }, "POST /workflows/policies failed");
      res.status(500).json({ error: "Failed to create platform policy" });
    }
  }
);

/**
 * DELETE /api/workflows/policies/:id
 */
router.delete(
  "/workflows/policies/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = getUserId(req);
    const { id } = req.params;

    try {
      const result = await pool.query(
        `UPDATE platform_policies
         SET is_active = false, updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Policy not found" });
        return;
      }
      res.json({ success: true, id });
    } catch (err: unknown) {
      logger.error({ err }, "DELETE /workflows/policies/:id failed");
      res.status(500).json({ error: "Failed to deactivate policy" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Skills registry (read-only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/workflows/skills
 * Returns the list of registered skill handler IDs.
 */
router.get(
  "/workflows/skills",
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    res.json({ skills: workflowEngine.listSkills() });
  }
);

export default router;
