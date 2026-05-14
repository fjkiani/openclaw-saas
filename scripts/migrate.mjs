#!/usr/bin/env node
/**
 * migrate.mjs — Create all OpenClaw DB tables using drizzle-orm push.
 * Run before starting the API server.
 * Uses DATABASE_URL env var (internal Render URL works here).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log("[migrate] No DATABASE_URL — skipping");
  process.exit(0);
}

console.log("[migrate] Connecting to database...");
const pool = new Pool({ connectionString: DATABASE_URL });

try {
  const client = await pool.connect();
  console.log("[migrate] Connected. Creating tables...");
  
  // Create all tables in dependency order
  await client.query(`
    CREATE TABLE IF NOT EXISTS "tenants" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "user_id" text NOT NULL,
      "plan" text DEFAULT 'free' NOT NULL,
      "stripe_customer_id" text,
      "stripe_subscription_id" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "skills" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "description" text NOT NULL,
      "category" text NOT NULL,
      "stars" integer DEFAULT 0 NOT NULL,
      "installs" integer DEFAULT 0 NOT NULL,
      "featured" boolean DEFAULT false NOT NULL,
      "tags" text[] DEFAULT '{}' NOT NULL,
      "source" text DEFAULT 'manual' NOT NULL,
      "current_version" integer DEFAULT 1 NOT NULL,
      "archon_run_id" text,
      "implementation" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "skill_benchmarks" (
      "id" serial PRIMARY KEY NOT NULL,
      "skill_id" integer NOT NULL REFERENCES "skills"("id"),
      "benchmark_id" text NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "overall_score" real,
      "level_scores" jsonb,
      "grade" text,
      "result_json" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "tenant_skills" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
      "skill_id" integer NOT NULL REFERENCES "skills"("id"),
      "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
      "enabled" boolean DEFAULT true NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "activity_entries" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
      "skill_id" integer REFERENCES "skills"("id"),
      "event_type" text NOT NULL,
      "payload" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "chat_messages" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
      "role" text NOT NULL,
      "content" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "connectors" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "description" text NOT NULL,
      "icon_url" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "tenant_connectors" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
      "connector_id" integer NOT NULL REFERENCES "connectors"("id"),
      "encrypted_credential" text,
      "verified" boolean DEFAULT false NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "knowledge_graphs" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
      "name" text NOT NULL,
      "description" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "graph_documents" (
      "id" serial PRIMARY KEY NOT NULL,
      "graph_id" integer NOT NULL REFERENCES "knowledge_graphs"("id"),
      "title" text NOT NULL,
      "content" text NOT NULL,
      "source_url" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "graph_chunks" (
      "id" serial PRIMARY KEY NOT NULL,
      "document_id" integer NOT NULL REFERENCES "graph_documents"("id"),
      "content" text NOT NULL,
      "embedding" real[],
      "metadata" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS "skill_versions" (
      "id" serial PRIMARY KEY NOT NULL,
      "skill_id" integer NOT NULL REFERENCES "skills"("id"),
      "version" integer NOT NULL,
      "implementation" text NOT NULL,
      "archon_run_id" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  
  client.release();
  console.log("[migrate] All tables created successfully.");
} catch (err) {
  console.error("[migrate] Error:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
