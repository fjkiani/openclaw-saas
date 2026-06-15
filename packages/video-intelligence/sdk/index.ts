/**
 * @workspace/video-intelligence SDK
 *
 * Entry point for the AACR 2026 Intelligence corpus SDK.
 *
 * Quick start:
 *   import { createAACRClient, searchCorpus, generateEmbedding } from '@workspace/video-intelligence/sdk';
 *
 * Environment variables required:
 *   SUPABASE_URL              — https://xfhiwodulrbbtfcqneqt.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service role JWT for project xfhiwodulrbbtfcqneqt
 *   OPENROUTER_API_KEY        — for embedding generation and re-ranking
 *
 * Supabase schema (all tables in project xfhiwodulrbbtfcqneqt):
 *   aacr_sessions          — 296 rows  — unique session slugs
 *   aacr_speakers          — 862 rows  — Schema A scientific extraction
 *   aacr_competitive_intel — 926 rows  — Schema B competitive intelligence
 *   aacr_clinical_data     — 1,480 rows — flattened clinical data entries
 *   aacr_embeddings        — 3,024 rows — pgvector embeddings (1536 dims)
 *
 * Embedding fields:
 *   moa_summary        — 862 embeddings (100% coverage)
 *   key_findings       — 861 embeddings
 *   crispro_opportunity — 851 embeddings
 *   cognitive_dissonance — 450 embeddings (sessions with CD hits only)
 *
 * Semantic search RPC:
 *   match_embeddings(query_embedding, match_field, match_count, match_threshold)
 *   → returns ranked results with similarity scores
 *
 * Double-dip flywheel:
 *   Every search call with rerank=true generates a DPO preference pair
 *   (fast=embedding-only, slow=GPT-4o re-ranked) stored in zie_preference_pairs
 *   under domain='aacr', task_type='competitive_intel_extraction'.
 *   At 50 verified pairs → Modal LoRA fine-tune fires automatically.
 */

export { createAACRClient } from "./client.js";
export type { AACRClient, AACRClientConfig } from "./client.js";

export { generateEmbedding, rerankResults, searchCorpus } from "./search.js";
export type { SearchOptions, SearchResponse } from "./search.js";

export {
  loadSessions,
  loadSpeakers,
  loadCompetitiveIntel,
  loadClinicalData,
  loadEmbeddings,
  loadPipelineRun,
} from "./loader.js";
export type { LoaderConfig, PipelineLoadResult } from "./loader.js";

export type {
  AACRSession,
  AACRSpeaker,
  CompetitiveIntel,
  ClinicalData,
  AACREmbedding,
  CrisPROOpportunity,
  ClinicalStage,
  NoveltyFlag,
  PresentationType,
  DataMaturity,
  CrisPROOpportunityType,
  EmbeddingField,
  SpeakerFilter,
  CDHitFilter,
  CrisPROFilter,
  SemanticSearchRequest,
  SemanticSearchResult,
  CorpusStats,
  FlywheelStatus,
  FlywheelDomainStatus,
} from "./types.js";
