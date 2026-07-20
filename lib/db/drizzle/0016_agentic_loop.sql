-- 0016_agentic_loop.sql
-- Agentic self-correcting loop tables.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "zie_loop_runs" (
  id BIGSERIAL PRIMARY KEY,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  orig_model TEXT,
  orig_response TEXT,
  orig_score NUMERIC,
  repair_a_model TEXT,
  repair_a_response TEXT,
  repair_a_score NUMERIC,
  repair_b_model TEXT,
  repair_b_response TEXT,
  repair_b_score NUMERIC,
  winner TEXT,
  judge_reasoning TEXT,
  judge_version TEXT,
  judge_margin NUMERIC,
  pref_pair_id UUID,
  tenant_id TEXT,
  workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loop_runs_slug_tool ON "zie_loop_runs" (mcp_slug, tool_name);
CREATE INDEX IF NOT EXISTS idx_loop_runs_created ON "zie_loop_runs" (created_at DESC);

CREATE TABLE IF NOT EXISTS "zie_loop_promotions" (
  id BIGSERIAL PRIMARY KEY,
  loop_run_id BIGINT NOT NULL REFERENCES "zie_loop_runs"(id) ON DELETE CASCADE,
  promoted BOOLEAN NOT NULL,
  auto BOOLEAN NOT NULL DEFAULT false,
  gate_snapshot JSONB NOT NULL,
  promoted_by TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loop_promotions_run ON "zie_loop_promotions" (loop_run_id);

CREATE TABLE IF NOT EXISTS "zie_loop_settings" (
  id BIGSERIAL PRIMARY KEY,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  auto_promote BOOLEAN NOT NULL DEFAULT false,
  min_margin NUMERIC NOT NULL DEFAULT 0.6,
  min_pairs_agree INTEGER NOT NULL DEFAULT 25,
  min_confidence NUMERIC NOT NULL DEFAULT 0.7,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mcp_slug, tool_name)
);

CREATE TABLE IF NOT EXISTS "zie_regression_suite" (
  id BIGSERIAL PRIMARY KEY,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  gold_response TEXT,
  rubric JSONB NOT NULL DEFAULT '{}'::jsonb,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  source TEXT DEFAULT 'yaml',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reg_suite_slug_tool ON "zie_regression_suite" (mcp_slug, tool_name);

CREATE TABLE IF NOT EXISTS "zie_regression_runs" (
  id BIGSERIAL PRIMARY KEY,
  suite_id BIGINT NOT NULL REFERENCES "zie_regression_suite"(id) ON DELETE CASCADE,
  adapter_id TEXT,
  baseline_id TEXT,
  pass BOOLEAN NOT NULL,
  score NUMERIC,
  actual_response TEXT,
  reasoning TEXT,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reg_runs_adapter ON "zie_regression_runs" (adapter_id);
CREATE INDEX IF NOT EXISTS idx_reg_runs_suite ON "zie_regression_runs" (suite_id);

CREATE TABLE IF NOT EXISTS "zie_archon_triage" (
  id BIGSERIAL PRIMARY KEY,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_ref TEXT,
  status TEXT NOT NULL DEFAULT 'dispatched'
);
CREATE INDEX IF NOT EXISTS idx_archon_slug ON "zie_archon_triage" (mcp_slug, dispatched_at DESC);
