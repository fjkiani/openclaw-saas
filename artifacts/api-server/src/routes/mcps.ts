/**
 * routes/mcps.ts — MCP registry HTTP API.
 *
 * Endpoints (mounted under /api/mcps):
 *   GET  /            — list MCPs (filterable by category, gateStatus)
 *   GET  /health      — registry health probe
 *   GET  /:slug       — single MCP w/ gate report
 *   POST /register    — submit MCP manifest, runs L0-L3 validator, returns report
 *   POST /scan-github — clone a public repo, extract MCP manifest, run gate
 *   POST /:slug/certify — human reviewer L4 sign-off (workspace-scoped)
 *   POST /:slug/install — tenant installs the MCP (workspace-scoped)
 *   POST /:slug/deploy-to-modal — materialise Modal FastMCP payload, dispatch (dry by default)
 *   POST /:slug/evaluate       — run 20-prompt red-team eval harness, return grade
 *   GET  /:slug/gate           — latest gate report
 *   GET  /:slug/metrics        — proxy to CF Workers MLOps aggregate
 *
 * Design notes:
 *   - The validator is inspection-only (safe on the request path).
 *   - Live invocation of an MCP happens in the per-tenant runtime, not here.
 *   - /register + /scan-github are public so external submitters can propose;
 *     certify + install + deploy-to-modal are workspace-scoped when Clerk is on.
 *   - deploy-to-modal + evaluate are behind *_DRY_RUN=1 by default so there
 *     is zero cloud-cost risk for the demo path.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  listMcps,
  getMcp,
  registerMcp,
  certifyMcp,
  health as registryHealth,
} from "../lib/mcps/registry.js";
import type { McpManifest } from "../lib/mcps/validator.js";
import { deployMcpToModal, healthCheck as modalHealth } from "../lib/modal/deployMcp.js";
import { evaluateMcp, health as evalHealth } from "../lib/mcps/evalHarness.js";
import { metrics as mlopsMetrics, health as mlopsHealth } from "../lib/cloudflare/mlopsClient.js";
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
  res.json({
    registry: registryHealth(),
    modal: modalHealth(),
    eval: evalHealth(),
    cloudflare_mlops: mlopsHealth(),
  });
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

// ─── Scan a GitHub repo for an MCP manifest ───────────────────────────────────
// Accepts { url } — clones the repo shallow into /tmp, walks a small set of
// well-known files (mcp.json, .mcp.json, pyproject.toml with mcp-server
// classifier, package.json with an "mcp" section), synthesises a manifest,
// and runs the same L0-L3 gate as /register.
const ScanGithubSchema = z.object({
  url: z.string().url(),
  slug: z.string().optional(),
  category: z.string().optional(),
});

router.post("/scan-github", async (req: Request, res: Response) => {
  const parsed = ScanGithubSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }
  const url = parsed.data.url;
  // Very light URL sanity — must be github.com/<owner>/<repo>
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) {
    res.status(400).json({ error: "url must be a public github.com/<owner>/<repo>" });
    return;
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-mcp-scan-${owner}-${repo}-`));
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  try {
    const clone = spawnSync("git", ["clone", "--depth", "1", "--single-branch", cloneUrl, cloneDir], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    if (clone.status !== 0) {
      res.status(502).json({ error: "git clone failed", stderr: (clone.stderr ?? "").slice(0, 2000) });
      return;
    }
    // Look for known MCP-declaration files
    const candidates = ["mcp.json", ".mcp.json", "server.json", "package.json", "pyproject.toml", "README.md"];
    const found: Record<string, string> = {};
    for (const f of candidates) {
      const full = path.join(cloneDir, f);
      if (fs.existsSync(full)) {
        try {
          found[f] = fs.readFileSync(full, "utf-8").slice(0, 64_000);
        } catch {
          /* skip */
        }
      }
    }
    // Walk the repo for TS/JS/Py files where tool declarations live. We
    // support monorepos (apps/, packages/) by walking those roots too. Cap
    // at 40 files, 32 KB each, to keep the scan bounded. This is the
    // difference between finding "scanned_stub" and finding the real
    // @mcp.tool / server.tool decls.
    const walkRoots = ["src", "worker", "server", "app", "tools", "lib", "apps", "packages"];
    const codeExts = /\.(ts|tsx|mts|cts|js|mjs|cjs|py)$/;
    // Prefer files that look like tool-declaration modules — heuristic on
    // filename. This is a soft prioritisation so we always include e.g.
    // `*.tools.ts` even when there are many source files.
    const declLike = /(tool|server|index|main|mcp|handler|register)/i;
    let filesWalked = 0;
    const walk = (dir: string, base: string, depth: number) => {
      if (filesWalked >= 40 || depth > 5) return;
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (filesWalked >= 40) return;
        const full = path.join(dir, e);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        const rel = base ? `${base}/${e}` : e;
        if (st.isDirectory()) {
          // Skip node_modules, .git, dist, build, tests, examples
          if (/^(node_modules|\.git|dist|build|\.venv|__pycache__|tests?|__tests__|examples?|docs)$/.test(e)) continue;
          walk(full, rel, depth + 1);
        } else if (st.isFile() && codeExts.test(e)) {
          // Prioritise files whose name hints at tool declarations
          if (!declLike.test(e) && filesWalked > 30) continue;
          try {
            found[rel] = fs.readFileSync(full, "utf-8").slice(0, 32_000);
            filesWalked += 1;
          } catch { /* skip */ }
        }
      }
    };
    for (const root of walkRoots) {
      const full = path.join(cloneDir, root);
      if (fs.existsSync(full)) walk(full, root, 0);
    }

    // Best-effort manifest synthesis (tools inferred from README code blocks +
    // package.json/pyproject metadata). Deliberately conservative — the gate
    // will grade the honesty of the declaration.
    const slug = parsed.data.slug ?? `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
    const description = extractDescription(found) ?? `MCP scanned from ${cloneUrl}. Manifest inferred by openclaw-forge.`;
    const transport = detectTransport(found);
    const entrypointType = detectEntrypointType(found);
    const entrypoint = detectEntrypoint(found, entrypointType);
    const declaredTools = extractTools(found);
    const declaredPrivileges = extractPrivileges(found);

    const manifest: McpManifest = {
      slug,
      name: `${owner}/${repo}`,
      description: description.length > 20 ? description : `${description} (source: ${cloneUrl})`,
      category: parsed.data.category ?? "external",
      vendor: owner,
      transport,
      entrypoint,
      entrypointType,
      declaredTools,
      declaredPrivileges,
      semver: "0.0.1",
    };
    const { mcp, report } = registerMcp(manifest);
    logger.info(
      { slug: mcp.slug, url, grade: report.grade, tools: declaredTools.length },
      "[mcps.scan-github] scanned",
    );
    res.status(201).json({
      source_url: cloneUrl,
      files_seen: Object.keys(found),
      manifest,
      mcp,
      report,
      gateStatus: mcp.gateStatus,
    });
  } catch (err: any) {
    logger.error({ err, url }, "[mcps.scan-github] failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  } finally {
    // Best-effort cleanup
    try {
      fs.rmSync(cloneDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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

// ─── Deploy to Modal ─────────────────────────────────────────────────────────
router.post("/:slug/deploy-to-modal", async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const mcp = getMcp(slug);
  if (!mcp) {
    res.status(404).json({ error: `MCP '${slug}' not found` });
    return;
  }
  if (mcp.gateStatus === "failed") {
    res.status(403).json({ error: `MCP '${slug}' failed the gate — deploy refused`, gate: mcp.gateReport });
    return;
  }
  try {
    const result = await deployMcpToModal(mcp);
    logger.info(
      { slug, deploy_id: result.deploy_id, dry_run: result.dry_run },
      "[mcps.deploy-to-modal] dispatched",
    );
    res.status(201).json({
      slug,
      deploy_id: result.deploy_id,
      modal_app_url: result.modal_app_url,
      py_path: result.py_path,
      dry_run: result.dry_run,
      logs: result.logs,
    });
  } catch (err: any) {
    logger.error({ err, slug }, "[mcps.deploy-to-modal] failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── Evaluate (red-team suite) ───────────────────────────────────────────────
router.post("/:slug/evaluate", async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  try {
    const report = await evaluateMcp(slug);
    if (!report) {
      res.status(404).json({ error: `MCP '${slug}' not found` });
      return;
    }
    res.json(report);
  } catch (err: any) {
    logger.error({ err, slug }, "[mcps.evaluate] failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── Metrics (Cloudflare Workers MLOps proxy) ────────────────────────────────
router.get("/:slug/metrics", async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  try {
    const summary = await mlopsMetrics(slug);
    res.json(summary);
  } catch (err: any) {
    logger.error({ err, slug }, "[mcps.metrics] failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export const mcpsRouter = router;

// ─── Scan helpers ────────────────────────────────────────────────────────────

function extractDescription(found: Record<string, string>): string | undefined {
  if (found["mcp.json"] || found[".mcp.json"]) {
    try {
      const j = JSON.parse(found["mcp.json"] ?? found[".mcp.json"]);
      if (typeof j?.description === "string") return j.description;
    } catch {
      /* fallthrough */
    }
  }
  if (found["package.json"]) {
    try {
      const j = JSON.parse(found["package.json"]);
      if (typeof j?.description === "string") return j.description;
    } catch {
      /* skip */
    }
  }
  if (found["pyproject.toml"]) {
    const m = found["pyproject.toml"].match(/description\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  if (found["README.md"]) {
    const lines = found["README.md"].split("\n");
    for (const line of lines.slice(0, 40)) {
      if (line.trim().length >= 30 && !line.startsWith("#") && !line.startsWith("!")) {
        return line.trim().slice(0, 400);
      }
    }
  }
  return undefined;
}

function detectTransport(found: Record<string, string>): "stdio" | "http" | "sse" | "websocket" {
  const blob = Object.values(found).join("\n").toLowerCase();
  if (/wrangler\.toml|cloudflare|workers|modal\.run|streamable-http/.test(blob)) return "http";
  if (/websocket/.test(blob)) return "websocket";
  if (/sse/.test(blob)) return "sse";
  return "stdio";
}

function detectEntrypointType(found: Record<string, string>): "npm" | "pip" | "container" | "http" {
  if (found["package.json"]) return "npm";
  if (found["pyproject.toml"]) return "pip";
  if (Object.keys(found).some((f) => /dockerfile/i.test(f))) return "container";
  const blob = Object.values(found).join("\n").toLowerCase();
  if (/wrangler|modal deploy|modal\.run/.test(blob)) return "http";
  return "npm";
}

function detectEntrypoint(found: Record<string, string>, kind: "npm" | "pip" | "container" | "http"): string {
  if (kind === "npm" && found["package.json"]) {
    try {
      const j = JSON.parse(found["package.json"]);
      if (typeof j?.bin === "string") return j.bin;
      if (typeof j?.bin === "object" && j.bin) return Object.values<string>(j.bin)[0];
      if (j?.name) return `npx ${j.name}`;
    } catch {
      /* skip */
    }
    return "npx <scanned>";
  }
  if (kind === "pip" && found["pyproject.toml"]) {
    const m = found["pyproject.toml"].match(/name\s*=\s*"([^"]+)"/);
    if (m) return `python -m ${m[1].replace(/-/g, "_")}`;
    return "python -m <scanned>";
  }
  if (kind === "http") return "https://<worker-or-modal-url>";
  return "docker run <scanned>";
}

function extractTools(found: Record<string, string>): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  const tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
  // Prefer explicit mcp.json tools list if present
  const explicit = found["mcp.json"] ?? found[".mcp.json"] ?? found["server.json"];
  if (explicit) {
    try {
      const j = JSON.parse(explicit);
      if (Array.isArray(j?.tools)) {
        for (const t of j.tools) {
          if (typeof t?.name === "string") {
            tools.push({
              name: t.name,
              description: typeof t.description === "string" ? t.description : `Tool ${t.name} from manifest.`,
              input_schema: (t.input_schema ?? t.inputSchema ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
    } catch {
      /* fallthrough to README scan */
    }
  }
  if (tools.length > 0) return tools;

  // Extract from README + src/ code files. Look for tool declarations in
  // common MCP framework patterns:
  //   Python:  @mcp.tool()  \n def <name>(...)
  //            @server.tool(name="<name>")
  //   TS/JS:   server.tool("<name>", ...)  |  server.tool({ name: "<name>" })
  //            .tool({ name: "<name>", ...})
  //            registerTool("<name>", ...)
  //            (Cloudflare Agents SDK) @Tool({ name: "<name>", ...})
  //   README:  markdown mentions of tool identifiers in code fences
  const seen = new Set<string>();
  const codeBlob = Object.entries(found)
    .filter(([k]) => /\.(ts|tsx|mts|cts|js|mjs|cjs|py)$/.test(k) || k === "README.md")
    .map(([, v]) => v)
    .join("\n\n");
  // Pattern 1: @mcp.tool / @server.tool followed by a Python def
  const pyToolRegex = /@(?:mcp|server)\.tool\s*\([^)]*\)\s*(?:async\s+)?def\s+([a-z_][a-z0-9_]{1,63})/gi;
  let m: RegExpExecArray | null;
  while ((m = pyToolRegex.exec(codeBlob)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      tools.push({ name, description: `${name} — extracted from @mcp.tool decorator.`, input_schema: { input: "string" } });
      if (tools.length >= 30) break;
    }
  }
  // Pattern 2: server.tool("name", ...) / server.tool({ name: "..." })
  const jsToolRegex = /(?:server|mcp|agent)\.(?:tool|registerTool)\s*\(\s*(?:['"]([a-z][a-z0-9_]{2,63})['"]|\{[^}]*name\s*:\s*['"]([a-z][a-z0-9_]{2,63})['"])/gi;
  while ((m = jsToolRegex.exec(codeBlob)) !== null) {
    const name = m[1] ?? m[2];
    if (name && !seen.has(name)) {
      seen.add(name);
      tools.push({ name, description: `${name} — extracted from server.tool() call.`, input_schema: { input: "string" } });
      if (tools.length >= 30) break;
    }
  }
  // Pattern 3: @Tool({ name: "..." }) — Cloudflare Agents SDK decorators
  const decoratorToolRegex = /@Tool\s*\(\s*\{[^}]*name\s*:\s*['"]([a-z][a-z0-9_]{2,63})['"]/gi;
  while ((m = decoratorToolRegex.exec(codeBlob)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      tools.push({ name, description: `${name} — extracted from @Tool() decorator.`, input_schema: { input: "string" } });
      if (tools.length >= 30) break;
    }
  }
  // Fallback: README-only mentions
  const readme = found["README.md"] ?? "";
  const readmeRegex = /(?:@mcp\.tool|server\.tool|mcp\.tool|"name"\s*:\s*)['"]?([a-z][a-z0-9_]{2,64})['"]?/gi;
  while ((m = readmeRegex.exec(readme)) !== null) {
    const name = m[1];
    if (!seen.has(name) && !/^https?$/.test(name) && !/^(the|and|for|from|npx|pip|pnpm)$/.test(name)) {
      seen.add(name);
      tools.push({ name, description: `${name} — extracted from README of scanned repo.`, input_schema: { input: "string" } });
      if (tools.length >= 30) break;
    }
  }
  if (tools.length > 0) return tools;

  // Fallback: infer generic tool names from README table entries
  const bulletRegex = /^\s*[-*]\s+`([a-z][a-z0-9_]{2,64})`/gm;
  while ((m = bulletRegex.exec(readme)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      tools.push({
        name,
        description: `${name} — bulletised in README of scanned repo.`,
        input_schema: { input: "string" },
      });
      if (tools.length >= 20) break;
    }
  }

  if (tools.length === 0) {
    tools.push({ name: "scanned_stub", description: "Placeholder — no tools declared by repo. Manifest is conservative.", input_schema: {} });
  }
  return tools;
}

function extractPrivileges(found: Record<string, string>): { net?: string[]; fs?: string[]; env?: string[] } {
  const blob = Object.values(found).join("\n").toLowerCase();
  const net: string[] = [];
  const fs_: string[] = [];
  const env: string[] = [];
  if (/wrangler|workers\.dev/.test(blob)) net.push("*.workers.dev");
  if (/modal\.run/.test(blob)) net.push("*.modal.run");
  if (/api\.github\.com/.test(blob)) net.push("api.github.com");
  if (/read\(/.test(blob) || /fs\./.test(blob)) fs_.push("/tmp/");
  const envMatches = blob.match(/[A-Z][A-Z0-9_]{2,40}_(?:KEY|TOKEN|SECRET|ID)/g) ?? [];
  for (const e of envMatches.slice(0, 20)) env.push(e);
  return {
    net: net.length ? net : undefined,
    fs: fs_.length ? fs_ : undefined,
    env: env.length ? env : undefined,
  };
}
