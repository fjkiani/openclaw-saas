-- Migration 0008: zeta_clearance
-- Creates the 6 tables backing the Zeta Clearance institutional KYB domain
-- (lib/db/src/schema/zetaClearance.ts, artifacts/api-server/src/routes/zeta.ts).
--
-- Problem this fixes:
--   * routes/zeta.ts SELECT/INSERT/UPDATEs zeta_entities, zeta_documents,
--     zeta_ownership_edges, zeta_ubo_results, zeta_interrogations and
--     zeta_attestations, but no migration ever created them. Every /api/zeta
--     request would fail at runtime with 42P01 undefined_table.
--
-- PII BOUNDARY (enforced by design, restated here because SQL outlives docs):
--   NO raw PII is stored in these tables. Documents are referenced only by
--   vault token (L2, AES-256-GCM) + evidence hash. zeta_attestations mirrors
--   the 6-field minimal Canton claim. Passports / cap tables live ONLY in the
--   encrypted vault. Do not add a `content`, `raw`, `name_of_person` or
--   equivalent column to any table below.
--
-- Written idempotently (CREATE TABLE IF NOT EXISTS / DO $$ guards) so it is
-- safe against a partially hand-applied database, matching the convention of
-- migrations 0006 and 0007.

-- ─── zeta_entities: an applicant institution going through KYB ────────────────
CREATE TABLE IF NOT EXISTS zeta_entities (
  id                SERIAL      PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  legal_name        TEXT        NOT NULL,
  jurisdiction      TEXT,
  legal_entity_hash TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'intake',
  risk_tier         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- routes/zeta.ts lists entities by tenant on every dashboard load.
CREATE INDEX IF NOT EXISTS zeta_entities_tenant_idx
  ON zeta_entities (tenant_id);
-- legalEntityHash is the join key to the on-ledger attestation.
CREATE INDEX IF NOT EXISTS zeta_entities_legal_entity_hash_idx
  ON zeta_entities (legal_entity_hash);

-- ─── zeta_documents: vault-token reference, never document bytes ──────────────
CREATE TABLE IF NOT EXISTS zeta_documents (
  id              SERIAL      PRIMARY KEY,
  entity_id       INTEGER     NOT NULL REFERENCES zeta_entities (id) ON DELETE CASCADE,
  vault_token     TEXT        NOT NULL,
  record_type     TEXT        NOT NULL,
  evidence_hash   TEXT        NOT NULL,
  source_filename TEXT,
  chunk_count     INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zeta_documents_entity_idx
  ON zeta_documents (entity_id);
-- A vault token maps to exactly one document row; duplicate rows would let two
-- entities claim the same encrypted evidence.
CREATE UNIQUE INDEX IF NOT EXISTS zeta_documents_vault_token_key
  ON zeta_documents (vault_token);

-- ─── zeta_ownership_edges: LLM-proposed, page-cited candidate edges ───────────
-- direct_pct is what the extractor READ off the page. Aggregate ownership is
-- NEVER stored here: it is recomputed deterministically by the graph engine
-- into zeta_ubo_results, so a model change can never silently move a UBO.
CREATE TABLE IF NOT EXISTS zeta_ownership_edges (
  id              SERIAL      PRIMARY KEY,
  entity_id       INTEGER     NOT NULL REFERENCES zeta_entities (id) ON DELETE CASCADE,
  owner_id        TEXT        NOT NULL,
  owned_entity_id TEXT        NOT NULL,
  direct_pct      REAL        NOT NULL,
  owner_type      TEXT        NOT NULL DEFAULT 'unknown',
  source_hash     TEXT        NOT NULL,
  page            INTEGER     NOT NULL DEFAULT 1,
  confidence      REAL        NOT NULL,
  evidence_text   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zeta_ownership_edges_entity_idx
  ON zeta_ownership_edges (entity_id);
CREATE INDEX IF NOT EXISTS zeta_ownership_edges_owned_idx
  ON zeta_ownership_edges (entity_id, owned_entity_id);

-- ─── zeta_ubo_results: deterministic graph output (not the LLM's opinion) ─────
CREATE TABLE IF NOT EXISTS zeta_ubo_results (
  id              SERIAL      PRIMARY KEY,
  entity_id       INTEGER     NOT NULL REFERENCES zeta_entities (id) ON DELETE CASCADE,
  ubos            JSONB       NOT NULL,
  flags           JSONB       NOT NULL,
  review_required BOOLEAN     NOT NULL DEFAULT FALSE,
  threshold_pct   REAL        NOT NULL DEFAULT 25.0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Determinations are append-only (an audit trail of every recomputation);
-- reads take the newest row per entity.
CREATE INDEX IF NOT EXISTS zeta_ubo_results_entity_computed_idx
  ON zeta_ubo_results (entity_id, computed_at DESC);

-- ─── zeta_interrogations: serialized agentic interrogator state ───────────────
CREATE TABLE IF NOT EXISTS zeta_interrogations (
  id         SERIAL      PRIMARY KEY,
  entity_id  INTEGER     NOT NULL REFERENCES zeta_entities (id) ON DELETE CASCADE,
  status     TEXT        NOT NULL DEFAULT 'assess',
  pending    JSONB,
  state      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live interrogation per entity: resuming must not fork into two states.
CREATE UNIQUE INDEX IF NOT EXISTS zeta_interrogations_entity_key
  ON zeta_interrogations (entity_id);

-- ─── zeta_attestations: mirror of the 6-field minimal Canton claim + VC ───────
CREATE TABLE IF NOT EXISTS zeta_attestations (
  id                  SERIAL      PRIMARY KEY,
  entity_id           INTEGER     NOT NULL REFERENCES zeta_entities (id) ON DELETE CASCADE,
  canton_contract_id  TEXT        NOT NULL,
  decision            TEXT        NOT NULL,
  risk_tier           TEXT        NOT NULL,
  ubo_verified        BOOLEAN     NOT NULL,
  evidence_hash       TEXT        NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  vc_json             JSONB,
  revoked             BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zeta_attestations_entity_idx
  ON zeta_attestations (entity_id);
-- Relying-party verification and L4 relay both look up by contract id.
CREATE UNIQUE INDEX IF NOT EXISTS zeta_attestations_canton_contract_id_key
  ON zeta_attestations (canton_contract_id);

-- ─── Domain value guards ──────────────────────────────────────────────────────
-- The engine rejects out-of-domain values, but a bad value written directly to
-- SQL would produce an attestation no relying party can interpret. Enforce the
-- enums at the storage layer too. Added via DO $$ so re-running is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zeta_attestations_decision_chk'
  ) THEN
    ALTER TABLE zeta_attestations
      ADD CONSTRAINT zeta_attestations_decision_chk
      CHECK (decision IN ('approved', 'rejected', 'review_required'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zeta_attestations_risk_tier_chk'
  ) THEN
    ALTER TABLE zeta_attestations
      ADD CONSTRAINT zeta_attestations_risk_tier_chk
      CHECK (risk_tier IN ('low', 'medium', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zeta_ownership_edges_pct_chk'
  ) THEN
    -- A direct holding outside (0, 100] is an extraction error, not a fact.
    ALTER TABLE zeta_ownership_edges
      ADD CONSTRAINT zeta_ownership_edges_pct_chk
      CHECK (direct_pct > 0 AND direct_pct <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zeta_ownership_edges_conf_chk'
  ) THEN
    ALTER TABLE zeta_ownership_edges
      ADD CONSTRAINT zeta_ownership_edges_conf_chk
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zeta_ubo_results_threshold_chk'
  ) THEN
    ALTER TABLE zeta_ubo_results
      ADD CONSTRAINT zeta_ubo_results_threshold_chk
      CHECK (threshold_pct > 0 AND threshold_pct <= 100);
  END IF;
END $$;
