/**
 * routes/mcpTraining.ts — MCP training loop endpoints.
 *
 * Endpoints (mounted under /api/mcps/training):
 *   POST /invocations       — record an MCP tool invocation (usually from router)
 *   POST /invocations/:id/label — label an invocation (safe|unsafe|defer)
 *   GET  /health            — training buffer health
 *   GET  /pairs             — verified-pair counts per (slug, tool)
 *   POST /check-thresholds  — trigger a threshold check + dispatch pass
 *   GET  /policies          — current router policies
 *   POST /policies          — upsert a router policy (usually after training)
 *   POST /eval              — run inspection eval on a candidate router policy
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  recordInvocation,
  labelPair,
  verifiedPairCounts,
  checkAndDispatch,
  updatePolicy,
  getPolicy,
  listPolicies,
  health as trainingHealth,
  type MCPPairLabel,
} from "../lib/mcps/trainingLoop.js";
import { getMcp } from "../lib/mcps/registry.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const InvocationSchema = z.object({
  mcp_slug: z.string(),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.unknown().optional(),
  error: z.string().optional(),
  operator_id: z.string().optional(),
  tenant_id: z.number().optional(),
  latency_ms: z.number().optional(),
});

router.get("/health", (_req: Request, res: Response) => {
  res.json(trainingHealth());
});

router.post("/invocations", (req: Request, res: Response) => {
  const parsed = InvocationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid invocation", issues: parsed.error.issues });
    return;
  }
  // Cross-check: the mcp_slug should exist in the registry
  const registered = getMcp(parsed.data.mcp_slug);
  if (!registered) {
    res.status(404).json({ error: `MCP '${parsed.data.mcp_slug}' not registered — cannot record invocation` });
    return;
  }
  const pair = recordInvocation({
    ...parsed.data,
    invoked_at: new Date().toISOString(),
  });
  res.status(201).json({ pair });
});

router.post("/invocations/:id/label", (req: Request, res: Response) => {
  const label = String(req.body?.label ?? "") as MCPPairLabel;
  if (!["safe", "unsafe", "defer"].includes(label)) {
    res.status(400).json({ error: `label must be one of safe|unsafe|defer, got '${label}'` });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const labelled_by = (req as any).auth?.userId ?? req.body?.labelled_by;
  const pair = labelPair(req.params.id as string, label, reason, labelled_by);
  if (!pair) {
    res.status(404).json({ error: `pair '${req.params.id}' not found` });
    return;
  }
  res.json({ pair });
});

router.get("/pairs", (_req: Request, res: Response) => {
  const counts = verifiedPairCounts();
  res.json({ total: counts.length, counts });
});

router.post("/check-thresholds", async (_req: Request, res: Response) => {
  try {
    const results = await checkAndDispatch();
    logger.info(
      { dispatched: results.filter((r) => r.dispatched).length, total: results.length },
      "[mcp.training] threshold check pass",
    );
    res.json({ results });
  } catch (err: any) {
    logger.error({ err }, "[mcp.training] threshold check failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.get("/policies", (_req: Request, res: Response) => {
  res.json({ policies: listPolicies() });
});

const PolicyUpsertSchema = z.object({
  task_hint: z.string(),
  preferred_mcp_slug: z.string(),
  preferred_tool_name: z.string(),
  candidate_mcp_slugs: z.array(z.string()).default([]),
  based_on_pairs: z.number().default(0),
});

router.post("/policies", (req: Request, res: Response) => {
  const parsed = PolicyUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid policy", issues: parsed.error.issues });
    return;
  }
  const p = updatePolicy(
    parsed.data.task_hint,
    parsed.data.preferred_mcp_slug,
    parsed.data.preferred_tool_name,
    parsed.data.candidate_mcp_slugs,
    parsed.data.based_on_pairs,
  );
  res.json({ policy: p });
});

const EvalSchema = z.object({
  task_hint: z.string(),
  candidate_slug: z.string(),
  candidate_tool: z.string(),
});

/**
 * Inspection-only eval: score a candidate router policy without live invocation.
 * Real end-to-end eval requires the per-tenant runtime, this endpoint is a
 * pre-check that composes:
 *   - registry gate score for the candidate MCP
 *   - historical safe/unsafe pair count for the (mcp, tool) pair
 * Together they produce a `promote_ok` boolean that the policy manager can
 * consult before flipping the policy.
 */
router.post("/eval", (req: Request, res: Response) => {
  const parsed = EvalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid eval request", issues: parsed.error.issues });
    return;
  }
  const mcp = getMcp(parsed.data.candidate_slug);
  if (!mcp) {
    res.status(404).json({ error: `MCP '${parsed.data.candidate_slug}' not registered` });
    return;
  }
  const gateScore = mcp.gateReport?.overallScore ?? 0;
  const gateGrade = mcp.gateReport?.grade ?? "INCONCLUSIVE";
  const counts = verifiedPairCounts().find(
    (c) => c.mcp_slug === mcp.slug && c.tool_name === parsed.data.candidate_tool,
  );
  const verified = counts?.verified_pairs ?? 0;
  const promote_ok =
    gateGrade !== "FAILED" && verified >= 10; // simple rubric
  const existing = getPolicy(parsed.data.task_hint);
  res.json({
    task_hint: parsed.data.task_hint,
    candidate_slug: parsed.data.candidate_slug,
    candidate_tool: parsed.data.candidate_tool,
    gate_score: gateScore,
    gate_grade: gateGrade,
    verified_pairs: verified,
    promote_ok,
    current_policy: existing ?? null,
    notes: [
      `Gate: ${gateGrade} (score ${gateScore})`,
      `Verified pairs: ${verified}`,
      promote_ok ? "Promotion criteria met" : "Waiting on more verified pairs or gate promotion",
    ],
  });
});

export const mcpTrainingRouter = router;
