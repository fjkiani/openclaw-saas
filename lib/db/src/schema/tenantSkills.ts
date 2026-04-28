import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { skillsTable } from "./skills";

export const tenantSkillsTable = pgTable("tenant_skills", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  skillId: integer("skill_id")
    .notNull()
    .references(() => skillsTable.id, { onDelete: "cascade" }),
  installedAt: timestamp("installed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTenantSkillSchema = createInsertSchema(
  tenantSkillsTable,
).omit({ id: true, installedAt: true });
export type InsertTenantSkill = z.infer<typeof insertTenantSkillSchema>;
export type TenantSkill = typeof tenantSkillsTable.$inferSelect;
