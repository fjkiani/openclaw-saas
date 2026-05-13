import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
} from "drizzle-orm/pg-core";
import { skillsTable } from "./skills";

/**
 * skill_versions — tracks every Archon-generated version of a skill.
 * Each time a skill is re-forged from a new prompt, a new version row is created.
 * The skills table's currentVersion field points to the active version.
 */
export const skillVersionsTable = pgTable("skill_versions", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id")
    .notNull()
    .references(() => skillsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  archonPrompt: text("archon_prompt"),
  archonRunId: text("archon_run_id"),
  implementation: text("implementation"),
  benchmarkGrade: text("benchmark_grade"), // CERTIFIED | CONDITIONAL | FAILED | INCONCLUSIVE
  benchmarkScore: real("benchmark_score"),
  l0RetryCount: integer("l0_retry_count").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SkillVersion = typeof skillVersionsTable.$inferSelect;
export type InsertSkillVersion = typeof skillVersionsTable.$inferInsert;
