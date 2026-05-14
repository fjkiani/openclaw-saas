import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelDeploymentsTable } from "./modelDeployments";

export const deploymentEndpointsTable = pgTable("deployment_endpoints", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  deploymentId: integer("deployment_id")
    .notNull()
    .references(() => modelDeploymentsTable.id),
  path: text("path").notNull(),
  authRequired: boolean("auth_required").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DeploymentEndpoint = typeof deploymentEndpointsTable.$inferSelect;
export type InsertDeploymentEndpoint = typeof deploymentEndpointsTable.$inferInsert;
