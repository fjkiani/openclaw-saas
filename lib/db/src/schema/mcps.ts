/**
 * mcps.ts — MCP (Model Context Protocol) registry.
 *
 * Mirrors the skills table shape (slug, name, description, category, stars,
 * installs, tags, currentVersion) but is scoped to MCP *servers* rather than
 * in-process TypeScript skills.
 *
 * Every row here is an MCP server the platform knows how to install into a
 * tenant. Tenants pull from this registry via tenant_mcps join.
 *
 * Design note: the same skill contract → validator → benchmark flow is
 * mirrored for MCPs (see mcpVersions.ts, mcpBenchmarks.ts) so a single
 * governance envelope covers both surfaces.
 */
import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mcpsTable = pgTable("mcps", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull(),
  category: text("category").notNull(), // dev-tools | data | agent-ops | infra | vertical
  vendor: text("vendor"), // anthropic | community | third-party | verified
  stars: integer("stars").notNull().default(0),
  installs: integer("installs").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  tags: text("tags").array().notNull().default([]),
  // Transport + entrypoint
  transport: text("transport").notNull().default("stdio"), // stdio | http | sse | websocket
  entrypoint: text("entrypoint").notNull(), // package name, container image, or URL
  entrypointType: text("entrypoint_type").notNull().default("npm"), // npm | pip | container | http
  // Declared tool surface (list of {name, description, input_schema})
  declaredTools: jsonb("declared_tools").notNull().default([]),
  // Declared privilege classes: {net: [...], fs: [...], env: [...]}
  declaredPrivileges: jsonb("declared_privileges").notNull().default({}),
  // Governance
  currentVersion: integer("current_version").notNull().default(1),
  gateStatus: text("gate_status").notNull().default("pending"), // pending | passed | failed | conditional
  gateReport: jsonb("gate_report"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertMcpSchema = createInsertSchema(mcpsTable).omit({
  id: true,
  stars: true,
  installs: true,
  currentVersion: true,
  gateStatus: true,
  gateReport: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMcp = z.infer<typeof insertMcpSchema>;
export type Mcp = typeof mcpsTable.$inferSelect;
