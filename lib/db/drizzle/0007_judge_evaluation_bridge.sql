-- Migration 0007: judge_evaluation_bridge
-- Makes the LLM-as-judge flywheel observable end-to-end.
--
-- Problem this fixes:
--   * routes/judge.ts UPDATEs zie_preference_pairs.judge_* columns, but NO prior
--     migration ever created those columns, and nothing wrote evaluation_runs /
--     evaluation_metrics. judge_run_id never existed. The judge verdict was not
--     traceable to an evaluation run, and evaluation_metrics had no SQL at all.
--
-- This migration:
--   1. Creates evaluation_metrics (was an orphan Drizzle .ts with no .sql).
--      Shape matches lib/db/src/schema/evaluationMetrics.ts:
--      eval_run_id INTEGER FK -> evaluation_runs(id), value REAL, etc.
--   2. Adds the judge_* columns to zie_preference_pairs, including
--      judge_run_id INTEGER FK -> evaluation_runs(id)  (integer, matches the
--      SERIAL PK on evaluation_runs from migration 0006 — NOT a uuid).
--
-- evaluation_runs already exists (migration 0006): id SERIAL PK, tenant_id NOT NULL,
-- domain NOT NULL, task_type NOT NULL, status, created_at, completed_at.

-- ─── evaluation_metrics (create; matches evaluationMetrics.ts) ────────────────
CREATE TABLE IF NOT EXISTS evaluation_metrics (
  id           SERIAL      PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  eval_run_id  INTEGER     NOT NULL REFERENCES evaluation_runs (id) ON DELETE CASCADE,
  metric_name  TEXT        NOT NULL,
  value        REAL        NOT NULL,
  threshold    REAL,
  passed       BOOLEAN,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_metrics_run
  ON evaluation_metrics (eval_run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_metrics_name
  ON evaluation_metrics (metric_name);

-- ─── zie_preference_pairs: judge columns (create; none existed before) ────────
ALTER TABLE zie_preference_pairs
  ADD COLUMN IF NOT EXISTS judge_verified       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS judge_score_chosen   REAL,
  ADD COLUMN IF NOT EXISTS judge_score_rejected REAL,
  ADD COLUMN IF NOT EXISTS judge_reasoning      TEXT,
  ADD COLUMN IF NOT EXISTS judge_run_id         INTEGER REFERENCES evaluation_runs (id) ON DELETE SET NULL;

-- Index: find verified pairs and join to their evaluation run cheaply.
CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_judge_verified
  ON zie_preference_pairs (judge_verified)
  WHERE judge_verified = TRUE;

CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_judge_run
  ON zie_preference_pairs (judge_run_id)
  WHERE judge_run_id IS NOT NULL;
