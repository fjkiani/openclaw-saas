-- Migration 0002: semantic_clause_analyses
-- Semantic Law Counsel v1 — shadow-mode clause analysis persistence.
--
-- Three tables:
--   semantic_clause_analysis_runs     — one row per shadow run
--   semantic_clause_analyses          — one row per clause per run (valid results only)
--   semantic_clause_analysis_attempts — one row per model invocation attempt
--
-- All timestamps are TIMESTAMPTZ. Arrays stored as JSONB.
-- Foreign keys reference semantic_clause_analysis_runs(run_id).

-- ── Runs ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS semantic_clause_analysis_runs (
  run_id          UUID        PRIMARY KEY,
  matter_id       UUID        NOT NULL,
  tenant_id       TEXT        NOT NULL,
  doc_class       TEXT        NOT NULL,
  route_chain_id  TEXT        NOT NULL,
  prompt_version  TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'running',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scar_matter_id
  ON semantic_clause_analysis_runs (matter_id);

CREATE INDEX IF NOT EXISTS idx_scar_tenant_id
  ON semantic_clause_analysis_runs (tenant_id);

CREATE INDEX IF NOT EXISTS idx_scar_status
  ON semantic_clause_analysis_runs (status);

-- ── Analyses ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS semantic_clause_analyses (
  analysis_id                  UUID        PRIMARY KEY,
  run_id                       UUID        NOT NULL
                                             REFERENCES semantic_clause_analysis_runs (run_id),
  matter_id                    UUID        NOT NULL,
  clause_id                    TEXT        NOT NULL,
  clause_label                 TEXT        NOT NULL,
  risk_level                   TEXT        NOT NULL,
  summary                      TEXT        NOT NULL,
  missing_elements             JSONB       NOT NULL DEFAULT '[]',
  recommended_action           TEXT        NOT NULL,
  confidence                   TEXT        NOT NULL,
  reasoning                    TEXT,
  alternative_interpretations  JSONB       NOT NULL DEFAULT '[]',
  model_id                     TEXT        NOT NULL,
  prompt_version               TEXT        NOT NULL,
  schema_version               TEXT        NOT NULL,
  raw_response                 TEXT        NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sca_run_id
  ON semantic_clause_analyses (run_id);

CREATE INDEX IF NOT EXISTS idx_sca_matter_id
  ON semantic_clause_analyses (matter_id);

CREATE INDEX IF NOT EXISTS idx_sca_clause_id
  ON semantic_clause_analyses (clause_id);

CREATE INDEX IF NOT EXISTS idx_sca_risk_level
  ON semantic_clause_analyses (risk_level);

-- ── Attempts ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS semantic_clause_analysis_attempts (
  attempt_id     UUID        PRIMARY KEY,
  run_id         UUID        NOT NULL
                               REFERENCES semantic_clause_analysis_runs (run_id),
  clause_id      TEXT        NOT NULL,
  model_id       TEXT        NOT NULL,
  provider       TEXT        NOT NULL,
  attempt_number INTEGER     NOT NULL,
  status         TEXT        NOT NULL,
  error_code     TEXT,
  error_message  TEXT,
  latency_ms     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scaa_run_id
  ON semantic_clause_analysis_attempts (run_id);

CREATE INDEX IF NOT EXISTS idx_scaa_model_id
  ON semantic_clause_analysis_attempts (model_id);

CREATE INDEX IF NOT EXISTS idx_scaa_status
  ON semantic_clause_analysis_attempts (status);
