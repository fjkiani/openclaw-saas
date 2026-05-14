import {
  pgTable,
  text,
  serial,
  integer,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelDeploymentsTable } from "./modelDeployments";
import { trainingJobsTable } from "./trainingJobs";

export const modelUsageEventsTable = pgTable("model_usage_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  deploymentId: integer("deployment_id").references(
    () => modelDeploymentsTable.id,
  ),
  jobId: integer("job_id").references(() => trainingJobsTable.id),
  eventType: text("event_type").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelUsageEvent = typeof modelUsageEventsTable.$inferSelect;
export type InsertModelUsageEvent = typeof modelUsageEventsTable.$inferInsert;
