-- D1 schema for openclaw-mlops.
--
-- Deploy path:
--   wrangler d1 create openclaw-mcp-metrics
--   wrangler d1 execute openclaw-mcp-metrics --file=sql/schema.sql
--   # Then paste the returned database_id into wrangler.toml
--
-- The Worker also runs `ensureSchema()` on each request (idempotent
-- CREATE TABLE IF NOT EXISTS) so a fresh deploy needs no manual step —
-- this file exists as source-of-truth + drift check.

CREATE TABLE IF NOT EXISTS mcp_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  ts TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  tenant_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_metrics_slug ON mcp_metrics(mcp_slug);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_label ON mcp_metrics(label);
