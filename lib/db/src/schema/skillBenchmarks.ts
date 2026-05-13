import {
  pgTable,
  text,
  serial,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { skillsTable } from "./skills";

export const skillBenchmarksTable = pgTable("skill_benchmarks", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id")
    .notNull()
    .references(() => skillsTable.id, { onDelete: "cascade" }),
  benchmarkId: text("benchmark_id").notNull(),
  grade: text("grade"),  // CERTIFIED | CONDITIONAL | FAILED | INCONCLUSIVE
  overallScore: integer("overall_score"),
  levelScores: jsonb("level_scores"),
  llmResults: jsonb("llm_results"),
  testSuite: text("test_suite").notNull().default("standard"),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
  error: text("error"),
});

export type SkillBenchmark = typeof skillBenchmarksTable.$inferSelect;
