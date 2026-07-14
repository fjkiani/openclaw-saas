/**
 * routes/archon.ts — Archon skill forge routes (in-process on openclaw-api).
 *
 * Routes:
 *   POST /api/archon/generate   — start a skill forge run
 *   GET  /api/archon/run/:runId — poll run status (DB-backed, survives restarts)
 *   GET  /api/archon/runs       — list recent runs (last 20, from DB)
 *   GET  /api/archon/health     — health + key check
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createRun, getRunAsync, listRuns } from "../lib/archon/runStore";
import { runSkillForgePipeline } from "../lib/archon/pipeline";

const router: IRouter = Router();

router.get("/archon/health", (_req: Request, res: Response) => {
  const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2);
  res.json({
    status: "ok",
    service: "archon-factory",
    version: "1.2.0",
    mode: "in-process",
    run_store: "db-backed",
    openrouter_key_set: hasKey,
  });
});

router.post("/archon/generate", async (req: Request, res: Response): Promise<void> => {
  try {
    const { description } = req.body as { description?: string };
    if (!description?.trim()) {
      res.status(400).json({ error: "description is required" });
      return;
    }

    const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2);
    if (!hasKey) {
      res.status(503).json({
        error: "OPENROUTER_API_KEY not configured — skill generation unavailable",
        fix: "Set OPENROUTER_API_KEY in Render environment variables for openclaw-api",
      });
      return;
    }

    const run = createRun(description.trim());

    // Fire-and-forget — client polls /api/archon/run/:runId for status
    runSkillForgePipeline(run.runId, description.trim()).catch((err) => {
      console.error(`[archon] Pipeline ${run.runId} crashed:`, err);
    });

    res.json({
      runId: run.runId,
      status: run.status,
      pollUrl: `/api/archon/run/${run.runId}`,
      message: "Skill forge pipeline started",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DB-backed: survives Render restarts — falls back to DB SELECT on cache miss
router.get("/archon/run/:runId", async (req: Request, res: Response): Promise<void> => {
  try {
    const run = await getRunAsync(req.params["runId"] as string);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DB-backed: always authoritative across restarts
router.get("/archon/runs", async (_req: Request, res: Response): Promise<void> => {
  try {
    const runs = await listRuns(20);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
