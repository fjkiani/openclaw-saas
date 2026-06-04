-- Migration 0003: zie_factory
-- ZIE Factory v1 — the data-flywheel substrate.
--
-- Eight tables in two families:
--
--   Generic flywheel substrate (domain-agnostic):
--     zie_training_records        — SFT substrate: one promoted/corrected judgment per row
--     zie_preference_pairs        — DPO substrate: chosen-vs-rejected training-record pairs
--     zie_router_policies         — local/remote routing config per (domain, task_type)
--     zie_model_promotion_gates   — metric thresholds a fine-tuned model must clear
--
--   Manuscript adapter (#1) screening pipeline:
--     manuscript_submissions      — one row per submitted manuscript
--     manuscript_review_runs      — one row per screening run over a submission
--     manuscript_review_attempts  — one row per stage/model invocation in a run
--     manuscript_analyses         — one row per produced analysis (valid results only)
--
-- Conventions match 0002: TIMESTAMPTZ everywhere, JSONB for structured blobs,
-- UUID primary keys for new entities (gen_random_uuid()), TEXT tenant_id.
-- Integer foreign keys reference the existing serial lineage tables
-- (tenants/model_workspaces/model_datasets/dataset_versions/training_jobs/
--  model_registrations/model_versions).
--
-- Stage enum note: the screening orchestrator's canonical stage tokens are
-- lowercase snake_case. The product spec names five stages
-- (Reader | Screening | Slop | Methods | Arbiter); they map 1:1 to the
-- canonical tokens enforced by the CHECK below:
--     Reader     -> reader
--     Screening  -> screening_specialist
--     Slop       -> slop_specialist
--     Methods    -> methods_specialist
--     Arbiter    -> arbiter

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ════════════════════════════════════════════════════════════════════════════
-- GENERIC FLYWHEEL SUBSTRATE
-- ════════════════════════════════════════════════════════════════════════════

-- ── zie_training_records (SFT substrate) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS zie_training_records (
  training_record_id   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT          NOT NULL,
  tenant_id            TEXT          NOT NULL,
  workspace_id         INTEGER       NOT NULL REFERENCES model_workspaces (id),
  dataset_version_id   INTEGER                REFERENCES dataset_versions (id),
  model_version_id     INTEGER                REFERENCES model_versions (id),
  source_kind          TEXT          NOT NULL
                         CHECK (source_kind IN ('remote_promoted','human_corrected','local_gold')),
  source_run_id        UUID,
  source_analysis_ref  TEXT,
  task_type            TEXT          NOT NULL
                         CHECK (task_type IN ('posting_screen','slop_detection','manuscript_review','clause_analysis')),
  prompt_json          JSONB         NOT NULL DEFAULT '{}',
  response_json        JSONB         NOT NULL DEFAULT '{}',
  rationale            TEXT,
  verdict              TEXT,
  tags                 TEXT[]        NOT NULL DEFAULT '{}',
  confidence           NUMERIC(5,4),
  quality_score        NUMERIC(5,4),
  used_for_sft         BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ztr_tenant_domain_task
  ON zie_training_records (tenant_id, domain, task_type);
CREATE INDEX IF NOT EXISTS idx_ztr_dataset_version
  ON zie_training_records (dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_ztr_confidence
  ON zie_training_records (confidence DESC);
CREATE INDEX IF NOT EXISTS idx_ztr_used_for_sft
  ON zie_training_records (used_for_sft);

-- ── zie_preference_pairs (DPO substrate) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS zie_preference_pairs (
  preference_pair_id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                       TEXT         NOT NULL,
  tenant_id                    TEXT         NOT NULL,
  workspace_id                 INTEGER      NOT NULL REFERENCES model_workspaces (id),
  dataset_version_id           INTEGER               REFERENCES dataset_versions (id),
  prompt_json                  JSONB        NOT NULL DEFAULT '{}',
  chosen_training_record_id    UUID         NOT NULL
                                 REFERENCES zie_training_records (training_record_id) ON DELETE CASCADE,
  rejected_training_record_id  UUID         NOT NULL
                                 REFERENCES zie_training_records (training_record_id) ON DELETE CASCADE,
  preference_source            TEXT         NOT NULL
                                 CHECK (preference_source IN ('remote_beats_local','human_beats_remote','human_beats_local')),
  pair_weight                  NUMERIC(6,4) NOT NULL DEFAULT 1.0,
  used_for_dpo                 BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT zie_pref_distinct_records
    CHECK (chosen_training_record_id <> rejected_training_record_id)
);

CREATE INDEX IF NOT EXISTS idx_zpp_tenant_domain_created
  ON zie_preference_pairs (tenant_id, domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zpp_dataset_version
  ON zie_preference_pairs (dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_zpp_used_for_dpo
  ON zie_preference_pairs (used_for_dpo);

-- ── zie_router_policies ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zie_router_policies (
  policy_id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT         NOT NULL,
  task_type             TEXT         NOT NULL,
  local_model           TEXT         NOT NULL,
  remote_model          TEXT         NOT NULL,
  confidence_threshold  NUMERIC(5,4) NOT NULL DEFAULT 0.85,
  shadow_rate           NUMERIC(5,4) NOT NULL DEFAULT 0.05,
  active                BOOLEAN      NOT NULL DEFAULT TRUE,
  tenant_id             TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One active policy per (domain, task_type, tenant) — NULL tenant => global default.
CREATE UNIQUE INDEX IF NOT EXISTS uq_zrp_active_scope
  ON zie_router_policies (domain, task_type, COALESCE(tenant_id, ''))
  WHERE active;

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
