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
    // ── Core columns (migration 0003) ──────────────────────────────────────
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskType: text("task_type").notNull(),
    promptHash: text("prompt_hash").notNull(),
    chosenResponseJson: jsonb("chosen_response_json").notNull(),
    rejectedResponseJson: jsonb("rejected_response_json").notNull(),
    usedForDpo: boolean("used_for_dpo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // ── Factory context columns (migration 0004) ───────────────────────────
    /** Vertical domain: 'seo', 'content', 'general', etc. */
    domain: text("domain").notNull().default("general"),
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
    /**
     * Why the chosen response was preferred.
     * 'remote_beats_local' = 120B output preferred over 1.2B
     * 'human_preferred'    = human reviewer chose this response
     */
    preferenceSource: text("preference_source").notNull().default("remote_beats_local"),
  },
  (table) => ({
    taskTypeIdx: index("idx_zie_preference_pairs_task_type").on(table.taskType),
    promptHashIdx: index("idx_zie_preference_pairs_prompt_hash").on(table.promptHash),
    createdAtIdx: index("idx_zie_preference_pairs_created_at").on(table.createdAt),
    // migration 0004 indexes
    domainIdx: index("idx_zie_preference_pairs_domain").on(table.domain),
    tenantIdIdx: index("idx_zie_preference_pairs_tenant_id").on(table.tenantId),
    workspaceIdIdx: index("idx_zie_preference_pairs_workspace_id").on(table.workspaceId),
  }),
);

export type ZiePreferencePair = typeof ziePreferencePairsTable.$inferSelect;
export type InsertZiePreferencePair = typeof ziePreferencePairsTable.$inferInsert;
