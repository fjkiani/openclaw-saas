import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { trainingJobsTable } from "./trainingJobs";

export const trainingJobArtifactsTable = pgTable("training_job_artifacts", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  jobId: integer("job_id")
    .notNull()
    .references(() => trainingJobsTable.id),
  artifactType: text("artifact_type").notNull(),
  storageKey: text("storage_key"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TrainingJobArtifact = typeof trainingJobArtifactsTable.$inferSelect;
export type InsertTrainingJobArtifact = typeof trainingJobArtifactsTable.$inferInsert;
