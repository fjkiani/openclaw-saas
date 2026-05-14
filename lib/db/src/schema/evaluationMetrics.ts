import {
  pgTable,
  text,
  serial,
  integer,
  real,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { evaluationRunsTable } from "./evaluationRuns";

export const evaluationMetricsTable = pgTable("evaluation_metrics", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  evalRunId: integer("eval_run_id")
    .notNull()
    .references(() => evaluationRunsTable.id),
  metricName: text("metric_name").notNull(),
  value: real("value").notNull(),
  threshold: real("threshold"),
  passed: boolean("passed"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EvaluationMetric = typeof evaluationMetricsTable.$inferSelect;
export type InsertEvaluationMetric = typeof evaluationMetricsTable.$inferInsert;
