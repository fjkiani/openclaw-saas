import {
  pgTable,
  text,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";

export const modelWorkspacesTable = pgTable("model_workspaces", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelWorkspace = typeof modelWorkspacesTable.$inferSelect;
export type InsertModelWorkspace = typeof modelWorkspacesTable.$inferInsert;
