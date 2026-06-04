-- Migration 0004: zie_router_policies
-- Deployment payoff table: maps task_type to the active fast-path model.
-- After Modal completes a LoRA fine-tune, updateRoutingPolicy() writes here.
-- executeDoubleDip() reads this table at invocation time to resolve the fast-path model ID.

CREATE TABLE zie_router_policies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type        text        NOT NULL UNIQUE,
  fast_model_id    text        NOT NULL,
  fast_provider    text        NOT NULL DEFAULT 'openrouter',
  fast_api_key_env text        NOT NULL DEFAULT 'OPENROUTER_API_KEY',
  fast_max_tokens  integer     NOT NULL DEFAULT 512,
  fast_timeout_ms  integer     NOT NULL DEFAULT 8000,
  source_job_id    integer,
  promoted_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Seed defaults: before any fine-tune completes, use the base models
INSERT INTO zie_router_policies
  (task_type, fast_model_id, fast_provider, fast_api_key_env, fast_max_tokens, fast_timeout_ms)
VALUES
  ('manuscript_slop_check',  'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter', 'OPENROUTER_API_KEY', 512,  8000),
  ('legal_clause_analysis',  'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter', 'OPENROUTER_API_KEY', 768,  10000),
  ('seo_content_audit',      'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter', 'OPENROUTER_API_KEY', 512,  8000)
ON CONFLICT (task_type) DO NOTHING;

CREATE INDEX idx_zie_router_policies_task_type ON zie_router_policies (task_type);
