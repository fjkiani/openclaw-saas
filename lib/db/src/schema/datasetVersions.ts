import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { modelDatasetsTable } from "./modelDatasets";

export const datasetVersionsTable = pgTable(
  "dataset_versions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    datasetId: integer("dataset_id")
      .notNull()
      .references(() => modelDatasetsTable.id),
    version: integer("version").notNull(),
    checksum: text("checksum"),
    documentCount: integer("document_count").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.datasetId, t.version)],
);

export type DatasetVersion = typeof datasetVersionsTable.$inferSelect;
export type InsertDatasetVersion = typeof datasetVersionsTable.$inferInsert;
