import {
  pgTable,
  uuid,
  text,
  jsonb,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const zieTrainingRecordsTable = pgTable(
  "zie_training_records",
  {
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
  },
  (table) => ({
    promptHashUnique: uniqueIndex("idx_zie_training_records_prompt_hash_unique").on(
      table.promptHash,
    ),
    taskTypeIdx: index("idx_zie_training_records_task_type").on(table.taskType),
    domainIdx: index("idx_zie_training_records_domain").on(table.domain, table.createdAt),
    createdAtIdx: index("idx_zie_training_records_created_at").on(table.createdAt),
  }),
);

export type ZieTrainingRecord = typeof zieTrainingRecordsTable.$inferSelect;
export type InsertZieTrainingRecord = typeof zieTrainingRecordsTable.$inferInsert;
