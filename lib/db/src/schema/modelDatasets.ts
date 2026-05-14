import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelWorkspacesTable } from "./modelWorkspaces";

export const modelDatasetsTable = pgTable("model_datasets", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => modelWorkspacesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  sourceType: text("source_type").notNull(),
  sensitivity: text("sensitivity").notNull().default("internal"),
  status: text("status").notNull().default("pending"),
  documentCount: integer("document_count").notNull().default(0),
  totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelDataset = typeof modelDatasetsTable.$inferSelect;
export type InsertModelDataset = typeof modelDatasetsTable.$inferInsert;
