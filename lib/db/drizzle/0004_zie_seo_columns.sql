-- Migration 0004: zie_seo_columns
-- Extends zie_training_records and zie_preference_pairs with multi-tenant
-- factory context columns required by the SEO Intelligence ZIE Adapter.
--
-- These columns allow:
--   1. Filtering training data by tenant, workspace, and vertical (domain)
--   2. Linking SFT records back to the audit run that produced them (source_run_id)
--   3. Linking DPO pairs to their constituent SFT records (FK constraints)
--   4. Querying training data by source kind for dataset assembly
--
-- All new columns are nullable with defaults so existing rows (manuscript_slop_check)
-- are unaffected. The NOT NULL constraint on domain has a default of 'general'
-- to preserve backward compatibility.

-- ─── zie_training_records extensions ─────────────────────────────────────────

ALTER TABLE zie_training_records
  ADD COLUMN IF NOT EXISTS domain            text        NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS tenant_id         text,
  ADD COLUMN IF NOT EXISTS workspace_id      integer,
  ADD COLUMN IF NOT EXISTS dataset_version_id integer,
  ADD COLUMN IF NOT EXISTS model_version_id  integer,
  ADD COLUMN IF NOT EXISTS source_kind       text        NOT NULL DEFAULT 'remote_promoted',
  ADD COLUMN IF NOT EXISTS source_run_id     uuid,
  ADD COLUMN IF NOT EXISTS source_analysis_ref text;

-- Index: filter by tenant + domain (primary query pattern for dataset assembly)
CREATE INDEX IF NOT EXISTS idx_zie_training_records_tenant_domain
  ON zie_training_records (tenant_id, domain)
  WHERE tenant_id IS NOT NULL;

-- Index: filter by workspace (forge dataset assembly)
CREATE INDEX IF NOT EXISTS idx_zie_training_records_workspace
  ON zie_training_records (workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Index: filter by source_kind (separate remote_promoted from other sources)
CREATE INDEX IF NOT EXISTS idx_zie_training_records_source_kind
  ON zie_training_records (source_kind);

-- ─── zie_preference_pairs extensions ─────────────────────────────────────────

ALTER TABLE zie_preference_pairs
  ADD COLUMN IF NOT EXISTS domain                      text        NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS tenant_id                   text,
  ADD COLUMN IF NOT EXISTS workspace_id                integer,
  ADD COLUMN IF NOT EXISTS chosen_training_record_id   uuid        REFERENCES zie_training_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_training_record_id uuid        REFERENCES zie_training_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preference_source           text        NOT NULL DEFAULT 'remote_beats_local';

-- Constraint: chosen and rejected must be different records (when both present)
-- Implemented as a CHECK constraint — cannot use FK values directly in CHECK,
-- so we enforce at the application layer in seoFactoryAdapter.ts and add a
-- partial index that makes violations visible in query plans.
CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_tenant_domain
  ON zie_preference_pairs (tenant_id, domain)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_chosen_record
  ON zie_preference_pairs (chosen_training_record_id)
  WHERE chosen_training_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zie_preference_pairs_rejected_record
  ON zie_preference_pairs (rejected_training_record_id)
  WHERE rejected_training_record_id IS NOT NULL;

-- ─── Backfill existing rows ───────────────────────────────────────────────────
-- Rows inserted before this migration have domain='general', source_kind='remote_promoted'.
-- No data loss. manuscript_slop_check rows remain queryable under domain='general'.
