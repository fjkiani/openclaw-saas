import { Router, type Request, type Response } from "express";
import { createRun, getRun, listRuns } from "./runStore.js";
import { runSkillForgePipeline } from "./pipeline.js";
import { generateSkill, fixSkill } from "./skillGenerator.js";
import { validateSkill } from "./skillValidator.js";

const router = Router();

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "archon-factory", version: "1.0.0" });
});

// ─── Public: Forge a skill ────────────────────────────────────────────────────

router.post("/archon/generate", async (req: Request, res: Response) => {
  try {
    const { description } = req.body as { description?: string };
    if (!description?.trim()) {
      res.status(400).json({ error: "description is required" });
      return;
    }

    const run = createRun(description.trim());

    // Fire-and-forget pipeline
    runSkillForgePipeline(run.runId, description.trim()).catch((err) => {
      console.error(`Pipeline ${run.runId} crashed:`, err);
    });

    res.json({
      runId: run.runId,
      status: run.status,
      message: "Skill forge pipeline started",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Public: Poll run status ──────────────────────────────────────────────────

router.get("/archon/run/:runId", (req: Request, res: Response) => {
  const run = getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// ─── Public: List recent runs ─────────────────────────────────────────────────

router.get("/archon/runs", (_req: Request, res: Response) => {
  res.json(listRuns(20));
});

// ─── Internal: Generate skill (called by Archon bash nodes) ──────────────────

router.post("/internal/generate", async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body as { prompt?: string };
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const skill = await generateSkill(prompt);
    res.json(skill);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Internal: Validate skill (L0 check) ─────────────────────────────────────

router.post("/internal/validate", async (req: Request, res: Response) => {
  try {
    const skill = req.body;
    if (!skill?.implementation) {
      res.status(400).json({ error: "skill.implementation is required", l0_pass: false });
      return;
    }
    const result = validateSkill(skill);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err), l0_pass: false });
  }
});

// ─── Internal: Fix skill (called by Archon loop node) ────────────────────────

router.post("/internal/fix", async (req: Request, res: Response) => {
  try {
    const { skill, error } = req.body as { skill?: unknown; error?: string };
    if (!skill || !error) {
      res.status(400).json({ error: "skill and error are required" });
      return;
    }
    const fixed = await fixSkill(skill as Parameters<typeof fixSkill>[0], error);
    res.json(fixed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
