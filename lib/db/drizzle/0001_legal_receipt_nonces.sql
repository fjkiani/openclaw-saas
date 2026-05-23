-- Migration 0001: legal_receipt_nonces
-- One-time-use receipt tracking for Phase 2A action generation.
-- receipt_id PRIMARY KEY enforces uniqueness — INSERT fails with 23505 on replay.

CREATE TABLE IF NOT EXISTS legal_receipt_nonces (
  receipt_id  UUID        PRIMARY KEY,
  matter_id   UUID        NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_type TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL
);
