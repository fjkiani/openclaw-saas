/**
 * routes/stressBenchmarks.ts — Agent Robustness Benchmarks domain
 *
 * Mounted at /api/stress-benchmarks. All endpoints are read-only and serve
 * from an in-repo JSONL corpus (see corpus/stress-benchmarks/PROVENANCE.md).
 *
 * Endpoints:
 *   GET /api/stress-benchmarks/health       — corpus availability
 *   GET /api/stress-benchmarks/summary      — n_runs, leaderboard, breakdowns
 *   GET /api/stress-benchmarks/leaderboard  — leaderboard only
 *   GET /api/stress-benchmarks/models       — distinct models
 *   GET /api/stress-benchmarks/categories   — category rollup
 *   GET /api/stress-benchmarks/facets       — models + categories + domains + perturbations
 *   GET /api/stress-benchmarks/runs         — paginated + filterable rows
 */
import { Router, type IRouter, type Request, type Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  health as storeHealth,
  loadRuns,
  resolveCorpusDir,
} from "../lib/stress-benchmarks/runStore.js";
import {
  categoryBreakdown,
  domainBreakdown,
  facets,
  failureClassBreakdown,
  leaderboard,
  queryRuns,
  summary,
} from "../lib/stress-benchmarks/aggregate.js";
import type { StressSummary } from "../lib/stress-benchmarks/types.js";

const router: IRouter = Router();

/**
 * Read PROVENANCE.md line-by-line for the provenance block on /summary.
 * Falls back to unknown-marker values if the file is missing.
 */
function readProvenance(): StressSummary["provenance"] {
  const dir = resolveCorpusDir();
  const provenancePath = path.resolve(dir, "PROVENANCE.md");
  let source_repo = "unknown";
  let branch = "unknown";
  let commit = "unknown";
  try {
    const raw = fs.readFileSync(provenancePath, "utf-8");
    const repoMatch = raw.match(/\*\*Repo\*\*:\s*`([^`]+)`/);
    const branchMatch = raw.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
    const commitMatch = raw.match(/\*\*Commit\*\*:\s*`([^`]+)`/);
    if (repoMatch) source_repo = repoMatch[1];
    if (branchMatch) branch = branchMatch[1];
    if (commitMatch) commit = commitMatch[1];
  } catch {
    // Provenance is best-effort — corpus can still be served without it.
  }
  let generated_at = "unknown";
  try {
    generated_at = fs.statSync(path.resolve(dir, "runs.jsonl")).mtime.toISOString();
  } catch {
    /* corpus missing — health probe surfaces the error */
  }
  return { source_repo, branch, commit, generated_at };
}

router.get("/stress-benchmarks/health", (_req: Request, res: Response) => {
  const h = storeHealth();
  res.status(h.ok ? 200 : 503).json(h);
});

router.get("/stress-benchmarks/summary", (_req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    res.json(summary(runs, { provenance: readProvenance() }));
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

router.get("/stress-benchmarks/leaderboard", (_req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    res.json({
      n_runs: runs.length,
      leaderboard: leaderboard(runs),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

router.get("/stress-benchmarks/models", (_req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    res.json({ models: facets(runs).models });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

router.get("/stress-benchmarks/categories", (_req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    res.json({
      categories: categoryBreakdown(runs),
      domains: domainBreakdown(runs),
      failure_classes: failureClassBreakdown(runs),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

router.get("/stress-benchmarks/facets", (_req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    res.json(facets(runs));
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

router.get("/stress-benchmarks/runs", (req: Request, res: Response) => {
  try {
    const runs = loadRuns();
    const q = req.query as Record<string, string | undefined>;
    const page = queryRuns(runs, {
      model: q.model,
      category: q.category,
      domain: q.domain,
      perturbation_id: q.perturbation_id,
      passed:
        q.passed === "true" ? true : q.passed === "false" ? false : undefined,
      limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
      offset: q.offset ? Number.parseInt(q.offset, 10) : undefined,
    });
    res.json(page);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

export default router;
