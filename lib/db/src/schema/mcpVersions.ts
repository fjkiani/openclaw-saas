/**
 * mcpVersions.ts — Every MCP registration lands as a new version row.
 *
 * Mirrors skillVersions. When an MCP is re-submitted (bumped semver or
 * corrected entrypoint), a new version is stored and mcps.currentVersion
 * points at the active row.
 *
 * Governance decisions (gate pass/fail) are stored per-version so a rollback
 * is meaningful.
 */
import {
  pgTable,
  text,
  serial,
  integer,
  real,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { mcpsTable } from "./mcps";

export const mcpVersionsTable = pgTable("mcp_versions", {
  id: serial("id").primaryKey(),
  mcpId: integer("mcp_id")
    .notNull()
    .references(() => mcpsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  semver: text("semver"), // e.g. "1.2.3"
  entrypoint: text("entrypoint").notNull(),
  declaredTools: jsonb("declared_tools").notNull().default([]),
  declaredPrivileges: jsonb("declared_privileges").notNull().default({}),
  // Validator outputs
  gateGrade: text("gate_grade"), // CERTIFIED | CONDITIONAL | FAILED | INCONCLUSIVE
  gateScore: real("gate_score"),
  gateReport: jsonb("gate_report"),
  // Provenance
  submittedBy: text("submitted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type McpVersion = typeof mcpVersionsTable.$inferSelect;
export type InsertMcpVersion = typeof mcpVersionsTable.$inferInsert;
