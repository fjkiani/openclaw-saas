import {
  pgTable,
  text,
  serial,
  integer,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { evaluationRunsTable } from "./evaluationRuns";

/**
 * evaluation_metrics — per-metric results for an evaluation run.
 *
 * Canonical column decision (locked, .cursor/rules/08-database-schema.mdc):
 *   eval_run_id (integer FK) / metric_value (real) / metadata (jsonb).
 * Matches migration 0007_judge_evaluation_bridge.sql. tenant_id is nullable to
 * match the live table (system-written metrics may have no tenant).
 */
export const evaluationMetricsTable = pgTable("evaluation_metrics", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id"),
  evalRunId: integer("eval_run_id")
    .notNull()
    .references(() => evaluationRunsTable.id, { onDelete: "cascade" }),
  metricName: text("metric_name").notNull(),
  metricValue: real("metric_value").notNull(),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EvaluationMetric = typeof evaluationMetricsTable.$inferSelect;
export type InsertEvaluationMetric = typeof evaluationMetricsTable.$inferInsert;
