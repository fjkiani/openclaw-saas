/**
 * legalCounsel/types.ts — Shared types for orchestrator + lens agents.
 */

import type { LegalCorpusHit } from "../legalCorpus/retrieve.js";
import type { ContractSignals } from "./contractSignals.js";
import type { GroundedFinding, InferredFinding } from "./grounding.js";
import type { CompanyOpportunity } from "./companyLeverage.js";
import type { VersionDiffItem } from "./diffVersions.js";

// ── Lens agent I/O ────────────────────────────────────────────────────────────

export type LensName =
  | "tax_securities"
  | "delaware_corp"
  | "ip_assignment"
  | "regulatory_employment";

export interface LensInput {
  contractText: string;
  digest: string;
  ragHits: LegalCorpusHit[];
  signals: ContractSignals;
  perspective: "company" | "counterparty" | "neutral";
  versionDiffs?: VersionDiffItem[];
}

export interface LensFinding {
  lens: LensName;
  severity: "critical" | "high" | "medium" | "low" | "info";
  issue: string;
  chunk_id?: number;
  slug?: string;
  corpus_excerpt?: string;
  contract_excerpt?: string;
  recommendation: string;
  is_inferred?: boolean;
  inferred_reason?: string;
}

export interface LensOutput {
  lens: LensName;
  findings: LensFinding[];
  redlines: Array<{
    section: string;
    original_excerpt: string;
    suggested_text: string;
    rationale: string;
    favors: "company" | "balanced" | "counterparty";
  }>;
  opportunities: CompanyOpportunity[];
  model_used: string;
  latency_ms: number;
}

// ── Orchestrator result ───────────────────────────────────────────────────────

export interface OrchestratorResult {
  lens_outputs: LensOutput[];
  reconciled_findings_grounded: GroundedFinding[];
  reconciled_findings_inferred: InferredFinding[];
  reconciled_redlines: Array<{
    section: string;
    original_excerpt: string;
    suggested_text: string;
    rationale: string;
    favors: "company" | "balanced" | "counterparty";
  }>;
  reconciled_opportunities: CompanyOpportunity[];
  blocking_issues: string[];
  compliance_passed: boolean;
  compliance_flags: string[];
  meta: {
    orchestrator_mode: true;
    lens_models: string[];
    grounded_ratio: number;
    parallel_ms: number;
  };
}
