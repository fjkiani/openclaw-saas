import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { semanticClauseAnalysisRunsTable } from "./semanticClauseAnalysisRuns.js";

/**
 * semantic_clause_analyses — one row per clause per run.
 *
 * Persisted only when the model returns a valid, schema-conformant response.
 * Unusable outputs (refusals, generic text, schema failures) are logged to
 * semantic_clause_analysis_attempts but never inserted here.
 *
 * missing_elements and alternative_interpretations are stored as JSONB arrays.
 * Use .default([]) in application code — do not rely on DB-level defaults for arrays.
 */
export const semanticClauseAnalysesTable = pgTable("semantic_clause_analyses", {
  analysisId:                uuid("analysis_id").primaryKey(),
  runId:                     uuid("run_id")
                               .notNull()
                               .references(() => semanticClauseAnalysisRunsTable.runId),
  matterId:                  uuid("matter_id").notNull(),
  clauseId:                  text("clause_id").notNull(),
  clauseLabel:               text("clause_label").notNull(),
  riskLevel:                 text("risk_level").notNull(),
  summary:                   text("summary").notNull(),
  missingElements:           jsonb("missing_elements").notNull().default([]),
  recommendedAction:         text("recommended_action").notNull(),
  confidence:                text("confidence").notNull(),
  reasoning:                 text("reasoning"),
  alternativeInterpretations: jsonb("alternative_interpretations").notNull().default([]),
  modelId:                   text("model_id").notNull(),
  promptVersion:             text("prompt_version").notNull(),
  schemaVersion:             text("schema_version").notNull(),
  rawResponse:               text("raw_response").notNull(),
  createdAt:                 timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SemanticClauseAnalysis =
  typeof semanticClauseAnalysesTable.$inferSelect;
export type InsertSemanticClauseAnalysis =
  typeof semanticClauseAnalysesTable.$inferInsert;
