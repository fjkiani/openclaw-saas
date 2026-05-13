import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const skillsTable = pgTable("skills", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  stars: integer("stars").notNull().default(0),
  installs: integer("installs").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  tags: text("tags").array().notNull().default([]),
  // Archon skill factory fields
  source: text("source").notNull().default("manual"), // 'archon' | 'manual' | 'github'
  currentVersion: integer("current_version").notNull().default(1),
  archonRunId: text("archon_run_id"),
  implementation: text("implementation"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSkillSchema = createInsertSchema(skillsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skillsTable.$inferSelect;
