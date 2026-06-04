import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { modelWorkspacesTable } from "./modelWorkspaces";
import { manuscriptSubmissionsTable } from "./manuscriptSubmissions";

// One row per screening run over a submission. `escalated` records the hybrid
// local->remote handoff; `final_verdict` is set when the run completes.
export const manuscriptReviewRunsTable = pgTable(
  "manuscript_review_runs",
  {
    runId: uuid("run_id").primaryKey().default(sql`gen_random_uuid()`),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => manuscriptSubmissionsTable.submissionId, {
        onDelete: "cascade",
      }),
    tenantId: text("tenant_id").notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => modelWorkspacesTable.id),
    localModel: text("local_model").notNull(),
    remoteModel: text("remote_model"),
    escalated: boolean("escalated").notNull().default(false),
    finalVerdict: text("final_verdict"),
    finalConfidence: numeric("final_confidence", { precision: 5, scale: 4 }),
    status: text("status").notNull().default("running"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_mrr_submission").on(t.submissionId),
    index("idx_mrr_tenant").on(t.tenantId),
    index("idx_mrr_status").on(t.status),
    index("idx_mrr_escalated").on(t.escalated),
  ],
);

export type ManuscriptReviewRun =
  typeof manuscriptReviewRunsTable.$inferSelect;
export type InsertManuscriptReviewRun =
  typeof manuscriptReviewRunsTable.$inferInsert;
