/**
 * sovereign.ts — sovereign (on-prem / air-gapped) deployment API.
 *
 * Lets an admin generate a complete, self-contained deployment bundle (compose,
 * env template, Dockerfiles, scripts, README) for running OpenClaw inside a
 * tenant's own environment with a locally-hosted LLM and local auth — no
 * public-cloud dependency. This is the V2 capability for hedge funds,
 * hospitals, and compliance-bound tenants.
 *
 * Routes:
 *   POST /api/sovereign/bundle          — generate + download a tarball bundle
 *   POST /api/sovereign/bundle/preview  — preview the file list + contents (JSON)
 *   GET  /api/sovereign/config          — default config + available local models
 *
 * Auth: OPENCLAW_ADMIN_TOKEN (x-openclaw-admin-token) or Clerk JWT.
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger.js";
import zlib from "node:zlib";
import {
  generateSovereignBundle,
  defaultSovereignConfig,
  type SovereignConfig,
} from "../lib/sovereign/bundleGenerator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal dependency-free TAR+gzip writer (POSIX ustar).
// ─────────────────────────────────────────────────────────────────────────────

function tarHeader(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512, 0);
  const write = (str: string, off: number, len: number) => h.write(str, off, len, "utf-8");
  write(name.slice(0, 100), 0, 100);
  write(mode.toString(8).padStart(7, "0") + "\0", 100, 8);
  write("0000000\0", 108, 8); // uid
  write("0000000\0", 116, 8); // gid
  write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
  // checksum field filled with spaces before computing
  h.write("        ", 148, 8, "utf-8");
  write(type, 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
  return h;
}

function buildTarGz(files: { path: string; content: string; executable?: boolean }[], prefix: string): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const full = `${prefix}/${f.path}`;
    // emit directory entries
    const segs = full.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(tarHeader(dir, 0, 0o755, "5"));
      }
    }
    const data = Buffer.from(f.content, "utf-8");
    const mode = f.executable ? 0o755 : 0o644;
    parts.push(tarHeader(full, data.length, mode, "0"));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0)); // end-of-archive marker
  return zlib.gzipSync(Buffer.concat(parts));
}

const router = Router();

function isAdminTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!envToken) return false;
  const headerToken = req.headers["x-openclaw-admin-token"] as string | undefined;
  return !!headerToken && headerToken === envToken;
}

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (isAdminTokenRequest(req)) { next(); return; }
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/** GET /api/sovereign/config — defaults + suggested local models */
router.get("/config", requireAuth, (req: Request, res: Response) => {
  const tenant = String(req.query.tenant ?? "tenant");
  res.json({
    default: defaultSovereignConfig(tenant),
    suggested_models: {
      chat: ["llama3.1:8b", "llama3.1:70b", "mistral:7b", "qwen2.5:14b", "phi4:14b"],
      embed: ["nomic-embed-text", "mxbai-embed-large"],
    },
    notes: {
      local: "fully air-gapped; no external calls",
      hybrid: "local-first with cloud (Gemini/Groq) fallback",
      gpu: "set enableGpu=true with nvidia-container-toolkit for faster inference",
    },
  });
});

/** POST /api/sovereign/bundle/preview — JSON file list + contents */
router.post("/bundle/preview", requireAuth, (req: Request, res: Response) => {
  const cfg = (req.body ?? {}) as Partial<SovereignConfig> & { tenantName?: string };
  if (!cfg.tenantName) {
    res.status(400).json({ error: "tenantName required" });
    return;
  }
  try {
    const files = generateSovereignBundle(cfg as Partial<SovereignConfig> & { tenantName: string });
    res.json({
      tenant: cfg.tenantName,
      file_count: files.length,
      files: files.map((f) => ({ path: f.path, executable: !!f.executable, bytes: f.content.length, content: f.content })),
    });
  } catch (err) {
    logger.error({ err }, "[sovereign] preview failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/sovereign/bundle — generate + download a .tar.gz */
router.post("/bundle", requireAuth, async (req: Request, res: Response) => {
  const cfg = (req.body ?? {}) as Partial<SovereignConfig> & { tenantName?: string };
  if (!cfg.tenantName) {
    res.status(400).json({ error: "tenantName required" });
    return;
  }
  try {
    const files = generateSovereignBundle(cfg as Partial<SovereignConfig> & { tenantName: string });
    const tarball = buildTarGz(files, `${cfg.tenantName}-sovereign`);
    logger.info({ tenant: cfg.tenantName, files: files.length, bytes: tarball.length }, "[sovereign] bundle generated");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${cfg.tenantName}-sovereign.tar.gz"`);
    res.send(tarball);
  } catch (err) {
    logger.error({ err }, "[sovereign] bundle generation failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
