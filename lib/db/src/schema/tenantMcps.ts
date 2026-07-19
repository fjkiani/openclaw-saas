/**
 * tenantMcps.ts — join table linking tenants to installed MCP servers.
 *
 * Multi-tenant install model: a tenant "installs" an MCP by inserting a row
 * with the mcp_id and the version they pinned. Uninstall is a hard delete.
 */
import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { mcpsTable } from "./mcps";

export const tenantMcpsTable = pgTable("tenant_mcps", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  mcpId: integer("mcp_id")
    .notNull()
    .references(() => mcpsTable.id, { onDelete: "cascade" }),
  pinnedVersion: integer("pinned_version").notNull().default(1),
  installState: text("install_state").notNull().default("installed"), // installed | disabled | pending
  installedAt: timestamp("installed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTenantMcpSchema = createInsertSchema(tenantMcpsTable).omit({
  id: true,
  installedAt: true,
});
export type InsertTenantMcp = z.infer<typeof insertTenantMcpSchema>;
export type TenantMcp = typeof tenantMcpsTable.$inferSelect;
