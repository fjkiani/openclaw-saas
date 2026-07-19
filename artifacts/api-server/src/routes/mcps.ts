/**
 * routes/mcps.ts — MCP registry HTTP API.
 *
 * Endpoints (mounted under /api/mcps):
 *   GET  /            — list MCPs (filterable by category, gateStatus)
 *   GET  /health      — registry health probe
 *   GET  /:slug       — single MCP w/ gate report
 *   POST /register    — submit MCP manifest, runs L0-L3 validator, returns report
 *   POST /:slug/certify — human reviewer L4 sign-off (workspace-scoped)
 *   POST /:slug/install — tenant installs the MCP (workspace-scoped)
 *   GET  /:slug/gate  — latest gate report
 *
 * Design notes:
 *   - The validator is inspection-only (safe on the request path).
 *   - Live invocation of an MCP happens in the per-tenant runtime, not here.
 *   - /register is public so external submitters can propose; certify + install
 *     are workspace-scoped.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  listMcps,
  getMcp,
  registerMcp,
  certifyMcp,
  health as registryHealth,
} from "../lib/mcps/registry.js";
import type { McpManifest } from "../lib/mcps/validator.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// Zod schema for manifest submission
const McpManifestSchema = z.object({
  slug: z.string().min(3).max(64),
  name: z.string().min(3),
  description: z.string().min(20),
  category: z.string().min(2),
  vendor: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse", "websocket"]),
  entrypoint: z.string().min(3),
  entrypointType: z.enum(["npm", "pip", "container", "http"]),
  declaredTools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.unknown().optional(),
      }),
    )
    .min(1),
  declaredPrivileges: z
    .object({
      net: z.array(z.string()).optional(),
      fs: z.array(z.string()).optional(),
      env: z.array(z.string()).optional(),
    })
    .default({}),
  semver: z.string().optional(),
});

router.get("/health", (_req: Request, res: Response) => {
  res.json(registryHealth());
});

router.get("/", (req: Request, res: Response) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const gateStatus =
    typeof req.query.gateStatus === "string" ? req.query.gateStatus : undefined;
  const rows = listMcps({ category, gateStatus });
  res.json({
    total: rows.length,
    rows,
  });
});

router.get("/:slug", (req: Request, res: Response) => {
  const mcp = getMcp(req.params.slug as string);
  if (!mcp) {
    res.status(404).json({ error: `MCP '${req.params.slug}' not found` });
    return;
  }
  res.json(mcp);
});

router.post("/register", (req: Request, res: Response) => {
  const parsed = McpManifestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid manifest",
      issues: parsed.error.issues,
    });
    return;
  }
  const manifest: McpManifest = parsed.data as McpManifest;
  try {
    const { mcp, report } = registerMcp(manifest);
    logger.info(
      { slug: mcp.slug, grade: report.grade, score: report.overallScore },
      "[mcps.register] MCP registered",
    );
    res.status(201).json({ mcp, report });
  } catch (err: any) {
    logger.error({ err }, "[mcps.register] validator threw");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.post("/:slug/certify", (req: Request, res: Response) => {
  const reviewer = (req as any).auth?.userId ?? "reviewer-anonymous";
  const mcp = certifyMcp(req.params.slug as string, reviewer);
  if (!mcp) {
    res.status(404).json({ error: `MCP '${req.params.slug}' not found` });
    return;
  }
  res.json({ mcp });
});

router.post("/:slug/install", (req: Request, res: Response) => {
  const mcp = getMcp(req.params.slug as string);
  if (!mcp) {
    res.status(404).json({ error: `MCP '${req.params.slug}' not found` });
    return;
  }
  // Gate check: refuse install for FAILED MCPs
  if (mcp.gateStatus === "failed") {
    res.status(403).json({
      error: `MCP '${mcp.slug}' failed governance gate — install refused`,
      gate: mcp.gateReport,
    });
    return;
  }
  // NOTE: real tenant scoping goes via tenant_mcps + requireWorkspaceMember.
  // This is the reference path; DB integration lands with the drizzle
  // migration when the schema tables are online.
  res.json({
    installed: true,
    mcp,
    warning:
      mcp.gateStatus !== "passed"
        ? "MCP is CONDITIONAL — human reviewer sign-off recommended before prod"
        : undefined,
  });
});

router.get("/:slug/gate", (req: Request, res: Response) => {
  const mcp = getMcp(req.params.slug as string);
  if (!mcp?.gateReport) {
    res.status(404).json({ error: `no gate report for '${req.params.slug}'` });
    return;
  }
  res.json(mcp.gateReport);
});

export const mcpsRouter = router;
