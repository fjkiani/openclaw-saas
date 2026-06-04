-- Migration 0006: zie_evaluation_bridge
-- Creates minimal evaluation_runs stub (no FK to training_jobs — forge chain migrates in Phase 2).
-- Adds evaluation_run_id INTEGER FK to zie_training_records — the bridge column.
-- Every ZIE capture can now reference the evaluation run that produced or validated it.

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id           SERIAL      PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  domain       TEXT        NOT NULL,
  task_type    TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_domain    ON evaluation_runs (domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_task_type ON evaluation_runs (task_type);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status    ON evaluation_runs (status);

ALTER TABLE zie_training_records
  ADD COLUMN IF NOT EXISTS evaluation_run_id INTEGER REFERENCES evaluation_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_zie_training_records_eval_run
  ON zie_training_records (evaluation_run_id)
  WHERE evaluation_run_id IS NOT NULL;
