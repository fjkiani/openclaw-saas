-- Migration 0003: zie_flywheel
-- Double-dip data flywheel: SFT vault + DPO preference pairs.

-- ─── SFT Vault: Stolen 120B outputs ──────────────────────────────────────────
CREATE TABLE zie_training_records (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type        text        NOT NULL,
  prompt_hash      text        NOT NULL UNIQUE,
  prompt_json      jsonb       NOT NULL,
  remote_response_json jsonb   NOT NULL,
  quality_score    numeric(5,4) NOT NULL,
  used_for_sft     boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_zie_training_records_task_type
  ON zie_training_records (task_type);

CREATE INDEX idx_zie_training_records_used_for_sft
  ON zie_training_records (used_for_sft)
  WHERE used_for_sft = false;

CREATE INDEX idx_zie_training_records_created_at
  ON zie_training_records (created_at DESC);

-- ─── DPO Vault: Local vs 120B comparisons ────────────────────────────────────
CREATE TABLE zie_preference_pairs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type             text        NOT NULL,
  prompt_hash           text        NOT NULL,
  chosen_response_json  jsonb       NOT NULL,
  rejected_response_json jsonb      NOT NULL,
  used_for_dpo          boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_zie_preference_pairs_task_type
  ON zie_preference_pairs (task_type);

CREATE INDEX idx_zie_preference_pairs_prompt_hash
  ON zie_preference_pairs (prompt_hash);

CREATE INDEX idx_zie_preference_pairs_used_for_dpo
  ON zie_preference_pairs (used_for_dpo)
  WHERE used_for_dpo = false;

CREATE INDEX idx_zie_preference_pairs_created_at
  ON zie_preference_pairs (created_at DESC);
