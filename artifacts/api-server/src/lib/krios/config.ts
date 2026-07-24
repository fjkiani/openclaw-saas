/**
 * config.ts — env-driven knobs for Krios, the factory orchestrator.
 *
 * Feature-flagged so the whole conductor is INERT unless explicitly enabled.
 * Mirrors the agent/autopilot config style (envBool/envInt helpers, PORT-derived
 * self base URL, admin token forwarded on self-dispatch).
 *
 *   KRIOS_ENABLED       default 0     — the background conductor daemon
 *   KRIOS_POLL_MS       default 5000  — scan interval (hard floor 2000ms)
 *   KRIOS_MAX_INFLIGHT  default 3     — cap on concurrent non-terminal Krios runs
 *   KRIOS_MAX_PER_TICK  default 2     — cap on new launches per scan pass
 *   KRIOS_DEDUP_MIN     default 5     — suppress a new run for a bucket that
 *                                        launched within this many minutes
 *   KRIOS_SELF_BASE_URL default http://localhost:${PORT|3001}
 *   OPENCLAW_ADMIN_TOKEN               — guards POST /v1/krios/{enable,kick}
 *
 * NOTE: enabled is a live env read so the runtime toggle (POST /v1/krios/enable
 * flips process.env.KRIOS_ENABLED) and tests both observe changes immediately.
 */
import type { KriosConfig, KriosPublicConfig } from "./contract.js";

function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false";
}

function envInt(name: string, dflt: number, min = 0): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.max(min, v);
}

const PORT = process.env.PORT ?? "3001";

/** Read live each call so runtime toggles (POST /enable) + tests see changes. */
export function kriosConfig(): KriosConfig {
  return {
    enabled: envBool("KRIOS_ENABLED", false),
    pollMs: envInt("KRIOS_POLL_MS", 5000, 2000),
    maxInflight: envInt("KRIOS_MAX_INFLIGHT", 3, 1),
    maxPerTick: envInt("KRIOS_MAX_PER_TICK", 2, 1),
    dedupMin: envInt("KRIOS_DEDUP_MIN", 5, 1),
    baseUrl: process.env.KRIOS_SELF_BASE_URL ?? `http://localhost:${PORT}`,
    adminToken: process.env.OPENCLAW_ADMIN_TOKEN ?? "",
  };
}

/** Browser-safe subset (no base URL, no token). */
export function kriosPublicConfig(): KriosPublicConfig {
  const c = kriosConfig();
  return {
    pollMs: c.pollMs,
    maxInflight: c.maxInflight,
    maxPerTick: c.maxPerTick,
    dedupMin: c.dedupMin,
  };
}
