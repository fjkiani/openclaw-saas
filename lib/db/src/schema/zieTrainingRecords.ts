import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { modelWorkspacesTable } from "./modelWorkspaces";
import { datasetVersionsTable } from "./datasetVersions";
import { modelVersionsTable } from "./modelVersions";

// SFT substrate: one promoted/corrected judgment per row. Domain-agnostic.
export const zieTrainingRecordsTable = pgTable(
  "zie_training_records",
  {
    trainingRecordId: uuid("training_record_id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    domain: text("domain").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => modelWorkspacesTable.id),
    datasetVersionId: integer("dataset_version_id").references(
      () => datasetVersionsTable.id,
    ),
    modelVersionId: integer("model_version_id").references(
      () => modelVersionsTable.id,
    ),
    // CHECK in migration: 'remote_promoted' | 'human_corrected' | 'local_gold'
    sourceKind: text("source_kind").notNull(),
    sourceRunId: uuid("source_run_id"),
    sourceAnalysisRef: text("source_analysis_ref"),
    // CHECK in migration: 'posting_screen' | 'slop_detection' | 'manuscript_review' | 'clause_analysis'
    taskType: text("task_type").notNull(),
    promptJson: jsonb("prompt_json").notNull().default({}),
    responseJson: jsonb("response_json").notNull().default({}),
    rationale: text("rationale"),
    verdict: text("verdict"),
    tags: text("tags").array().notNull().default(sql`'{}'`),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    qualityScore: numeric("quality_score", { precision: 5, scale: 4 }),
    usedForSft: boolean("used_for_sft").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_ztr_tenant_domain_task").on(t.tenantId, t.domain, t.taskType),
    index("idx_ztr_dataset_version").on(t.datasetVersionId),
    index("idx_ztr_confidence").on(t.confidence.desc()),
    index("idx_ztr_used_for_sft").on(t.usedForSft),
  ],
);

export type ZieTrainingRecord = typeof zieTrainingRecordsTable.$inferSelect;
export type InsertZieTrainingRecord = typeof zieTrainingRecordsTable.$inferInsert;
