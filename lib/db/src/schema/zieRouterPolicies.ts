import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Local/remote routing config per (domain, task_type). NULL tenant => global default.
// A partial UNIQUE INDEX (uq_zrp_active_scope) enforces one active policy per scope;
// it is defined in the migration because Drizzle cannot express the COALESCE(...) key.
export const zieRouterPoliciesTable = pgTable("zie_router_policies", {
  policyId: uuid("policy_id").primaryKey().default(sql`gen_random_uuid()`),
  domain: text("domain").notNull(),
  taskType: text("task_type").notNull(),
  localModel: text("local_model").notNull(),
  remoteModel: text("remote_model").notNull(),
  confidenceThreshold: numeric("confidence_threshold", {
    precision: 5,
    scale: 4,
  })
    .notNull()
    .default("0.85"),
  shadowRate: numeric("shadow_rate", { precision: 5, scale: 4 })
    .notNull()
    .default("0.05"),
  active: boolean("active").notNull().default(true),
  tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ZieRouterPolicy = typeof zieRouterPoliciesTable.$inferSelect;
export type InsertZieRouterPolicy = typeof zieRouterPoliciesTable.$inferInsert;
