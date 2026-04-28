import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
