import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const activityEntriesTable = pgTable("activity_entries", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertActivityEntrySchema = createInsertSchema(
  activityEntriesTable,
).omit({ id: true, createdAt: true });
export type InsertActivityEntry = z.infer<typeof insertActivityEntrySchema>;
export type ActivityEntry = typeof activityEntriesTable.$inferSelect;
