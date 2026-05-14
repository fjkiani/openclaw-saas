import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelWorkspacesTable } from "./modelWorkspaces";
import { modelDatasetsTable } from "./modelDatasets";
import { datasetVersionsTable } from "./datasetVersions";

export const trainingJobsTable = pgTable("training_jobs", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => modelWorkspacesTable.id),
  datasetId: integer("dataset_id")
    .notNull()
    .references(() => modelDatasetsTable.id),
  datasetVersionId: integer("dataset_version_id")
    .notNull()
    .references(() => datasetVersionsTable.id),
  name: text("name").notNull(),
  mode: text("mode").notNull(),
  baseModel: text("base_model").notNull(),
  hyperparams: jsonb("hyperparams").notNull().default({}),
  status: text("status").notNull().default("draft"),
  kairosRunId: text("kairos_run_id"),
  computeBackend: text("compute_backend").notNull().default("stub"),
  reforgeSuggested: boolean("reforge_suggested").notNull().default(false),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TrainingJob = typeof trainingJobsTable.$inferSelect;
export type InsertTrainingJob = typeof trainingJobsTable.$inferInsert;
