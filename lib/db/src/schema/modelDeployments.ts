import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelVersionsTable } from "./modelVersions";

export const modelDeploymentsTable = pgTable("model_deployments", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  versionId: integer("version_id")
    .notNull()
    .references(() => modelVersionsTable.id),
  endpointUrl: text("endpoint_url"),
  status: text("status").notNull().default("pending"),
  computeBackend: text("compute_backend").notNull().default("stub"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelDeployment = typeof modelDeploymentsTable.$inferSelect;
export type InsertModelDeployment = typeof modelDeploymentsTable.$inferInsert;
