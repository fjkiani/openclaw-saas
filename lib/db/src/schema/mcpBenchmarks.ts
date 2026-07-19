/**
 * mcpBenchmarks.ts — Governance validator + trust scores per MCP run.
 *
 * The gate has 4 dimensions (levels), mirroring skills L0-L4:
 *   L0 — Manifest sanity (entrypoint reachable, transport declared)
 *   L1 — Tool schema conformance (declared_tools == advertised_tools)
 *   L2 — Privilege honesty (declared_privileges >= observed_privileges)
 *   L3 — Adversarial harness (governance_traps corpus vs the MCP)
 *   L4 — Human-in-loop reviewer sign-off
 */
import {
  pgTable,
  text,
  serial,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { mcpsTable } from "./mcps";

export const mcpBenchmarksTable = pgTable("mcp_benchmarks", {
  id: serial("id").primaryKey(),
  mcpId: integer("mcp_id")
    .notNull()
    .references(() => mcpsTable.id, { onDelete: "cascade" }),
  benchmarkId: text("benchmark_id").notNull(),
  grade: text("grade"), // CERTIFIED | CONDITIONAL | FAILED | INCONCLUSIVE
  overallScore: integer("overall_score"),
  levelScores: jsonb("level_scores"), // {l0: {pass:bool, notes:...}, l1: ..., l2: ..., l3: ..., l4: ...}
  observedTools: jsonb("observed_tools"),
  observedPrivileges: jsonb("observed_privileges"),
  adversarialResults: jsonb("adversarial_results"),
  testSuite: text("test_suite").notNull().default("standard"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
  error: text("error"),
});

export type McpBenchmark = typeof mcpBenchmarksTable.$inferSelect;
export type InsertMcpBenchmark = typeof mcpBenchmarksTable.$inferInsert;
