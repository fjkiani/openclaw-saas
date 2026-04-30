import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { connectorsTable } from "./connectors";

export const tenantConnectorsTable = pgTable("tenant_connectors", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  connectorId: integer("connector_id")
    .notNull()
    .references(() => connectorsTable.id, { onDelete: "cascade" }),
  encryptedCredential: text("encrypted_credential").notNull(),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type TenantConnector = typeof tenantConnectorsTable.$inferSelect;
