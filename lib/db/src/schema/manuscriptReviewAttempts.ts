import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manuscriptReviewRunsTable } from "./manuscriptReviewRuns";

// One row per stage/model invocation in a run. Canonical stage tokens are
// lowercase snake_case (Reader|Screening|Slop|Methods|Arbiter map to
// reader|screening_specialist|slop_specialist|methods_specialist|arbiter).
// Stage + status closed enums are enforced by CHECK in the migration.
export const manuscriptReviewAttemptsTable = pgTable(
  "manuscript_review_attempts",
  {
    attemptId: uuid("attempt_id").primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid("run_id")
      .notNull()
      .references(() => manuscriptReviewRunsTable.runId, {
        onDelete: "cascade",
      }),
    stage: text("stage").notNull(),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_mra_run").on(t.runId),
    index("idx_mra_stage").on(t.stage),
    index("idx_mra_status").on(t.status),
  ],
);

export type ManuscriptReviewAttempt =
  typeof manuscriptReviewAttemptsTable.$inferSelect;
export type InsertManuscriptReviewAttempt =
  typeof manuscriptReviewAttemptsTable.$inferInsert;
