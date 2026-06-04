import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { runSeed } from "./seed";
import { startForgeScheduler, stopForgeScheduler } from "./lib/forgeScheduler";

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

// Run DB migrations on startup (idempotent CREATE TABLE IF NOT EXISTS).
// Schema matches Drizzle ORM definitions in lib/db/src/schema/*.ts exactly.
async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    logger.info("Running DB migrations...");

    // ── Core tables ───────────────────────────────────────────────────────────

    // tenants: id TEXT (matches onboarding.ts which inserts tenant-<userId> strings).
    // NOTE: The Drizzle ORM schema uses serial, but the actual data layer uses text IDs.
    // The raw SQL in onboarding.ts is the source of truth for tenant creation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenants" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "status" text NOT NULL DEFAULT 'stopped',
        "skill_pack" text,
        "agent_count" integer NOT NULL DEFAULT 1,
        "memory_used_kb" integer NOT NULL DEFAULT 0,
        "ws_endpoint" text,
        "gateway_token" text,
        "render_service_id" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // Idempotent column additions for tenants
    await client.query(`
      ALTER TABLE "tenants"
        ADD COLUMN IF NOT EXISTS "description" text,
        ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'stopped',
        ADD COLUMN IF NOT EXISTS "skill_pack" text,
        ADD COLUMN IF NOT EXISTS "agent_count" integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "memory_used_kb" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "ws_endpoint" text,
        ADD COLUMN IF NOT EXISTS "gateway_token" text,
        ADD COLUMN IF NOT EXISTS "render_service_id" text,
        ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "skills" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "description" text NOT NULL,
        "category" text NOT NULL,
        "stars" integer NOT NULL DEFAULT 0,
        "installs" integer NOT NULL DEFAULT 0,
        "featured" boolean NOT NULL DEFAULT false,
        "tags" text[] NOT NULL DEFAULT '{}',
        "source" text NOT NULL DEFAULT 'manual',
        "current_version" integer NOT NULL DEFAULT 1,
        "archon_run_id" text,
        "implementation" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "skill_benchmarks" (
        "id" serial PRIMARY KEY NOT NULL,
        "skill_id" integer NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
        "benchmark_id" text NOT NULL,
        "grade" text,
        "overall_score" integer,
        "level_scores" jsonb,
        "llm_results" jsonb,
        "test_suite" text NOT NULL DEFAULT 'standard',
        "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
        "duration_ms" integer,
        "error" text
      )
    `);

    // Idempotent column additions for skill_benchmarks (old schema had different columns)
    await client.query(`
      ALTER TABLE "skill_benchmarks"
        ADD COLUMN IF NOT EXISTS "grade" text,
        ADD COLUMN IF NOT EXISTS "overall_score" integer,
        ADD COLUMN IF NOT EXISTS "level_scores" jsonb,
        ADD COLUMN IF NOT EXISTS "llm_results" jsonb,
        ADD COLUMN IF NOT EXISTS "test_suite" text NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "duration_ms" integer,
        ADD COLUMN IF NOT EXISTS "error" text
    `);

    // tenant_skills: tenant_id integer (matches Drizzle schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenant_skills" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "skill_id" integer NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
        "installed_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // activity_entries: uses "type" and "message" columns (matches Drizzle schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "activity_entries" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "type" text NOT NULL,
        "message" text NOT NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // Idempotent column additions for activity_entries (old schema had event_type/payload)
    await client.query(`
      ALTER TABLE "activity_entries"
        ADD COLUMN IF NOT EXISTS "type" text,
        ADD COLUMN IF NOT EXISTS "message" text
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "chat_messages" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "role" text NOT NULL,
        "content" text NOT NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "connectors" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "slug" text NOT NULL UNIQUE,
        "description" text NOT NULL,
        "icon_url" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenant_connectors" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "connector_id" integer NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
        "encrypted_credential" text,
        "verified" boolean NOT NULL DEFAULT false,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "knowledge_graphs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "description" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "graph_documents" (
        "id" serial PRIMARY KEY NOT NULL,
        "graph_id" integer NOT NULL REFERENCES "knowledge_graphs"("id") ON DELETE CASCADE,
        "title" text NOT NULL,
        "content" text NOT NULL,
        "source_url" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "graph_chunks" (
        "id" serial PRIMARY KEY NOT NULL,
        "document_id" integer NOT NULL REFERENCES "graph_documents"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "embedding" real[],
        "metadata" jsonb,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "skill_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "skill_id" integer NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
        "version" integer NOT NULL,
        "implementation" text NOT NULL,
        "archon_run_id" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
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
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

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
        "sensitivity" text NOT NULL DEFAULT 'internal',
        "status" text NOT NULL DEFAULT 'pending',
        "document_count" integer NOT NULL DEFAULT 0,
        "total_bytes" bigint NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "dataset_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "dataset_id" integer NOT NULL REFERENCES "model_datasets"("id"),
        "version" integer NOT NULL,
        "checksum" text,
        "document_count" integer NOT NULL DEFAULT 0,
        "total_bytes" bigint NOT NULL DEFAULT 0,
        "notes" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
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
        "size_bytes" bigint NOT NULL DEFAULT 0,
        "checksum" text,
        "storage_key" text,
        "status" text NOT NULL DEFAULT 'pending',
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
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
        "hyperparams" jsonb NOT NULL DEFAULT '{}',
        "status" text NOT NULL DEFAULT 'draft',
        "kairos_run_id" text,
        "compute_backend" text NOT NULL DEFAULT 'stub',
        "reforge_suggested" boolean NOT NULL DEFAULT false,
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "training_job_artifacts" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "artifact_type" text NOT NULL,
        "storage_key" text,
        "size_bytes" bigint NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "evaluation_runs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "rubric_id" text,
        "status" text NOT NULL DEFAULT 'pending',
        "created_at" timestamptz NOT NULL DEFAULT now(),
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
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_registrations" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "workspace_id" integer NOT NULL REFERENCES "model_workspaces"("id"),
        "job_id" integer NOT NULL REFERENCES "training_jobs"("id"),
        "name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_versions" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "registration_id" integer NOT NULL REFERENCES "model_registrations"("id"),
        "version" integer NOT NULL,
        "status" text NOT NULL DEFAULT 'candidate',
        "approved_by" text,
        "approved_at" timestamptz,
        "notes" text,
        "artifact_key" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("registration_id", "version")
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_deployments" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "version_id" integer NOT NULL REFERENCES "model_versions"("id"),
        "endpoint_url" text,
        "status" text NOT NULL DEFAULT 'pending',
        "compute_backend" text NOT NULL DEFAULT 'stub',
        "deployed_at" timestamptz,
        "retired_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "deployment_endpoints" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "deployment_id" integer NOT NULL REFERENCES "model_deployments"("id"),
        "path" text NOT NULL,
        "auth_required" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now()
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
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "model_policies" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL UNIQUE,
        "allowed_base_models" text[] NOT NULL DEFAULT '{}',
        "max_dataset_bytes" bigint NOT NULL DEFAULT 104857600,
        "max_concurrent_jobs" integer NOT NULL DEFAULT 2,
        "deployment_requires_approval" boolean NOT NULL DEFAULT true,
        "budget_limit_usd" real,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
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
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ── ZIE Multi-Tenant Flywheel Tables ──────────────────────────────────────
    // The LLM-as-judge route (routes/judge.ts) reads zie_preference_pairs and
    // writes evaluation_runs / evaluation_metrics. Without these tables the judge
    // route 500s with "relation zie_preference_pairs does not exist". The column
    // set below is a SUPERSET reconciled against judge.ts: it SELECTs
    // id, domain, task_type, prompt_hash, chosen_response_json,
    // rejected_response_json, preference_source, judge_verified, tenant_id and
    // UPDATEs judge_verified / judge_score_chosen / judge_score_rejected /
    // judge_reasoning / judge_run_id. All must exist or the route fails again.

    await client.query(`
      CREATE TABLE IF NOT EXISTS "zie_router_policies" (
        "id" serial PRIMARY KEY NOT NULL,
        "task_type" text NOT NULL UNIQUE,
        "fast_model_id" text NOT NULL,
        "fast_provider" text NOT NULL DEFAULT 'openrouter',
        "premium_model_id" text,
        "confidence_threshold" real DEFAULT 0.85,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "zie_training_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "domain" text NOT NULL,
        "task_type" text NOT NULL,
        "source_kind" text NOT NULL,
        "quality_score" real,
        "prompt_hash" text UNIQUE,
        "prompt_json" jsonb,
        "remote_response_json" jsonb,
        "workspace_id" text,
        "tenant_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // zie_preference_pairs — judge.ts contract. prompt_hash, source_kind,
    // used_for_dpo and tenant_id are included because the deployed route reads
    // them (tenant_id is also the fallback source for evaluation_runs.tenant_id).
    await client.query(`
      CREATE TABLE IF NOT EXISTS "zie_preference_pairs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "domain" text NOT NULL,
        "task_type" text NOT NULL,
        "source_kind" text NOT NULL DEFAULT 'direct_call',
        "preference_source" text NOT NULL DEFAULT 'path_race',
        "prompt_hash" text,
        "chosen_response_json" jsonb NOT NULL,
        "rejected_response_json" jsonb NOT NULL,
        "used_for_dpo" boolean NOT NULL DEFAULT false,
        "judge_verified" boolean NOT NULL DEFAULT false,
        "judge_score_chosen" real,
        "judge_score_rejected" real,
        "judge_reasoning" text,
        "judge_run_id" integer,
        "tenant_id" text,
        "workspace_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Idempotent reconciliation: if an older zie_preference_pairs already exists
    // (e.g. a partial/legacy shape), make sure every column judge.ts touches is
    // present. ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.
    await client.query(`
      ALTER TABLE "zie_preference_pairs"
        ADD COLUMN IF NOT EXISTS "prompt_hash" text,
        ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'direct_call',
        ADD COLUMN IF NOT EXISTS "preference_source" text NOT NULL DEFAULT 'path_race',
        ADD COLUMN IF NOT EXISTS "used_for_dpo" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "judge_verified" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "judge_score_chosen" real,
        ADD COLUMN IF NOT EXISTS "judge_score_rejected" real,
        ADD COLUMN IF NOT EXISTS "judge_reasoning" text,
        ADD COLUMN IF NOT EXISTS "judge_run_id" integer,
        ADD COLUMN IF NOT EXISTS "tenant_id" text,
        ADD COLUMN IF NOT EXISTS "workspace_id" text
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "zie_model_promotion_gates" (
        "id" serial PRIMARY KEY NOT NULL,
        "domain" text NOT NULL,
        "task_type" text NOT NULL,
        "candidate_model_id" text NOT NULL,
        "baseline_model_id" text NOT NULL,
        "eval_score" real,
        "promoted" boolean NOT NULL DEFAULT false,
        "promotion_date" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS "idx_zie_preference_domain" ON "zie_preference_pairs"("domain")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "idx_zie_preference_verified" ON "zie_preference_pairs"("judge_verified")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "idx_zie_training_domain" ON "zie_training_records"("domain", "task_type")`);

    // ── Minimal eval-table reconciliation so the judge can WRITE ───────────────
    // judge.ts writes evaluation_runs(domain, task_type) + evaluation_metrics(
    // metric_value). The bootstrap above created the forge shape (job_id NOT NULL
    // / rubric_id, and value/threshold/passed). Per the deferred eval-schema
    // decision we do NOT remove the forge columns — we only ADD the judge's
    // columns and relax job_id so the judge INSERT can succeed. Forge code keeps
    // working against its columns; judge writes its own. Full unification of these
    // tables is tracked separately and intentionally not done here.
    await client.query(`ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "domain" text`);
    await client.query(`ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "task_type" text`);
    await client.query(`ALTER TABLE "evaluation_runs" ALTER COLUMN "job_id" DROP NOT NULL`);
    await client.query(`ALTER TABLE "evaluation_metrics" ADD COLUMN IF NOT EXISTS "metric_value" real`);
    await client.query(`ALTER TABLE "evaluation_metrics" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb`);
    // value is NOT NULL in the forge shape; the judge does not write it. Relax it
    // so a judge-only INSERT (which omits value) does not violate the constraint.
    await client.query(`ALTER TABLE "evaluation_metrics" ALTER COLUMN "value" DROP NOT NULL`);

    // ── Seed default router policies (idempotent) ──────────────────────────────
    await client.query(`
      INSERT INTO "zie_router_policies" ("task_type", "fast_model_id", "fast_provider")
      VALUES
        ('legal_clause_analysis', 'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
        ('manuscript_slop_check', 'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
        ('seo_content_audit',     'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter')
      ON CONFLICT ("task_type") DO NOTHING
    `);

    logger.info("DB migrations complete.");
  } finally {
    client.release();
  }
}

// Start server immediately, run migrations + seed in background (soft-fail).
// This ensures the server starts and serves /healthz even if the DB is temporarily
// unreachable (e.g., cold start, network delay, or DB not yet provisioned).
app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");

  // Run migrations + seed after server is up (non-blocking)
  runMigrations()
    .then(() => runSeed())
    .then(() => {
      logger.info("DB migrations and seed complete.");
      // Start the pg-boss forge scheduler after DB is confirmed live
      return startForgeScheduler();
    })
    .then(() => {
      logger.info("Forge scheduler started.");
    })
    .catch((err) => {
      // Soft-fail: log the error but do NOT crash the server.
      logger.error({ err }, "DB migrations/seed/scheduler failed — server continues.");
    });

  // Graceful shutdown — stop pg-boss before process exits
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal — stopping forge scheduler");
    await stopForgeScheduler().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
});
