-- AACR Evidence Explorer v1
-- Registry existence, target association, and AACR linkage are represented separately.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS aacr_abstracts (
  record_id text PRIMARY KEY,
  doi text,
  title text NOT NULL,
  abstract_text text NOT NULL,
  source_label text,
  source_sha256 text NOT NULL,
  enrichment_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  disposition text NOT NULL,
  permitted_use text NOT NULL DEFAULT 'INTERNAL_FORENSIC_ONLY',
  human_qc_status text NOT NULL DEFAULT 'NOT_STARTED',
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(abstract_text,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(enrichment_json::text,'')), 'C')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aacr_abstracts_search_idx ON aacr_abstracts USING gin(search_document);
CREATE INDEX IF NOT EXISTS aacr_abstracts_doi_idx ON aacr_abstracts(doi);

CREATE TABLE IF NOT EXISTS aacr_registry_studies (
  nct_id text PRIMARY KEY CHECK (nct_id ~ '^NCT[0-9]{8}$'),
  brief_title text,
  official_title text,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  interventions jsonb NOT NULL DEFAULT '[]'::jsonb,
  lead_sponsor text,
  collaborators jsonb NOT NULL DEFAULT '[]'::jsonb,
  phases jsonb NOT NULL DEFAULT '[]'::jsonb,
  overall_status text,
  start_date text,
  primary_completion_date text,
  current_response_sha256 text NOT NULL,
  verified_at timestamptz NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(nct_id,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(brief_title,'') || ' ' || coalesce(official_title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(conditions::text,'') || ' ' || coalesce(interventions::text,'') || ' ' || coalesce(lead_sponsor,'')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS aacr_registry_studies_search_idx ON aacr_registry_studies USING gin(search_document);
CREATE INDEX IF NOT EXISTS aacr_registry_sponsor_idx ON aacr_registry_studies(lower(lead_sponsor));

CREATE TABLE IF NOT EXISTS aacr_registry_response_versions (
  response_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nct_id text NOT NULL,
  request_url text NOT NULL,
  http_status integer NOT NULL,
  fetched_at timestamptz NOT NULL,
  response_sha256 text NOT NULL,
  raw_response jsonb,
  UNIQUE(nct_id, response_sha256)
);

CREATE TABLE IF NOT EXISTS aacr_trial_linkages (
  linkage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text NOT NULL REFERENCES aacr_abstracts(record_id) ON DELETE CASCADE,
  nct_id text NOT NULL,
  linkage_state text NOT NULL CHECK (linkage_state IN (
    'CONFIRMED_DIRECT_LINK','CONFIRMED_CONTEXTUAL_LINK','REAL_NCT_UNLINKED_TO_ABSTRACT',
    'AMBIGUOUS_REVIEW_REQUIRED','NOT_FOUND'
  )),
  rule_version text NOT NULL,
  evidence_json jsonb NOT NULL,
  receipt_id text NOT NULL UNIQUE,
  permitted_use text NOT NULL,
  human_qc_status text NOT NULL DEFAULT 'NOT_STARTED',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_record_id, nct_id, rule_version)
);
CREATE INDEX IF NOT EXISTS aacr_trial_linkages_nct_idx ON aacr_trial_linkages(nct_id);
CREATE INDEX IF NOT EXISTS aacr_trial_linkages_state_idx ON aacr_trial_linkages(linkage_state);

CREATE TABLE IF NOT EXISTS aacr_claim_receipts (
  receipt_id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  field_name text NOT NULL,
  value_json jsonb NOT NULL,
  source_state text NOT NULL,
  evidence_tier text NOT NULL,
  lifecycle_status text NOT NULL,
  source_excerpt text,
  source_hash text NOT NULL,
  permitted_use text NOT NULL,
  claim_eligible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aacr_claim_entity_idx ON aacr_claim_receipts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS aacr_claim_eligibility_idx ON aacr_claim_receipts(claim_eligible, permitted_use);

CREATE TABLE IF NOT EXISTS aacr_conflicts (
  conflict_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id text NOT NULL REFERENCES aacr_abstracts(record_id) ON DELETE CASCADE,
  field_name text NOT NULL,
  values_json jsonb NOT NULL,
  models_json jsonb NOT NULL,
  routing text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aacr_conflicts_status_idx ON aacr_conflicts(status, created_at);

CREATE TABLE IF NOT EXISTS aacr_target_search_results (
  result_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_query text NOT NULL,
  nct_id text NOT NULL,
  registry_fact_receipt_id text NOT NULL,
  registry_fact_state text NOT NULL,
  target_association_state text NOT NULL,
  aacr_abstract_linkage_state text NOT NULL,
  query_protocol text,
  search_timestamp timestamptz,
  permitted_use text NOT NULL,
  UNIQUE(target_query, nct_id, query_protocol)
);
CREATE INDEX IF NOT EXISTS aacr_target_query_idx ON aacr_target_search_results(lower(target_query));

CREATE TABLE IF NOT EXISTS aacr_reviewer_roles (
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('VIEWER','ANNOTATOR','ADJUDICATOR','ADMIN')),
  active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, role)
);

CREATE TABLE IF NOT EXISTS aacr_review_items (
  review_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id text NOT NULL REFERENCES aacr_abstracts(record_id) ON DELETE CASCADE,
  source_set_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'UNASSIGNED' CHECK (state IN (
    'UNASSIGNED','ASSIGNED','INDEPENDENT_REVIEW','DISAGREEMENT','ADJUDICATION',
    'PROMOTED','REJECTED'
  )),
  test_only boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(record_id, test_only)
);

CREATE TABLE IF NOT EXISTS aacr_review_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id uuid NOT NULL REFERENCES aacr_review_items(review_item_id) ON DELETE CASCADE,
  reviewer_id text NOT NULL,
  slot smallint NOT NULL CHECK (slot IN (1,2)),
  status text NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','CLAIMED','SUBMITTED')),
  claimed_at timestamptz,
  submitted_at timestamptz,
  UNIQUE(review_item_id, slot),
  UNIQUE(review_item_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS aacr_review_labels (
  label_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id uuid NOT NULL REFERENCES aacr_review_items(review_item_id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL UNIQUE REFERENCES aacr_review_assignments(assignment_id) ON DELETE CASCADE,
  reviewer_id text NOT NULL,
  linkage_label text NOT NULL CHECK (linkage_label IN (
    'CONFIRMED_DIRECT_LINK','CONFIRMED_CONTEXTUAL_LINK','REAL_NCT_UNLINKED_TO_ABSTRACT',
    'AMBIGUOUS_REVIEW_REQUIRED','NOT_FOUND'
  )),
  target_concordance text NOT NULL CHECK (target_concordance IN ('SUPPORTED','NOT_SUPPORTED','INSUFFICIENT_EVIDENCE')),
  disease_concordance text NOT NULL CHECK (disease_concordance IN ('SUPPORTED','NOT_SUPPORTED','INSUFFICIENT_EVIDENCE')),
  intervention_concordance text NOT NULL CHECK (intervention_concordance IN ('SUPPORTED','NOT_SUPPORTED','INSUFFICIENT_EVIDENCE')),
  rationale text NOT NULL CHECK (length(rationale) >= 10),
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aacr_review_adjudications (
  adjudication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id uuid NOT NULL UNIQUE REFERENCES aacr_review_items(review_item_id) ON DELETE CASCADE,
  adjudicator_id text NOT NULL,
  final_label text NOT NULL CHECK (final_label IN (
    'CONFIRMED_DIRECT_LINK','CONFIRMED_CONTEXTUAL_LINK','REAL_NCT_UNLINKED_TO_ABSTRACT',
    'AMBIGUOUS_REVIEW_REQUIRED','NOT_FOUND'
  )),
  decision text NOT NULL CHECK (decision IN ('PROMOTE','REJECT')),
  rationale text NOT NULL CHECK (length(rationale) >= 10),
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aacr_review_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id uuid NOT NULL REFERENCES aacr_review_items(review_item_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  event_type text NOT NULL,
  from_state text,
  to_state text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  test_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aacr_review_events_item_idx ON aacr_review_events(review_item_id, created_at);

CREATE OR REPLACE FUNCTION aacr_reject_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'aacr_review_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS aacr_review_events_immutable_update ON aacr_review_events;
CREATE TRIGGER aacr_review_events_immutable_update BEFORE UPDATE OR DELETE ON aacr_review_events
FOR EACH ROW EXECUTE FUNCTION aacr_reject_event_mutation();

CREATE TABLE IF NOT EXISTS aacr_validation_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_type text NOT NULL,
  metrics_json jsonb NOT NULL,
  denominator integer,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
