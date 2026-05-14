import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { trainingJobsTable } from "./trainingJobs";

export const evaluationRunsTable = pgTable("evaluation_runs", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  jobId: integer("job_id")
    .notNull()
    .references(() => trainingJobsTable.id),
  rubricId: text("rubric_id"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type EvaluationRun = typeof evaluationRunsTable.$inferSelect;
export type InsertEvaluationRun = typeof evaluationRunsTable.$inferInsert;
