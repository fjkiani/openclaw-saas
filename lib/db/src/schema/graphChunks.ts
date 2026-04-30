import { pgTable, serial, integer, text, customType, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { graphDocumentsTable } from "./graphDocuments";

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const graphChunksTable = pgTable(
  "graph_chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => graphDocumentsTable.id, { onDelete: "cascade" }),
    graphId: integer("graph_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', content)`,
    ),
  },
  (table) => [index("graph_chunks_tsv_idx").using("gin", table.tsv)],
);

export type GraphChunk = typeof graphChunksTable.$inferSelect;
