import {
  pgTable,
  uuid,
  text,
  jsonb,
  numeric,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const zieTrainingRecordsTable = pgTable(
  "zie_training_records",
  {
    // ── Core columns ───────────────────────────────────────────────────────
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskType: text("task_type").notNull(),
    domain: text("domain").notNull().default("unknown"),
    sourceKind: text("source_kind").notNull().default("direct_call"),
    promptHash: text("prompt_hash").notNull(),
    promptJson: jsonb("prompt_json").notNull(),
    remoteResponseJson: jsonb("remote_response_json").notNull(),
    qualityScore: numeric("quality_score", { precision: 5, scale: 4 }).notNull(),
    usedForSft: boolean("used_for_sft").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // ── Factory context columns (migration 0004) ───────────────────────────
    /** Tenant identifier (null for system-level records) */
    tenantId: text("tenant_id"),
    /** Workspace FK (integer, matches workspaces.id) */
    workspaceId: integer("workspace_id"),
    /** Dataset version for training lineage tracking */
    datasetVersionId: integer("dataset_version_id"),
    /** Model version that produced this record */
    modelVersionId: integer("model_version_id"),
    /** UUID of the originating audit/inference run (one per POST request) */
    sourceRunId: uuid("source_run_id"),
    /** Human-readable reference to the source analysis (e.g. SHA-256 prompt hash) */
    sourceAnalysisRef: text("source_analysis_ref"),
    /** FK → evaluation_runs(id) — bridges ZIE flywheel to eval runs */
    evaluationRunId: integer("evaluation_run_id"),
  },
  (table) => ({
    promptHashUnique: uniqueIndex("idx_zie_training_records_prompt_hash_unique").on(
      table.promptHash,
    ),
    taskTypeIdx: index("idx_zie_training_records_task_type").on(table.taskType),
    domainIdx: index("idx_zie_training_records_domain").on(table.domain, table.createdAt),
    createdAtIdx: index("idx_zie_training_records_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_zie_training_records_tenant_id").on(table.tenantId),
    workspaceIdIdx: index("idx_zie_training_records_workspace_id").on(table.workspaceId),
    sourceKindIdx: index("idx_zie_training_records_source_kind").on(table.sourceKind),
    sourceRunIdIdx: index("idx_zie_training_records_source_run_id").on(table.sourceRunId),
  }),
);

export type ZieTrainingRecord = typeof zieTrainingRecordsTable.$inferSelect;
export type InsertZieTrainingRecord = typeof zieTrainingRecordsTable.$inferInsert;
