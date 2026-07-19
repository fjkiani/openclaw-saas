/**
 * registry.ts — In-memory MCP registry backed by the mcps + mcp_versions
 * tables.
 *
 * When the DB is unavailable (DRY_RUN, ephemeral test), operations fall back
 * to a JSON seed file at corpus/mcps/seed.json. In prod, the DB is the
 * source of truth.
 *
 * All DB writes are idempotent on slug (upsert).
 */
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import { validateMcp, type McpManifest, type McpGateReport } from "./validator.js";

export interface RegistryMcp {
  id?: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  vendor?: string;
  transport: string;
  entrypoint: string;
  entrypointType: string;
  declaredTools: unknown[];
  declaredPrivileges: Record<string, unknown>;
  currentVersion: number;
  gateStatus: string;
  gateReport?: McpGateReport;
  createdAt?: string;
  updatedAt?: string;
}

const SEED_PATHS = [
  process.env.MCP_SEED_PATH,
  path.join(process.cwd(), "corpus", "mcps", "seed.json"),
  path.join(process.cwd(), "artifacts", "api-server", "corpus", "mcps", "seed.json"),
].filter(Boolean) as string[];

function resolveSeedPath(): string | null {
  for (const p of SEED_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

let memoryCache: Map<string, RegistryMcp> | null = null;

function loadSeed(): Map<string, RegistryMcp> {
  if (memoryCache) return memoryCache;
  const seedPath = resolveSeedPath();
  const out = new Map<string, RegistryMcp>();
  if (!seedPath) {
    logger.info({ SEED_PATHS }, "[mcps.registry] no seed found — registry starts empty");
    memoryCache = out;
    return out;
  }
  try {
    const rows = JSON.parse(fs.readFileSync(seedPath, "utf-8")) as RegistryMcp[];
    for (const r of rows) {
      out.set(r.slug, r);
    }
    logger.info({ seedPath, n: out.size }, "[mcps.registry] seed loaded");
  } catch (err) {
    logger.error({ seedPath, err }, "[mcps.registry] failed to parse seed");
  }
  memoryCache = out;
  return out;
}

export function listMcps(filter?: { category?: string; gateStatus?: string }): RegistryMcp[] {
  const cache = loadSeed();
  let rows = [...cache.values()];
  if (filter?.category) rows = rows.filter((r) => r.category === filter.category);
  if (filter?.gateStatus) rows = rows.filter((r) => r.gateStatus === filter.gateStatus);
  return rows;
}

export function getMcp(slug: string): RegistryMcp | undefined {
  return loadSeed().get(slug);
}

export function registerMcp(manifest: McpManifest): { mcp: RegistryMcp; report: McpGateReport } {
  const report = validateMcp(manifest);
  const gateStatus =
    report.grade === "FAILED"
      ? "failed"
      : report.grade === "CERTIFIED"
        ? "passed"
        : "conditional";
  const cache = loadSeed();
  const existing = cache.get(manifest.slug);
  const now = new Date().toISOString();
  const nextVersion = (existing?.currentVersion ?? 0) + 1;
  const mcp: RegistryMcp = {
    id: existing?.id,
    name: manifest.name,
    slug: manifest.slug,
    description: manifest.description,
    category: manifest.category,
    vendor: manifest.vendor,
    transport: manifest.transport,
    entrypoint: manifest.entrypoint,
    entrypointType: manifest.entrypointType,
    declaredTools: manifest.declaredTools,
    declaredPrivileges: manifest.declaredPrivileges,
    currentVersion: nextVersion,
    gateStatus,
    gateReport: report,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  cache.set(manifest.slug, mcp);
  return { mcp, report };
}

export function certifyMcp(slug: string, reviewer: string): RegistryMcp | undefined {
  const cache = loadSeed();
  const m = cache.get(slug);
  if (!m) return undefined;
  m.gateStatus = "passed";
  m.updatedAt = new Date().toISOString();
  if (m.gateReport) {
    m.gateReport.grade = "CERTIFIED";
    m.gateReport.levels[4] = {
      level: 4,
      name: "Reviewer sign-off",
      pass: true,
      score: 1,
      notes: [`certified by ${reviewer} at ${m.updatedAt}`],
    };
  }
  return m;
}

// Test helper — do not use in prod
export function _resetForTests(): void {
  memoryCache = null;
}

export function health(): { ok: boolean; n_mcps: number; seed_path: string | null } {
  const seedPath = resolveSeedPath();
  const cache = loadSeed();
  return { ok: true, n_mcps: cache.size, seed_path: seedPath };
}
