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
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { modelWorkspacesTable } from "./modelWorkspaces";
import { datasetVersionsTable } from "./datasetVersions";
import { zieTrainingRecordsTable } from "./zieTrainingRecords";

// DPO substrate: chosen-vs-rejected training-record pairs. Domain-agnostic.
export const ziePreferencePairsTable = pgTable(
  "zie_preference_pairs",
  {
    preferencePairId: uuid("preference_pair_id")
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
    promptJson: jsonb("prompt_json").notNull().default({}),
    chosenTrainingRecordId: uuid("chosen_training_record_id")
      .notNull()
      .references(() => zieTrainingRecordsTable.trainingRecordId, {
        onDelete: "cascade",
      }),
    rejectedTrainingRecordId: uuid("rejected_training_record_id")
      .notNull()
      .references(() => zieTrainingRecordsTable.trainingRecordId, {
        onDelete: "cascade",
      }),
    // CHECK in migration: 'remote_beats_local' | 'human_beats_remote' | 'human_beats_local'
    preferenceSource: text("preference_source").notNull(),
    pairWeight: numeric("pair_weight", { precision: 6, scale: 4 })
      .notNull()
      .default("1.0"),
    usedForDpo: boolean("used_for_dpo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_zpp_tenant_domain_created").on(
      t.tenantId,
      t.domain,
      t.createdAt.desc(),
    ),
    index("idx_zpp_dataset_version").on(t.datasetVersionId),
    index("idx_zpp_used_for_dpo").on(t.usedForDpo),
    check(
      "zie_pref_distinct_records",
      sql`${t.chosenTrainingRecordId} <> ${t.rejectedTrainingRecordId}`,
    ),
  ],
);

export type ZiePreferencePair = typeof ziePreferencePairsTable.$inferSelect;
export type InsertZiePreferencePair = typeof ziePreferencePairsTable.$inferInsert;
