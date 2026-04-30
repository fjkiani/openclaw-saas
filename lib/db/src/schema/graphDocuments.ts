import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { knowledgeGraphsTable } from "./knowledgeGraphs";

export const graphDocumentsTable = pgTable("graph_documents", {
  id: serial("id").primaryKey(),
  graphId: integer("graph_id")
    .notNull()
    .references(() => knowledgeGraphsTable.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull().default("application/pdf"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  status: text("status").notNull().default("processing"),
  chunkCount: integer("chunk_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type GraphDocument = typeof graphDocumentsTable.$inferSelect;
