import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  real,
  bigint,
  timestamp,
} from "drizzle-orm/pg-core";

export const modelPoliciesTable = pgTable("model_policies", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().unique(),
  allowedBaseModels: text("allowed_base_models").array().notNull().default([]),
  maxDatasetBytes: bigint("max_dataset_bytes", { mode: "number" })
    .notNull()
    .default(104857600),
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(2),
  deploymentRequiresApproval: boolean("deployment_requires_approval")
    .notNull()
    .default(true),
  budgetLimitUsd: real("budget_limit_usd"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelPolicy = typeof modelPoliciesTable.$inferSelect;
export type InsertModelPolicy = typeof modelPoliciesTable.$inferInsert;
