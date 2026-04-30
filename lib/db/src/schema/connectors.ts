import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const connectorsTable = pgTable("connectors", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  authType: text("auth_type").notNull().default("api_key"),
  credentialLabel: text("credential_label").notNull().default("API Key"),
  category: text("category").notNull().default("data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Connector = typeof connectorsTable.$inferSelect;
