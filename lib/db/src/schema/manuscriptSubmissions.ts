import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { modelWorkspacesTable } from "./modelWorkspaces";

// One row per submitted manuscript (adapter #1).
export const manuscriptSubmissionsTable = pgTable(
  "manuscript_submissions",
  {
    submissionId: uuid("submission_id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text("tenant_id").notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => modelWorkspacesTable.id),
    title: text("title").notNull(),
    // CHECK in migration: 'text' | 'pdf' | 'latex' | 'docx'
    sourceType: text("source_type").notNull(),
    rawText: text("raw_text"),
    pdfStorageKey: text("pdf_storage_key"),
    factSheetJson: jsonb("fact_sheet_json").notNull().default({}),
    status: text("status").notNull().default("received"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_ms_tenant").on(t.tenantId),
    index("idx_ms_workspace").on(t.workspaceId),
    index("idx_ms_status").on(t.status),
  ],
);

export type ManuscriptSubmission =
  typeof manuscriptSubmissionsTable.$inferSelect;
export type InsertManuscriptSubmission =
  typeof manuscriptSubmissionsTable.$inferInsert;
