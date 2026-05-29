import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { semanticClauseAnalysisRunsTable } from "./semanticClauseAnalysisRuns.js";

/**
 * semantic_clause_analysis_attempts — one row per model invocation attempt.
 *
 * Logged for every attempt (success, failure, exhaustion) regardless of whether
 * a semantic_clause_analyses row is ultimately written. Enables per-model
 * reliability tracking and latency analysis.
 *
 * status values: "success" | "error" | "exhausted" | "schema_failure" | "unusable"
 */
export const semanticClauseAnalysisAttemptsTable = pgTable(
  "semantic_clause_analysis_attempts",
  {
    attemptId:     uuid("attempt_id").primaryKey(),
    runId:         uuid("run_id")
                     .notNull()
                     .references(() => semanticClauseAnalysisRunsTable.runId),
    clauseId:      text("clause_id").notNull(),
    modelId:       text("model_id").notNull(),
    provider:      text("provider").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status:        text("status").notNull(),
    errorCode:     text("error_code"),
    errorMessage:  text("error_message"),
    latencyMs:     integer("latency_ms"),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type SemanticClauseAnalysisAttempt =
  typeof semanticClauseAnalysisAttemptsTable.$inferSelect;
export type InsertSemanticClauseAnalysisAttempt =
  typeof semanticClauseAnalysisAttemptsTable.$inferInsert;
