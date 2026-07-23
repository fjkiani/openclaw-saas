-- 0017_agent_executor.sql
-- Generic agentic task executor: user/free-text goal -> planner -> DAG of
-- platform actions -> step-by-step execution with approval gates, self-correction.
-- Backs the /agent-console UI + Autopilot mode. Reuses existing loop/regression/
-- promote/train endpoints via a tool-action registry.
--
-- NOTE: the authoritative DDL is applied inline in artifacts/api-server/src/index.ts
-- runMigrations() (search "0017_agent_executor"). This file mirrors it for reference.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "zie_agent_runs" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'console',      -- 'console' | 'autopilot'
  mcp_slug TEXT,                             -- optional bucket scope
  tool_name TEXT,                            -- optional tool scope
  status TEXT NOT NULL DEFAULT 'planning',   -- planning|running|awaiting_approval|completed|failed|cancelled
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,    -- planned step DAG (array)
  current_step INTEGER NOT NULL DEFAULT 0,
  replans INTEGER NOT NULL DEFAULT 0,        -- self-correction re-plan count
  planner TEXT,                              -- 'mock' | 'llm:<model>'
  summary TEXT,                              -- terminal human-readable outcome
  error TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_agent_runs_created" ON "zie_agent_runs" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_agent_runs_slug" ON "zie_agent_runs" ("mcp_slug", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_agent_runs_mode_status" ON "zie_agent_runs" ("mode", "status");

CREATE TABLE IF NOT EXISTS "zie_agent_steps" (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "zie_agent_runs"("id") ON DELETE CASCADE,
  idx INTEGER NOT NULL,                      -- position within the plan
  action_type TEXT NOT NULL,                 -- registry action key
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT,                            -- why the planner chose this step
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|running|awaiting_approval|done|failed|skipped
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approved BOOLEAN,                          -- null=undecided, true/false once acted
  approved_by TEXT,
  result JSONB,                              -- action output (endpoint round-trip)
  error TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_agent_steps_run_idx" ON "zie_agent_steps" ("run_id", "idx");
CREATE INDEX IF NOT EXISTS "idx_agent_steps_status" ON "zie_agent_steps" ("status");

-- Per-bucket autopilot enablement (one row per mcp_slug/tool_name).
CREATE TABLE IF NOT EXISTS "zie_autopilot_settings" (
  id BIGSERIAL PRIMARY KEY,
  mcp_slug TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_run_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("mcp_slug", "tool_name")
);
CREATE INDEX IF NOT EXISTS "idx_autopilot_enabled" ON "zie_autopilot_settings" ("enabled");
