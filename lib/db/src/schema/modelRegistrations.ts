import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelWorkspacesTable } from "./modelWorkspaces";
import { trainingJobsTable } from "./trainingJobs";

export const modelRegistrationsTable = pgTable("model_registrations", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => modelWorkspacesTable.id),
  jobId: integer("job_id")
    .notNull()
    .references(() => trainingJobsTable.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelRegistration = typeof modelRegistrationsTable.$inferSelect;
export type InsertModelRegistration = typeof modelRegistrationsTable.$inferInsert;
