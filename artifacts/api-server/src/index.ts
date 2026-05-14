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

    // ── Model Forge tables ────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_workspaces" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "domain" text NOT NULL DEFAULT '',
        "description" text,
        "status" text DEFAULT 'active' NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    // Backfill: set default on domain column for existing rows/schema
    await client.query(`
      ALTER TABLE "model_workspaces"
        ALTER COLUMN "domain" SET DEFAULT ''
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_datasets" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "workspace_id" integer NOT NULL REFERENCES "model_workspaces"("id"),
        "name" text NOT NULL,
        "description" text,
        "source_type" text NOT NULL,
        "sensitivity" text DEFAULT 'internal' NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "document_count" integer DEFAULT 0 NOT NULL,
        "total_bytes" bigint DEFAULT 0 NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        "updated_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "dataset_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "dataset_id" integer NOT NULL REFERENCES "model_datasets"("id"),
        "version" integer NOT NULL,
        "checksum" text,
        "document_count" integer DEFAULT 0 NOT NULL,
        "total_bytes" bigint DEFAULT 0 NOT NULL,
        "notes" text,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        UNIQUE ("dataset_id", "version")
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "dataset_documents" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "dataset_id" integer NOT NULL REFERENCES "model_datasets"("id"),
        "version_id" integer REFERENCES "dataset_versions"("id"),
        "filename" text NOT NULL,
        "source_url" text,
        "mime_type" text,
        "size_bytes" bigint DEFAULT 0 NOT NULL,
        "checksum" text,
        "storage_key" text,
        "status" text DEFAULT 'pending' NOT NULL,
        "error" text,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "training_jobs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "workspace_id" integer NOT NULL REFERENCES "model_workspaces"("id"),
        "dataset_id" integer NOT NULL REFERENCES "model_datasets"("id"),
        "dataset_version_id" integer NOT NULL REFERENCES "dataset_versions"("id"),
        "name" text NOT NULL,
        "mode" text NOT NULL,
        "base_model" text NOT NULL,
        "hyperparams" jsonb DEFAULT '{}' NOT NULL,
        "status" text DEFAULT 'draft' NOT NULL,
        "kairos_run_id" text,
        "compute_backend" text DEFAULT 'stub' NOT NULL,
        "reforge_suggested" boolean DEFAULT false NOT NULL,
        "error" text,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        "updated_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "training_job_artifacts" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "artifact_type" text NOT NULL,
        "storage_key" text,
        "size_bytes" bigint DEFAULT 0 NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "evaluation_runs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "rubric_id" text,
        "status" text DEFAULT 'pending' NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        "completed_at" timestamptz
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "evaluation_metrics" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "eval_run_id" integer NOT NULL REFERENCES "evaluation_runs"("id"),
        "metric_name" text NOT NULL,
        "value" real NOT NULL,
        "threshold" real,
        "passed" boolean,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_registrations" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "workspace_id" integer NOT NULL REFERENCES "model_workspaces"("id"),
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "name" text NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "registration_id" integer NOT NULL REFERENCES "model_registrations"("id"),
        "version" integer NOT NULL,
        "status" text DEFAULT 'candidate' NOT NULL,
        "approved_by" text,
        "approved_at" timestamptz,
        "notes" text,
        "artifact_key" text,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        UNIQUE ("registration_id", "version")
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_deployments" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "version_id" integer NOT NULL REFERENCES "model_versions"("id"),
        "endpoint_url" text,
        "status" text DEFAULT 'pending' NOT NULL,
        "compute_backend" text DEFAULT 'stub' NOT NULL,
        "deployed_at" timestamptz,
        "retired_at" timestamptz,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "deployment_endpoints" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "deployment_id" integer NOT NULL REFERENCES "model_deployments"("id"),
        "path" text NOT NULL,
        "auth_required" boolean DEFAULT true NOT NULL,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_usage_events" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "deployment_id" integer REFERENCES "model_deployments"("id"),
        "job_id" integer REFERENCES "training_jobs"("id"),
        "event_type" text NOT NULL,
        "input_tokens" integer,
        "output_tokens" integer,
        "cost_usd" real,
        "metadata" jsonb,
        "created_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_policies" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL UNIQUE,
        "allowed_base_models" text[] DEFAULT '{}' NOT NULL,
        "max_dataset_bytes" bigint DEFAULT 104857600 NOT NULL,
        "max_concurrent_jobs" integer DEFAULT 2 NOT NULL,
        "deployment_requires_approval" boolean DEFAULT true NOT NULL,
        "budget_limit_usd" real,
        "created_at" timestamptz DEFAULT now() NOT NULL,
        "updated_at" timestamptz DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_approvals" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "version_id" integer NOT NULL REFERENCES "model_versions"("id"),
        "action" text NOT NULL,
        "actor_id" text NOT NULL,
        "reason" text,
        "created_at" timestamptz DEFAULT now() NOT NULL
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
