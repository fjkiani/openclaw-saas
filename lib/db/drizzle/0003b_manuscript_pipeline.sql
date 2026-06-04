-- Migration 0003b: manuscript_pipeline
--
-- Collision resolution: the original 0003_zie_factory.sql defined eight tables,
-- but two of them (zie_training_records, zie_preference_pairs) collided with
-- 0003_zie_flywheel.sql, and zie_router_policies collided with
-- 0004_zie_router_policies.sql. On the live DB the FLYWHEEL lane won
-- zie_training_records / zie_preference_pairs and the 0004 lane won
-- zie_router_policies (verified against production).
--
-- This migration keeps ONLY the tables that are unique to the factory lane and
-- are live-canonical:
--   zie_model_promotion_gates   — metric thresholds a fine-tuned model must clear
--   manuscript_submissions      — one row per submitted manuscript
--   manuscript_review_runs      — one row per screening run over a submission
--   manuscript_review_attempts  — one row per stage/model invocation in a run
--   manuscript_analyses         — one row per produced analysis
--
-- The superseded definitions (zie_training_records / zie_preference_pairs /
-- zie_router_policies) are intentionally NOT recreated here; they belong to
-- 0003_zie_flywheel and 0004_zie_router_policies. 0003_zie_factory.sql is removed.
--
-- Stage tokens (canonical lowercase snake_case; product names map 1:1):
--   Reader->reader, Screening->screening_specialist, Slop->slop_specialist,
--   Methods->methods_specialist, Arbiter->arbiter.

-- ── zie_model_promotion_gates ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zie_model_promotion_gates (
  gate_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain      TEXT        NOT NULL,
  task_type   TEXT,
  metric_key  TEXT        NOT NULL,
  min_value   NUMERIC,
  max_value   NUMERIC,
  hard_fail   BOOLEAN     NOT NULL DEFAULT TRUE,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zmpg_domain_task_active
  ON zie_model_promotion_gates (domain, task_type, active);

-- ════════════════════════════════════════════════════════════════════════════
-- MANUSCRIPT ADAPTER (#1) — SCREENING PIPELINE
-- ════════════════════════════════════════════════════════════════════════════

-- ── manuscript_submissions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manuscript_submissions (
  submission_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL,
  workspace_id     INTEGER     NOT NULL REFERENCES model_workspaces (id),
  title            TEXT        NOT NULL,
  source_type      TEXT        NOT NULL
                     CHECK (source_type IN ('text','pdf','latex','docx')),
  raw_text         TEXT,
  pdf_storage_key  TEXT,
  fact_sheet_json  JSONB       NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'received',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ms_tenant     ON manuscript_submissions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ms_workspace  ON manuscript_submissions (workspace_id);
CREATE INDEX IF NOT EXISTS idx_ms_status     ON manuscript_submissions (status);

-- ── manuscript_review_runs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manuscript_review_runs (
  run_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   UUID        NOT NULL REFERENCES manuscript_submissions (submission_id) ON DELETE CASCADE,
  tenant_id       TEXT        NOT NULL,
  workspace_id    INTEGER     NOT NULL REFERENCES model_workspaces (id),
  local_model     TEXT        NOT NULL,
  remote_model    TEXT,
  escalated       BOOLEAN     NOT NULL DEFAULT FALSE,
  final_verdict   TEXT,
  final_confidence NUMERIC(5,4),
  status          TEXT        NOT NULL DEFAULT 'running',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mrr_submission  ON manuscript_review_runs (submission_id);
CREATE INDEX IF NOT EXISTS idx_mrr_tenant      ON manuscript_review_runs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_mrr_status      ON manuscript_review_runs (status);
CREATE INDEX IF NOT EXISTS idx_mrr_escalated   ON manuscript_review_runs (escalated);

-- ── manuscript_review_attempts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manuscript_review_attempts (
  attempt_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID        NOT NULL REFERENCES manuscript_review_runs (run_id) ON DELETE CASCADE,
  stage           TEXT        NOT NULL
                    CHECK (stage IN ('reader','screening_specialist','slop_specialist','methods_specialist','arbiter')),
  model_id        TEXT        NOT NULL,
  provider        TEXT        NOT NULL,
  attempt_number  INTEGER     NOT NULL,
  status          TEXT        NOT NULL
                    CHECK (status IN ('success','error','exhausted','schema_failure','unusable')),
  error_code      TEXT,
  error_message   TEXT,
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mra_run       ON manuscript_review_attempts (run_id);
CREATE INDEX IF NOT EXISTS idx_mra_stage     ON manuscript_review_attempts (stage);
CREATE INDEX IF NOT EXISTS idx_mra_status    ON manuscript_review_attempts (status);

-- ── manuscript_analyses ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manuscript_analyses (
  analysis_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID        NOT NULL REFERENCES manuscript_review_runs (run_id) ON DELETE CASCADE,
  submission_id    UUID        NOT NULL REFERENCES manuscript_submissions (submission_id) ON DELETE CASCADE,
  stage            TEXT        NOT NULL
                     CHECK (stage IN ('reader','screening_specialist','slop_specialist','methods_specialist','arbiter')),
  verdict          TEXT        NOT NULL,
  confidence       NUMERIC(5,4),
  scope_fit        TEXT,
  findings_json    JSONB       NOT NULL DEFAULT '[]',
  evidence_json    JSONB       NOT NULL DEFAULT '[]',
  model_id         TEXT        NOT NULL,
  prompt_version   TEXT        NOT NULL,
  schema_version   TEXT        NOT NULL,
  raw_response     TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ma_run         ON manuscript_analyses (run_id);
CREATE INDEX IF NOT EXISTS idx_ma_submission  ON manuscript_analyses (submission_id);
CREATE INDEX IF NOT EXISTS idx_ma_stage       ON manuscript_analyses (stage);
