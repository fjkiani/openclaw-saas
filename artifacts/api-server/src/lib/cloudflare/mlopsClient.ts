/**
 * mlopsClient.ts — Cloudflare Workers MLOps ingest/query client.
 *
 * Talks to the Worker deployed from packages/cloudflare-mlops/. Two ops:
 *   ingest(record)     — fire-and-forget POST to /ingest
 *   metrics(slug)      — GET /metrics/:slug
 *
 * Shadow mode (CF_DRY_RUN=1 — default): mirrors writes to
 * /tmp/cf-mlops-mirror.jsonl and satisfies reads by scanning the same file.
 * Same shape, same aggregation, zero network.
 *
 * Live mode: requires CF_MLOPS_WORKER_URL. No cf-api token needed for the
 * public metrics ingest surface (Worker validates via header token if set).
 */

import fs from "fs";
import path from "path";
import { logger } from "../logger.js";

const MIRROR_PATH = process.env.CF_MLOPS_MIRROR_PATH ?? "/tmp/cf-mlops-mirror.jsonl";
const CF_WORKER = process.env.CF_MLOPS_WORKER_URL;
const CF_HEADER_TOKEN = process.env.CF_MLOPS_INGEST_TOKEN ?? "";

export interface McpInvocationRecord {
  mcp_slug: string;
  tool_name: string;
  ts: string; // ISO
  latency_ms: number;
  success: boolean;
  label?: "safe" | "unsafe" | "defer" | null;
  tenant_id?: number | null;
}

export interface MetricsSummary {
  slug: string;
  n: number;
  n_success: number;
  n_labelled_safe: number;
  n_labelled_unsafe: number;
  mean_latency_ms: number;
  p95_latency_ms: number;
  last_seen: string | null;
  source: "cf-worker" | "dry-mirror";
}

function isDry(): boolean {
  return process.env.CF_DRY_RUN !== "0";
}

// ─────────────────────────────────────────────────────────────────────────────
// ingest — write one row
// ─────────────────────────────────────────────────────────────────────────────

export async function ingest(record: McpInvocationRecord): Promise<{ ok: boolean; mode: "dry" | "live"; mirror?: string }> {
  if (isDry() || !CF_WORKER) {
    fs.mkdirSync(path.dirname(MIRROR_PATH), { recursive: true });
    fs.appendFileSync(MIRROR_PATH, JSON.stringify(record) + "\n");
    return { ok: true, mode: "dry", mirror: MIRROR_PATH };
  }
  try {
    const res = await fetch(`${CF_WORKER}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(CF_HEADER_TOKEN ? { "x-mlops-token": CF_HEADER_TOKEN } : {}),
      },
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "mlopsClient.ingest: worker returned non-2xx; NOT falling back (production)");
      return { ok: false, mode: "live" };
    }
    return { ok: true, mode: "live" };
  } catch (err) {
    logger.error({ err: String(err) }, "mlopsClient.ingest: worker unreachable");
    return { ok: false, mode: "live" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// metrics — aggregate query
// ─────────────────────────────────────────────────────────────────────────────

export async function metrics(slug: string): Promise<MetricsSummary> {
  if (isDry() || !CF_WORKER) {
    return aggregateMirror(slug);
  }
  try {
    const res = await fetch(`${CF_WORKER}/metrics/${encodeURIComponent(slug)}`);
    if (!res.ok) {
      logger.warn({ status: res.status, slug }, "mlopsClient.metrics: worker returned non-2xx; falling back to mirror");
      return aggregateMirror(slug);
    }
    const body = (await res.json()) as MetricsSummary;
    return { ...body, source: "cf-worker" };
  } catch (err) {
    logger.error({ err: String(err), slug }, "mlopsClient.metrics: worker unreachable");
    return aggregateMirror(slug);
  }
}

function aggregateMirror(slug: string): MetricsSummary {
  if (!fs.existsSync(MIRROR_PATH)) {
    return { slug, n: 0, n_success: 0, n_labelled_safe: 0, n_labelled_unsafe: 0, mean_latency_ms: 0, p95_latency_ms: 0, last_seen: null, source: "dry-mirror" };
  }
  const rows = fs
    .readFileSync(MIRROR_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as McpInvocationRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is McpInvocationRecord => r !== null && r.mcp_slug === slug);

  if (rows.length === 0) {
    return { slug, n: 0, n_success: 0, n_labelled_safe: 0, n_labelled_unsafe: 0, mean_latency_ms: 0, p95_latency_ms: 0, last_seen: null, source: "dry-mirror" };
  }

  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const mean_latency_ms = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const p95_idx = Math.floor(latencies.length * 0.95);
  const p95_latency_ms = latencies[Math.min(p95_idx, latencies.length - 1)];

  return {
    slug,
    n: rows.length,
    n_success: rows.filter((r) => r.success).length,
    n_labelled_safe: rows.filter((r) => r.label === "safe").length,
    n_labelled_unsafe: rows.filter((r) => r.label === "unsafe").length,
    mean_latency_ms,
    p95_latency_ms,
    last_seen: rows[rows.length - 1].ts,
    source: "dry-mirror",
  };
}

export function health(): { ok: boolean; mode: "dry" | "live"; worker_url: string | null; mirror_path: string } {
  return {
    ok: true,
    mode: isDry() || !CF_WORKER ? "dry" : "live",
    worker_url: CF_WORKER ?? null,
    mirror_path: MIRROR_PATH,
  };
}
