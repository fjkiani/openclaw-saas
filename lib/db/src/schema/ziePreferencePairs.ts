import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ziePreferencePairsTable = pgTable(
  "zie_preference_pairs",
  {
    // ── Core columns ───────────────────────────────────────────────────────
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskType: text("task_type").notNull(),
    domain: text("domain").notNull().default("unknown"),
    sourceKind: text("source_kind").notNull().default("direct_call"),
    preferenceSource: text("preference_source").notNull().default("path_race"),
    promptHash: text("prompt_hash").notNull(),
    chosenResponseJson: jsonb("chosen_response_json").notNull(),
    rejectedResponseJson: jsonb("rejected_response_json").notNull(),
    usedForDpo: boolean("used_for_dpo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // ── Factory context columns (migration 0004) ───────────────────────────
    /** Tenant identifier (null for system-level records) */
    tenantId: text("tenant_id"),
    /** Workspace FK (integer, matches workspaces.id) */
    workspaceId: integer("workspace_id"),
    /**
     * FK → zie_training_records(id) for the chosen (120B / remote) response.
     * Enables JOIN to retrieve full prompt + response for SFT training.
     */
    chosenTrainingRecordId: uuid("chosen_training_record_id"),
    /**
     * FK → zie_training_records(id) for the rejected (1.2B / local) response.
     * Must differ from chosenTrainingRecordId — enforced at application layer.
     */
    rejectedTrainingRecordId: uuid("rejected_training_record_id"),
  },
  (table) => ({
    taskTypeIdx: index("idx_zie_preference_pairs_task_type").on(table.taskType),
    domainIdx: index("idx_zie_preference_pairs_domain").on(table.domain, table.createdAt),
    promptHashIdx: index("idx_zie_preference_pairs_prompt_hash").on(table.promptHash),
    createdAtIdx: index("idx_zie_preference_pairs_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_zie_preference_pairs_tenant_id").on(table.tenantId),
    workspaceIdIdx: index("idx_zie_preference_pairs_workspace_id").on(table.workspaceId),
  }),
);

export type ZiePreferencePair = typeof ziePreferencePairsTable.$inferSelect;
export type InsertZiePreferencePair = typeof ziePreferencePairsTable.$inferInsert;
