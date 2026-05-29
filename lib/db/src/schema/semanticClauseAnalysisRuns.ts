import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * semantic_clause_analysis_runs — one row per shadow analysis run.
 *
 * Inserted before analysis begins (status = "running").
 * Updated to "completed", "completed_with_errors", "completed_no_clauses",
 * "failed", or "skipped_unsupported_doc_class_mapping" when the run ends.
 *
 * Append-only for run rows; status is updated in-place.
 */
export const semanticClauseAnalysisRunsTable = pgTable("semantic_clause_analysis_runs", {
  runId:         uuid("run_id").primaryKey(),
  matterId:      uuid("matter_id").notNull(),
  tenantId:      text("tenant_id").notNull(),
  docClass:      text("doc_class").notNull(),
  routeChainId:  text("route_chain_id").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status:        text("status").notNull().default("running"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:   timestamp("completed_at", { withTimezone: true }),
});

export type SemanticClauseAnalysisRun =
  typeof semanticClauseAnalysisRunsTable.$inferSelect;
export type InsertSemanticClauseAnalysisRun =
  typeof semanticClauseAnalysisRunsTable.$inferInsert;
