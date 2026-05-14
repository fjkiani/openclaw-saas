import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { runSeed } from "./seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Run DB migrations on startup (idempotent CREATE TABLE IF NOT EXISTS)
async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    logger.info("Running DB migrations...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenants" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "user_id" text NOT NULL,
        "plan" text DEFAULT 'free' NOT NULL,
        "stripe_customer_id" text,
        "stripe_subscription_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
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
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "skill_benchmarks" (
        "id" serial PRIMARY KEY NOT NULL,
        "skill_id" integer NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
        "benchmark_id" text NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "overall_score" real,
        "level_scores" jsonb,
        "grade" text,
        "result_json" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    // Add columns required by Drizzle ORM schema (idempotent via ADD COLUMN IF NOT EXISTS)
    await client.query(`
      ALTER TABLE "skill_benchmarks"
        ADD COLUMN IF NOT EXISTS "ran_at" timestamp with time zone DEFAULT now() NOT NULL,
        ADD COLUMN IF NOT EXISTS "test_suite" text NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS "llm_results" jsonb,
        ADD COLUMN IF NOT EXISTS "duration_ms" integer,
        ADD COLUMN IF NOT EXISTS "error" text
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenant_skills" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
        "skill_id" integer NOT NULL REFERENCES "skills"("id"),
        "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
        "enabled" boolean DEFAULT true NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "activity_entries" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
        "skill_id" integer REFERENCES "skills"("id"),
        "event_type" text NOT NULL,
        "payload" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "chat_messages" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
        "role" text NOT NULL,
        "content" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "connectors" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "description" text NOT NULL,
        "icon_url" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenant_connectors" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
        "connector_id" integer NOT NULL REFERENCES "connectors"("id"),
        "encrypted_credential" text,
        "verified" boolean DEFAULT false NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "knowledge_graphs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
        "name" text NOT NULL,
        "description" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "graph_documents" (
        "id" serial PRIMARY KEY NOT NULL,
        "graph_id" integer NOT NULL REFERENCES "knowledge_graphs"("id"),
        "title" text NOT NULL,
        "content" text NOT NULL,
        "source_url" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "graph_chunks" (
        "id" serial PRIMARY KEY NOT NULL,
        "document_id" integer NOT NULL REFERENCES "graph_documents"("id"),
        "content" text NOT NULL,
        "embedding" real[],
        "metadata" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "skill_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "skill_id" integer NOT NULL REFERENCES "skills"("id"),
        "version" integer NOT NULL,
        "implementation" text NOT NULL,
        "archon_run_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    logger.info("DB migrations complete.");
  } finally {
    client.release();
  }
}

// Run migrations + seed, then start server
runMigrations()
  .then(() => runSeed())
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Startup failed — aborting");
    process.exit(1);
  });
