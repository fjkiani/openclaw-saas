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
import { callOpenRouter, extractJson } from "../lib/archon/openrouter";
import { archonConfig as config } from "../lib/archon/config";

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

// Debug: test L1 judge directly — POST /api/archon/debug/l1
// Body: { description: string, implementation: string }
router.post("/archon/debug/l1", async (req: Request, res: Response): Promise<void> => {
  try {
    const { description, implementation } = req.body as { description?: string; implementation?: string };
    if (!description || !implementation) {
      res.status(400).json({ error: "description and implementation required" });
      return;
    }

    const L1_JUDGE_PROMPT = `You are a strict code quality judge for an AI skill marketplace.

Evaluate whether the TypeScript implementation correctly and completely implements the described behavior.

Score from 0-100:
- 90-100: Implementation fully matches description, handles all edge cases, clean code
- 70-89: Implementation mostly correct, minor gaps or missing edge cases
- 50-69: Implementation partially correct, significant gaps
- 30-49: Implementation attempts the task but has major correctness issues
- 0-29: Implementation does not match description or is fundamentally broken

Return ONLY valid JSON: {"score": <number 0-100>, "reasoning": "<one sentence>"}`;

    const userContent = `Description: ${description}

Implementation:
\`\`\`typescript
${implementation.slice(0, 3000)}
\`\`\`

Rate this implementation 0-100. Return JSON only.`;

    const raw = await callOpenRouter(
      config.reasoningModel,
      [{ role: "system", content: L1_JUDGE_PROMPT }, { role: "user", content: userContent }],
      0.1,
      config.reasoningModelFallbacks,
    );

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      parsed = null;
    }

    res.json({
      model: config.reasoningModel,
      raw_response: raw.slice(0, 2000),
      parsed,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
