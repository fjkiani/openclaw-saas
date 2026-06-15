/**
 * types.ts — Shared TypeScript types for the AACR 2026 Intelligence corpus.
 *
 * These mirror the Supabase table schemas created during the AACR pipeline run.
 * Tables live in project: xfhiwodulrbbtfcqneqt
 *
 * Table → Type mapping:
 *   aacr_sessions          → AACRSession
 *   aacr_speakers          → AACRSpeaker
 *   aacr_competitive_intel → CompetitiveIntel
 *   aacr_clinical_data     → ClinicalData
 *   aacr_embeddings        → AACREmbedding
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums (match extractor schema values)
// ─────────────────────────────────────────────────────────────────────────────

export type ClinicalStage =
  | "preclinical"
  | "IND_enabling"
  | "phase_1"
  | "phase_1_2"
  | "phase_2"
  | "phase_2_3"
  | "phase_3"
  | "approved"
  | "mixed"
  | "unspecified";

export type NoveltyFlag =
  | "first_in_class"
  | "best_in_class"
  | "me_too"
  | "platform_technology"
  | "clinical_validation_of_known"
  | "negative_or_null_result"
  | "unspecified";

export type PresentationType =
  | "clinical_trial_readout"
  | "translational_science"
  | "platform_showcase"
  | "basic_science"
  | "industry_pitch"
  | "preclinical_science"
  | "policy_lecture"
  | "panel_discussion"
  | "award_lecture";

export type DataMaturity =
  | "preclinical_only"
  | "early_clinical"
  | "mature_clinical"
  | "mixed"
  | "not_applicable";

export type CrisPROOpportunityType =
  | "biomarker_stratification_gap"
  | "combination_partner"
  | "resistance_mechanism_addressable"
  | "trial_design_improvement"
  | "platform_superiority_angle"
  | "failed_asset_salvage";

export type EmbeddingField =
  | "moa_summary"
  | "key_findings"
  | "cognitive_dissonance"
  | "crispro_opportunity";

// ─────────────────────────────────────────────────────────────────────────────
// Table row types
// ─────────────────────────────────────────────────────────────────────────────

export interface AACRSession {
  id: number;
  slug: string;
  title: string | null;
  created_at: string;
}

export interface AACRSpeaker {
  id: number;
  talk_id: string;
  session_slug: string | null;
  session_title: string | null;
  talk_title: string | null;
  speaker_name: string | null;
  affiliation: string | null;
  role: string | null;
  disclosures_noted: boolean;
  tumor_types: string[];
  clinical_stage: ClinicalStage | null;
  topic_categories: string[];
  novelty_flag: NoveltyFlag | null;
  moa_summary: string | null;
  key_findings: string[];
  readouts: string[];
  resistance_notes: string[];
  open_questions: string[];
  targets: Record<string, unknown> | null;
  biomarkers: Record<string, unknown> | null;
  models: Record<string, unknown> | null;
  clinical_data: Record<string, unknown> | null;
  combination_strategies: Record<string, unknown> | null;
  external_follow_up: Record<string, unknown> | null;
  created_at: string;
}

export interface CrisPROOpportunity {
  opportunity_type: CrisPROOpportunityType;
  priority: "high" | "medium" | "low";
  description: string;
  transcript_evidence: string;
  crispro_angle: string;
}

export interface CompetitiveIntel {
  id: number;
  talk_id: string;
  speaker_talk_id: string | null;
  session_slug: string | null;
  speaker_name: string | null;
  institution: string | null;
  session_title: string | null;
  talk_title: string | null;
  presentation_type: PresentationType | null;
  rhetorical_signals: string[];
  cognitive_dissonance: string[];
  vulnerability_identified: Record<string, unknown> | null;
  trial_dilution_risk: Record<string, unknown> | null;
  competitive_moat_weakness: Record<string, unknown> | null;
  data_maturity: DataMaturity | null;
  sample_size_adequacy: string | null;
  follow_up_adequacy: string | null;
  key_data_gaps: string[];
  crispro_opportunity: CrisPROOpportunity[];
  cited_competitors: Record<string, unknown>[] | null;
  unresolved_questions: string[];
  nct_candidates: string[];
  assets_to_track: string[];
  companies_to_monitor: string[];
  created_at: string;
}

export interface ClinicalData {
  id: number;
  talk_id: string | null;
  speaker_name: string | null;
  affiliation: string | null;
  session_slug: string | null;
  tumor_types: string[];
  clinical_stage: ClinicalStage | null;
  metric: string | null;
  value: string | null;
  confidence_interval: string | null;
  n: string | null;
  population: string | null;
  comparator: string | null;
  maturity: string | null;
  created_at: string;
}

export interface AACREmbedding {
  id: number;
  source_table: "aacr_speakers" | "aacr_competitive_intel";
  source_id: number;
  talk_id: string | null;
  speaker_name: string | null;
  session_slug: string | null;
  field_name: EmbeddingField;
  chunk_text: string;
  embedding: number[];
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query / filter types
// ─────────────────────────────────────────────────────────────────────────────

export interface SpeakerFilter {
  tumor_type?: string;
  clinical_stage?: ClinicalStage;
  novelty_flag?: NoveltyFlag;
  session_slug?: string;
  limit?: number;
  offset?: number;
}

export interface CDHitFilter {
  presentation_type?: PresentationType;
  data_maturity?: DataMaturity;
  min_cd_count?: number;
  limit?: number;
  offset?: number;
}

export interface CrisPROFilter {
  opportunity_type?: CrisPROOpportunityType;
  priority?: "high" | "medium" | "low";
  presentation_type?: PresentationType;
  limit?: number;
  offset?: number;
}

export interface SemanticSearchRequest {
  query: string;
  field?: EmbeddingField;
  match_count?: number;
  match_threshold?: number;
}

export interface SemanticSearchResult {
  id: number;
  source_table: string;
  source_id: number;
  talk_id: string | null;
  speaker_name: string | null;
  session_slug: string | null;
  field_name: EmbeddingField;
  chunk_text: string;
  similarity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus stats (returned by /api/intelligence/stats)
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusStats {
  sessions: number;
  speakers: number;
  competitive_intel_records: number;
  clinical_data_entries: number;
  embeddings: number;
  embeddings_by_field: Record<EmbeddingField, number>;
  presentation_type_distribution: Record<string, number>;
  clinical_stage_distribution: Record<string, number>;
  top_companies: Array<{ company: string; count: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flywheel status (mirrors zie_training_records / zie_preference_pairs)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlywheelDomainStatus {
  domain: string;
  task_type: string;
  sft_records: number;
  total_pairs: number;
  verified_pairs: number;
  pct: number;
  training_status: "accumulating" | "threshold_met" | "training" | "deployed";
}

export interface FlywheelStatus {
  threshold: number;
  domains: FlywheelDomainStatus[];
}
