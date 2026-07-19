/**
 * openclaw-mlops — Cloudflare Worker for MCP MLOps ingest + aggregate.
 *
 * Endpoints:
 *   POST /ingest              — write one per-invocation row into D1
 *   GET  /metrics/:slug       — aggregate stats for a single MCP slug
 *   GET  /metrics             — aggregate stats across all slugs
 *   GET  /health              — liveness + bindings check
 *
 * D1 schema (see sql/schema.sql):
 *   mcp_metrics(id INTEGER PRIMARY KEY, mcp_slug TEXT, tool_name TEXT, ts TEXT,
 *               latency_ms INTEGER, success INTEGER, label TEXT, tenant_id INTEGER)
 *
 * Free-tier considerations:
 *   - Workers Free: 100k requests/day
 *   - D1 Free: 5M rows read/day, 100k rows written/day, 5 GB storage
 *   - Everything below is single-row writes + small aggregates, well under caps
 *
 * Ingest auth: header `x-mlops-token` must match `INGEST_TOKEN` secret when set.
 *              Unset → allow anonymous ingest (useful for local demo).
 */

export interface Env {
  MCP_METRICS: D1Database;
  MCP_ARTIFACTS?: R2Bucket;
  MCP_CONFIG?: KVNamespace;
  INGEST_TOKEN?: string;
  MLOPS_ALLOW_ANONYMOUS_METRICS?: string;
}

interface IngestBody {
  mcp_slug: string;
  tool_name: string;
  ts?: string;
  latency_ms?: number;
  success?: boolean;
  label?: "safe" | "unsafe" | "defer" | null;
  tenant_id?: number | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...(init.headers ?? {}) },
  });
}

function bad(msg: string, status = 400): Response {
  return json({ error: msg }, { status });
}

async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS mcp_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, mcp_slug TEXT NOT NULL, tool_name TEXT NOT NULL, ts TEXT NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, label TEXT, tenant_id INTEGER)`,
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_metrics_slug ON mcp_metrics(mcp_slug)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics(ts)`);
}

async function ingest(req: Request, env: Env): Promise<Response> {
  // Auth
  if (env.INGEST_TOKEN) {
    const supplied = req.headers.get("x-mlops-token");
    if (supplied !== env.INGEST_TOKEN) return bad("invalid ingest token", 401);
  }
  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return bad("invalid JSON body");
  }
  if (!body.mcp_slug || !body.tool_name) {
    return bad("mcp_slug and tool_name are required");
  }
  await ensureSchema(env.MCP_METRICS);
  const ts = body.ts ?? new Date().toISOString();
  const latency_ms = Number(body.latency_ms ?? 0);
  const success = body.success === false ? 0 : 1;
  const label = body.label ?? null;
  const tenant_id = body.tenant_id ?? null;
  await env.MCP_METRICS.prepare(
    `INSERT INTO mcp_metrics (mcp_slug, tool_name, ts, latency_ms, success, label, tenant_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(body.mcp_slug, body.tool_name, ts, latency_ms, success, label, tenant_id)
    .run();
  return json({ ok: true, mcp_slug: body.mcp_slug, tool_name: body.tool_name });
}

async function metricsForSlug(slug: string, env: Env): Promise<Response> {
  await ensureSchema(env.MCP_METRICS);
  const stats = await env.MCP_METRICS.prepare(
    `SELECT COUNT(*) as n, SUM(success) as n_success, SUM(CASE WHEN label='safe' THEN 1 ELSE 0 END) as n_safe, SUM(CASE WHEN label='unsafe' THEN 1 ELSE 0 END) as n_unsafe, AVG(latency_ms) as mean_latency, MAX(ts) as last_seen FROM mcp_metrics WHERE mcp_slug = ?1`,
  )
    .bind(slug)
    .first();
  // p95 via ORDER BY LIMIT/OFFSET — cheap enough on free tier since rows are small
  const p95Row = await env.MCP_METRICS.prepare(
    `SELECT latency_ms FROM mcp_metrics WHERE mcp_slug = ?1 ORDER BY latency_ms ASC LIMIT 1 OFFSET (SELECT MAX(0, CAST((COUNT(*) * 0.95 - 1) AS INTEGER)) FROM mcp_metrics WHERE mcp_slug = ?1)`,
  )
    .bind(slug)
    .first<{ latency_ms: number }>();
  return json({
    slug,
    n: Number(stats?.n ?? 0),
    n_success: Number(stats?.n_success ?? 0),
    n_labelled_safe: Number(stats?.n_safe ?? 0),
    n_labelled_unsafe: Number(stats?.n_unsafe ?? 0),
    mean_latency_ms: Math.round(Number(stats?.mean_latency ?? 0)),
    p95_latency_ms: Number(p95Row?.latency_ms ?? 0),
    last_seen: (stats?.last_seen as string | null) ?? null,
    source: "cf-worker",
  });
}

async function metricsAll(env: Env): Promise<Response> {
  await ensureSchema(env.MCP_METRICS);
  const result = await env.MCP_METRICS.prepare(
    `SELECT mcp_slug, COUNT(*) as n, SUM(success) as n_success, AVG(latency_ms) as mean_latency, MAX(ts) as last_seen FROM mcp_metrics GROUP BY mcp_slug ORDER BY n DESC LIMIT 100`,
  ).all();
  return json({ rows: result.results ?? [] });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-mlops-token",
        },
      });
    }
    if (url.pathname === "/health") {
      return json({
        ok: true,
        bindings: {
          d1: Boolean(env.MCP_METRICS),
          r2: Boolean(env.MCP_ARTIFACTS),
          kv: Boolean(env.MCP_CONFIG),
        },
      });
    }
    if (url.pathname === "/ingest" && request.method === "POST") {
      return ingest(request, env).catch((err) =>
        json({ error: String(err) }, { status: 500 }),
      );
    }
    if (url.pathname === "/metrics" && request.method === "GET") {
      return metricsAll(env).catch((err) =>
        json({ error: String(err) }, { status: 500 }),
      );
    }
    const m = url.pathname.match(/^\/metrics\/([^/]+)$/);
    if (m && request.method === "GET") {
      return metricsForSlug(decodeURIComponent(m[1]), env).catch((err) =>
        json({ error: String(err) }, { status: 500 }),
      );
    }
    return bad(`not found: ${url.pathname}`, 404);
  },
};
