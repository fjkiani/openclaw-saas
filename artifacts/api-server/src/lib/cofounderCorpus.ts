/**
 * cofounderCorpus.ts — clause type enums only.
 * Retrieval: legalCorpusRetrieve() in lib/legalCorpus/retrieve.ts (Postgres tsvector).
 */

export type CofounderClauseType =
  | "election_83b"
  | "ruo_medical_liability"
  | "equity_dilution_multi_product"
  | "ip_assignment_scope"
  | "vesting_schedule"
  | "indemnification_personal"
  | "deliverables_schedule_b"
  | "incorporation_entity_type"
  | "rspa_restricted_stock"
  | "mutual_deliverables";

/** @deprecated Use legalCorpusRetrieve — kept for import compatibility */
export type CorpusEntry = {
  id: string;
  clause_type: CofounderClauseType;
  title: string;
  rule: string;
  risk_level: "critical" | "high" | "medium";
  triggers: string[];
  example_clause: string;
  red_flags: string[];
  governance_trigger?: string;
  draft_template: string;
};
