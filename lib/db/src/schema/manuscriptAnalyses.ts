import {
  pgTable,
  uuid,
  text,
  jsonb,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manuscriptReviewRunsTable } from "./manuscriptReviewRuns";
import { manuscriptSubmissionsTable } from "./manuscriptSubmissions";

// One row per produced analysis (valid results only), mirroring the legal
// semanticClauseAnalyses pattern. Stage closed enum enforced by CHECK.
export const manuscriptAnalysesTable = pgTable(
  "manuscript_analyses",
  {
    analysisId: uuid("analysis_id").primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid("run_id")
      .notNull()
      .references(() => manuscriptReviewRunsTable.runId, {
        onDelete: "cascade",
      }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => manuscriptSubmissionsTable.submissionId, {
        onDelete: "cascade",
      }),
    stage: text("stage").notNull(),
    verdict: text("verdict").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    scopeFit: text("scope_fit"),
    findingsJson: jsonb("findings_json").notNull().default([]),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    rawResponse: text("raw_response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_ma_run").on(t.runId),
    index("idx_ma_submission").on(t.submissionId),
    index("idx_ma_stage").on(t.stage),
  ],
);

export type ManuscriptAnalysis = typeof manuscriptAnalysesTable.$inferSelect;
export type InsertManuscriptAnalysis =
  typeof manuscriptAnalysesTable.$inferInsert;
