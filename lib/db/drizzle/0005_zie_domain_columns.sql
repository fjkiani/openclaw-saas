-- Migration 0005: add domain and source_kind columns to zie vault tables
-- domain: top-level product domain (manuscript, legal, seo)
-- source_kind: how the record was captured (shadow_hook, direct_call, batch_ingest)

ALTER TABLE zie_training_records
  ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'direct_call';

ALTER TABLE zie_preference_pairs
  ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'direct_call',
  ADD COLUMN IF NOT EXISTS preference_source TEXT NOT NULL DEFAULT 'path_race';

-- Backfill existing rows from task_type
UPDATE zie_training_records SET domain = CASE
  WHEN task_type = 'manuscript_slop_check' THEN 'manuscript'
  WHEN task_type = 'legal_clause_analysis' THEN 'legal'
  WHEN task_type = 'seo_content_audit'     THEN 'seo'
  ELSE 'unknown'
END WHERE domain = 'unknown';

UPDATE zie_preference_pairs SET domain = CASE
  WHEN task_type = 'manuscript_slop_check' THEN 'manuscript'
  WHEN task_type = 'legal_clause_analysis' THEN 'legal'
  WHEN task_type = 'seo_content_audit'     THEN 'seo'
  ELSE 'unknown'
END WHERE domain = 'unknown';

-- Indexes for domain-scoped queries
CREATE INDEX IF NOT EXISTS idx_zie_training_records_domain
  ON zie_training_records (domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_domain
  ON zie_preference_pairs (domain, created_at DESC);
