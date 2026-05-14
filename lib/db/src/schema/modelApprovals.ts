import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { modelVersionsTable } from "./modelVersions";

export const modelApprovalsTable = pgTable("model_approvals", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  versionId: integer("version_id")
    .notNull()
    .references(() => modelVersionsTable.id),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModelApproval = typeof modelApprovalsTable.$inferSelect;
export type InsertModelApproval = typeof modelApprovalsTable.$inferInsert;
