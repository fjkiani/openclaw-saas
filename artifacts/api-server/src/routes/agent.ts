/**
 * agent.ts — routes for the generic agentic task executor (Agent Console + Autopilot).
 *
 *   POST /v1/agent/run                {goal, mode?, mcp_slug?, tool_name?}  -> {ok, run_id, pollUrl}
 *   GET  /v1/agent/run/:id                                                  -> full run + steps
 *   GET  /v1/agent/runs?limit=&mode=                                        -> recent runs
 *   POST /v1/agent/run/:id/approve    {step_idx, decision}                  -> resume/skip
 *   POST /v1/agent/run/:id/cancel                                           -> cancel
 *   GET  /v1/agent/actions                                                  -> registry catalog
 *   POST /v1/agent/autopilot          {mcp_slug, tool_name, enabled}        -> toggle per-bucket
 *   GET  /v1/agent/autopilot                                                -> list enabled buckets
 *
 * Fire-and-forget: POST /run returns immediately; the client polls GET /run/:id.
 * Feature-gated by AGENT_EXECUTOR_ENABLED (503 when disabled).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { agentConfig } from "../lib/agent/config.js";
import { startRun, approveStep, cancelRun } from "../lib/agent/executor.js";
import { actionCatalog } from "../lib/agent/actions.js";
import { getRun, listRuns, listRunsForBucket } from "../lib/agent/agentRunStore.js";
import type { AgentMode } from "../lib/agent/contract.js";

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

function requireEnabled(res: Response): boolean {
  if (!agentConfig.executorEnabled) {
    res.status(503).json({ ok: false, error: "agent executor disabled (AGENT_EXECUTOR_ENABLED=0)" });
    return false;
  }
  return true;
}

// ── POST /v1/agent/run ──────────────────────────────────────────────────────────
router.post("/v1/agent/run", async (req: Request, res: Response): Promise<void> => {
  if (!requireEnabled(res)) return;
  if (!requireAdmin(req, res)) return;
  const { goal, mode, mcp_slug, tool_name } = req.body ?? {};
  if (!goal || typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ ok: false, error: "goal (non-empty string) required" });
    return;
  }
  const m: AgentMode = mode === "autopilot" ? "autopilot" : "console";
  try {
    const run = await startRun({
      goal: goal.trim(),
      mode: m,
      mcp_slug: mcp_slug ?? null,
      tool_name: tool_name ?? null,
      created_by: (req as any).auth?.userId ?? "console",
    });
    res.json({ ok: true, run_id: run.id, pollUrl: `/api/v1/agent/run/${run.id}` });
  } catch (err) {
    logger.error({ err }, "[agent.route] start failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/agent/run/:id ─────────────────────────────────────────────────────────
router.get("/v1/agent/run/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  try {
    const run = await getRun(id, true);
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({ ok: true, run });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/agent/runs ─────────────────────────────────────────────────────────
router.get("/v1/agent/runs", async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const mode = req.query.mode === "autopilot" || req.query.mode === "console"
      ? (req.query.mode as AgentMode)
      : undefined;
    const runs = await listRuns(limit, mode);
    res.json({ ok: true, runs, count: runs.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── POST /v1/agent/run/:id/approve ────────────────────────────────────────────────
router.post("/v1/agent/run/:id/approve", async (req: Request, res: Response): Promise<void> => {
  if (!requireEnabled(res)) return;
  if (!requireAdmin(req, res)) return;
  const { step_idx, decision } = req.body ?? {};
  if (typeof step_idx !== "number" || (decision !== "approve" && decision !== "reject")) {
    res.status(400).json({ ok: false, error: "step_idx (number) + decision ('approve'|'reject') required" });
    return;
  }
  const id = String(req.params.id);
  try {
    const r = await approveStep(id, step_idx, decision, (req as any).auth?.userId ?? "user");
    if (!r.ok) {
      res.status(409).json(r);
      return;
    }
    const run = await getRun(id, true);
    res.json({ ok: true, run });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── POST /v1/agent/run/:id/cancel ─────────────────────────────────────────────────
router.post("/v1/agent/run/:id/cancel", async (req: Request, res: Response): Promise<void> => {
  if (!requireEnabled(res)) return;
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id);
  try {
    const r = await cancelRun(id);
    if (!r.ok) {
      res.status(409).json(r);
      return;
    }
    const run = await getRun(id, true);
    res.json({ ok: true, run });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/agent/actions ─────────────────────────────────────────────────────────
router.get("/v1/agent/actions", (_req: Request, res: Response): void => {
  res.json({ ok: true, actions: actionCatalog() });
});

// ── Autopilot toggle ───────────────────────────────────────────────────────────
router.post("/v1/agent/autopilot", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const { mcp_slug, tool_name, enabled } = req.body ?? {};
  if (!mcp_slug || !tool_name || typeof enabled !== "boolean") {
    res.status(400).json({ ok: false, error: "mcp_slug, tool_name, enabled(bool) required" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO "zie_autopilot_settings" (mcp_slug, tool_name, enabled, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (mcp_slug, tool_name)
       DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`,
      [mcp_slug, tool_name, enabled]
    );
    res.json({ ok: true, mcp_slug, tool_name, enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get("/v1/agent/autopilot", async (_req: Request, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT mcp_slug, tool_name, enabled, last_run_id, updated_at
       FROM "zie_autopilot_settings" ORDER BY updated_at DESC`
    );
    res.json({ ok: true, settings: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/agent/runs/bucket/:slug/:tool (for the fleet activity strip) ──────────
router.get("/v1/agent/runs/bucket/:slug/:tool", async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const tool = String(req.params.tool);
  try {
    const limit = Math.min(Number(req.query.limit ?? 5) || 5, 25);
    const runs = await listRunsForBucket(slug, tool, limit);
    res.json({ ok: true, runs, count: runs.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
