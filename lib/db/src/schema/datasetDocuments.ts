import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelDatasetsTable } from "./modelDatasets";
import { datasetVersionsTable } from "./datasetVersions";

export const datasetDocumentsTable = pgTable("dataset_documents", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  datasetId: integer("dataset_id")
    .notNull()
    .references(() => modelDatasetsTable.id),
  versionId: integer("version_id").references(() => datasetVersionsTable.id),
  filename: text("filename").notNull(),
  sourceUrl: text("source_url"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  checksum: text("checksum"),
  storageKey: text("storage_key"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DatasetDocument = typeof datasetDocumentsTable.$inferSelect;
export type InsertDatasetDocument = typeof datasetDocumentsTable.$inferInsert;
