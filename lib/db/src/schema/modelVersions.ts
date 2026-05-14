import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { modelRegistrationsTable } from "./modelRegistrations";

export const modelVersionsTable = pgTable(
  "model_versions",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    registrationId: integer("registration_id")
      .notNull()
      .references(() => modelRegistrationsTable.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("candidate"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    notes: text("notes"),
    artifactKey: text("artifact_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.registrationId, t.version)],
);

export type ModelVersion = typeof modelVersionsTable.$inferSelect;
export type InsertModelVersion = typeof modelVersionsTable.$inferInsert;
