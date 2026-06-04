-- Migration 0006: evaluation_runs table + ZIE training records evaluation bridge
--
-- evaluation_runs matches the Drizzle schema in lib/db/src/schema/evaluationRuns.ts
-- The startup migration runner was failing because this table didn't exist in the DB.
-- evaluation_run_id FK on zie_training_records bridges the ZIE flywheel to eval runs.

-- ── evaluation_runs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id           SERIAL      PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  job_id       INTEGER     NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
  rubric_id    TEXT,
  -- domain and task_type added for ZIE bridge queries (not in base Drizzle schema)
  domain       TEXT        NOT NULL DEFAULT 'general',
  task_type    TEXT        NOT NULL DEFAULT 'general',
  status       TEXT        NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_tenant_id
  ON evaluation_runs (tenant_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_job_id
  ON evaluation_runs (job_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status
  ON evaluation_runs (status);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_domain_task
  ON evaluation_runs (domain, task_type);

-- ── evaluation_metrics (depends on evaluation_runs) ───────────────────────────
-- Create if not exists — avoids FK errors on first deploy

CREATE TABLE IF NOT EXISTS evaluation_metrics (
  id            SERIAL      PRIMARY KEY,
  tenant_id     TEXT        NOT NULL,
  run_id        INTEGER     NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  metric_name   TEXT        NOT NULL,
  metric_value  REAL        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_metrics_run_id
  ON evaluation_metrics (run_id);

-- ── zie_training_records: add evaluation_run_id FK bridge ─────────────────────

ALTER TABLE zie_training_records
  ADD COLUMN IF NOT EXISTS evaluation_run_id INTEGER
    REFERENCES evaluation_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ztrl_eval_run
  ON zie_training_records (evaluation_run_id);
