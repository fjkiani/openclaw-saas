import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { runSeed } from "./seed";
import { startForgeScheduler, stopForgeScheduler } from "./lib/forgeScheduler";
import { workflowEngine } from "./lib/workflowEngine.js";
import { registerAACRSkills } from "./lib/skills/aacr/index.js";
import { registerZOASkills } from "./lib/skills/zoa/index.js";
import { migrateLegalCorpus } from "./lib/legalCorpus/migrate.js";
import { createAdminRouter } from "./routes/admin.js";
import { intelligenceExtrasRouter } from "./routes/intelligenceExtras.js";
import { mcpTrainingRouter } from "./routes/mcpTraining.js";
import { backfillLegalCorpusEmbeddings } from "./lib/legalCorpus/backfillEmbeddings.js";
import { startArchonDaemon, stopArchonDaemon } from "./lib/archonDaemon.js";
import { startAutopilotDaemon, stopAutopilotDaemon } from "./lib/agent/autopilotDaemon.js";

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


// ── ZIE Migration (runs independently so main migration failures don't block it) ──
async function runZieMigration(): Promise<void> {
  const client = await pool.connect();
  try {
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
      "dataset_version_id" integer,
      "model_version_id" integer,
      "source_run_id" uuid,
      "source_analysis_ref" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Idempotent reconciliation for zie_training_records: the SEO factory adapter
  // (seoFactoryAdapter.persistSeoFlywheelData) INSERTs source_run_id,
  // source_analysis_ref and the dataset/model version FKs. A pre-existing
  // partial table (e.g. created before these columns existed) would make that
  // fire-and-forget INSERT throw "column does not exist", silently dropping the
  // training record AND blocking the dependent preference-pair insert.
  await client.query(`
    ALTER TABLE "zie_training_records"
      ADD COLUMN IF NOT EXISTS "prompt_json" jsonb,
      ADD COLUMN IF NOT EXISTS "remote_response_json" jsonb,
      ADD COLUMN IF NOT EXISTS "quality_score" real,
      ADD COLUMN IF NOT EXISTS "workspace_id" text,
      ADD COLUMN IF NOT EXISTS "tenant_id" text,
      ADD COLUMN IF NOT EXISTS "dataset_version_id" integer,
      ADD COLUMN IF NOT EXISTS "model_version_id" integer,
      ADD COLUMN IF NOT EXISTS "source_run_id" uuid,
      ADD COLUMN IF NOT EXISTS "source_analysis_ref" text,
      ADD COLUMN IF NOT EXISTS "used_for_sft" boolean NOT NULL DEFAULT false
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
      "chosen_training_record_id" uuid,
      "rejected_training_record_id" uuid,
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
      ADD COLUMN IF NOT EXISTS "workspace_id" text,
      ADD COLUMN IF NOT EXISTS "chosen_training_record_id" uuid,
      ADD COLUMN IF NOT EXISTS "rejected_training_record_id" uuid,
      ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()
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

  // ── 0016_agentic_loop: judge-then-repair, regression suite, archon triage ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_loop_runs" (
      "id" BIGSERIAL PRIMARY KEY,
      "mcp_slug" TEXT NOT NULL,
      "tool_name" TEXT NOT NULL,
      "prompt" TEXT NOT NULL,
      "prompt_hash" TEXT NOT NULL,
      "orig_model" TEXT,
      "orig_response" TEXT,
      "orig_score" NUMERIC,
      "repair_a_model" TEXT,
      "repair_a_response" TEXT,
      "repair_a_score" NUMERIC,
      "repair_b_model" TEXT,
      "repair_b_response" TEXT,
      "repair_b_score" NUMERIC,
      "winner" TEXT,
      "judge_reasoning" TEXT,
      "judge_version" TEXT,
      "judge_margin" NUMERIC,
      "pref_pair_id" UUID,
      "tenant_id" TEXT,
      "workspace_id" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_loop_runs_slug_tool" ON "zie_loop_runs" ("mcp_slug", "tool_name")`);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_loop_runs_created" ON "zie_loop_runs" ("created_at" DESC)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_loop_promotions" (
      "id" BIGSERIAL PRIMARY KEY,
      "loop_run_id" BIGINT NOT NULL REFERENCES "zie_loop_runs"("id") ON DELETE CASCADE,
      "promoted" BOOLEAN NOT NULL,
      "auto" BOOLEAN NOT NULL DEFAULT false,
      "gate_snapshot" JSONB NOT NULL,
      "promoted_by" TEXT,
      "reason" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_loop_promotions_run" ON "zie_loop_promotions" ("loop_run_id")`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_loop_settings" (
      "id" BIGSERIAL PRIMARY KEY,
      "mcp_slug" TEXT NOT NULL,
      "tool_name" TEXT NOT NULL,
      "auto_promote" BOOLEAN NOT NULL DEFAULT false,
      "min_margin" NUMERIC NOT NULL DEFAULT 0.6,
      "min_pairs_agree" INTEGER NOT NULL DEFAULT 25,
      "min_confidence" NUMERIC NOT NULL DEFAULT 0.7,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("mcp_slug", "tool_name")
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_regression_suite" (
      "id" BIGSERIAL PRIMARY KEY,
      "mcp_slug" TEXT NOT NULL,
      "tool_name" TEXT NOT NULL,
      "prompt" TEXT NOT NULL,
      "gold_response" TEXT,
      "rubric" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "category" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "source" TEXT DEFAULT 'yaml',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_reg_suite_slug_tool" ON "zie_regression_suite" ("mcp_slug", "tool_name")`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_regression_runs" (
      "id" BIGSERIAL PRIMARY KEY,
      "suite_id" BIGINT NOT NULL REFERENCES "zie_regression_suite"("id") ON DELETE CASCADE,
      "adapter_id" TEXT,
      "baseline_id" TEXT,
      "pass" BOOLEAN NOT NULL,
      "score" NUMERIC,
      "actual_response" TEXT,
      "reasoning" TEXT,
      "ran_at" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_reg_runs_adapter" ON "zie_regression_runs" ("adapter_id")`);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_reg_runs_suite" ON "zie_regression_runs" ("suite_id")`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_archon_triage" (
      "id" BIGSERIAL PRIMARY KEY,
      "mcp_slug" TEXT NOT NULL,
      "tool_name" TEXT,
      "action" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "dispatched_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "result_ref" TEXT,
      "status" TEXT NOT NULL DEFAULT 'dispatched'
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_archon_slug" ON "zie_archon_triage" ("mcp_slug", "dispatched_at" DESC)`);

  // ── 0017_agent_executor: generic agentic task executor (Agent Console + Autopilot) ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_agent_runs" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "goal" TEXT NOT NULL,
      "mode" TEXT NOT NULL DEFAULT 'console',
      "mcp_slug" TEXT,
      "tool_name" TEXT,
      "status" TEXT NOT NULL DEFAULT 'planning',
      "plan" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "current_step" INTEGER NOT NULL DEFAULT 0,
      "replans" INTEGER NOT NULL DEFAULT 0,
      "planner" TEXT,
      "summary" TEXT,
      "error" TEXT,
      "created_by" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "completed_at" TIMESTAMPTZ
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_agent_runs_created" ON "zie_agent_runs" ("created_at" DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_agent_runs_slug" ON "zie_agent_runs" ("mcp_slug", "created_at" DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_agent_runs_mode_status" ON "zie_agent_runs" ("mode", "status")`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_agent_steps" (
      "id" BIGSERIAL PRIMARY KEY,
      "run_id" UUID NOT NULL REFERENCES "zie_agent_runs"("id") ON DELETE CASCADE,
      "idx" INTEGER NOT NULL,
      "action_type" TEXT NOT NULL,
      "args" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "rationale" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "requires_approval" BOOLEAN NOT NULL DEFAULT false,
      "approved" BOOLEAN,
      "approved_by" TEXT,
      "result" JSONB,
      "error" TEXT,
      "started_at" TIMESTAMPTZ,
      "ended_at" TIMESTAMPTZ
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_agent_steps_run_idx" ON "zie_agent_steps" ("run_id", "idx")`);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_agent_steps_status" ON "zie_agent_steps" ("status")`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "zie_autopilot_settings" (
      "id" BIGSERIAL PRIMARY KEY,
      "mcp_slug" TEXT NOT NULL,
      "tool_name" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT false,
      "last_run_id" UUID,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE ("mcp_slug", "tool_name")
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS "idx_autopilot_enabled" ON "zie_autopilot_settings" ("enabled")`);

  // ── Minimal eval-table reconciliation so the judge can WRITE ───────────────
  // judge.ts writes evaluation_runs(domain, task_type) + evaluation_metrics(
  // metric_value). The bootstrap above created the forge shape (job_id NOT NULL
  // / rubric_id, and value/threshold/passed). Per the deferred eval-schema
  // decision we do NOT remove the forge columns — we only ADD the judge's
  // columns and relax job_id so the judge INSERT can succeed. Forge code keeps
  // working against its columns; judge writes its own. Full unification of these
  // tables is tracked separately and intentionally not done here.
  // Ensure evaluation_runs and evaluation_metrics exist (may not if main migration failed)
  await client.query(`
    CREATE TABLE IF NOT EXISTS "evaluation_runs" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL,
      "job_id" integer,
      "status" text NOT NULL DEFAULT 'pending',
      "started_at" timestamptz,
      "completed_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "evaluation_metrics" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL,
      "eval_run_id" integer NOT NULL REFERENCES "evaluation_runs"("id"),
      "metric_name" text NOT NULL,
      "value" real,
      "threshold" real,
      "passed" boolean,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Idempotent reconciliation for evaluation_runs/metrics (soft-fail if already correct)
  try {
    await client.query(`ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "domain" text`);
    await client.query(`ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "task_type" text`);
    await client.query(`ALTER TABLE "evaluation_runs" ADD COLUMN IF NOT EXISTS "rubric_id" text`);
    await client.query(`ALTER TABLE "evaluation_runs" ALTER COLUMN "job_id" DROP NOT NULL`);
    await client.query(`ALTER TABLE "evaluation_metrics" ADD COLUMN IF NOT EXISTS "metric_value" real`);
    await client.query(`ALTER TABLE "evaluation_metrics" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE "evaluation_metrics" ALTER COLUMN "value" DROP NOT NULL`);
  } catch (alterErr) {
    logger.warn({ alterErr }, "ZIE migration: evaluation_runs/metrics ALTER soft-failed — continuing");
  }

  // ── Flywheel Modal dispatch: training_jobs without Forge FK deps ─────────────
  // modalDispatch.ts INSERTs flywheel jobs with workspace_id=1 placeholders.
  // This table is created here so ZIE path works even when runMigrations() fails.
  await client.query(`
    CREATE TABLE IF NOT EXISTS "training_jobs" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" text NOT NULL,
      "workspace_id" integer,
      "dataset_id" integer,
      "dataset_version_id" integer,
      "name" text NOT NULL,
      "mode" text NOT NULL,
      "base_model" text NOT NULL,
      "hyperparams" jsonb NOT NULL DEFAULT '{}',
      "status" text NOT NULL DEFAULT 'draft',
      "kairos_run_id" text,
      "compute_backend" text NOT NULL DEFAULT 'modal',
      "reforge_suggested" boolean NOT NULL DEFAULT false,
      "error" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  try {
    await client.query(`ALTER TABLE "training_jobs" ALTER COLUMN "workspace_id" DROP NOT NULL`);
    await client.query(`ALTER TABLE "training_jobs" ALTER COLUMN "dataset_id" DROP NOT NULL`);
    await client.query(`ALTER TABLE "training_jobs" ALTER COLUMN "dataset_version_id" DROP NOT NULL`);
  } catch {
    // Table may already be nullable or not exist with NOT NULL — ignore
  }

  // ── Seed default router policies (idempotent) ──────────────────────────────
  await client.query(`
    INSERT INTO "zie_router_policies" ("task_type", "fast_model_id", "fast_provider")
    VALUES
      ('legal_clause_analysis',  'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
      ('legal_clause_draft',     'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
      ('legal_agreement_generate', 'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
      ('manuscript_slop_check',  'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter'),
      ('seo_content_audit',      'liquid/lfm-2.5-1.2b-instruct:free', 'openrouter')
    ON CONFLICT ("task_type") DO NOTHING
  `);

  await migrateLegalCorpus();
  setImmediate(() => {
    void backfillLegalCorpusEmbeddings();
  });

  logger.info("ZIE migration complete.");
  } catch (err) {
    logger.error({ err }, "ZIE migration failed — ZIE tables may be missing");
    throw err;
  } finally {
    client.release();
  }
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
        "plan" text NOT NULL DEFAULT 'free',
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
        ADD COLUMN IF NOT EXISTS "plan" text NOT NULL DEFAULT 'free',
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

    // Idempotent column additions for skills (Archon factory fields added after initial deploy)
    await client.query(`
      ALTER TABLE "skills"
        ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS "current_version" integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "archon_run_id" text,
        ADD COLUMN IF NOT EXISTS "implementation" text
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
        ADD COLUMN IF NOT EXISTS "error" text,
        ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'completed',
        ADD COLUMN IF NOT EXISTS "result_json" jsonb
    `);

    // archon_runs: DB-backed store for Archon skill forge runs (survives Render restarts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "archon_runs" (
        "run_id"           text PRIMARY KEY NOT NULL,
        "description"      text NOT NULL,
        "status"           text NOT NULL DEFAULT 'pending',
        "stage"            text,
        "skill"            jsonb,
        "l0_result"        jsonb,
        "benchmark_result" jsonb,
        "cataloged"        boolean,
        "skill_id"         integer REFERENCES "skills"("id") ON DELETE SET NULL,
        "retry_count"      integer NOT NULL DEFAULT 0,
        "error"            text,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "completed_at"     timestamptz
      )
    `);

    // tenant_skills: tenant_id integer (matches Drizzle schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "tenant_skills" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
        "skill_id" integer NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
        "installed_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    // activity_entries: uses "type" and "message" columns (matches Drizzle schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "activity_entries" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
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
        "tenant_id" text NOT NULL,
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
        "tenant_id" text NOT NULL,
        "connector_id" integer NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
        "encrypted_credential" text,
        "verified" boolean NOT NULL DEFAULT false,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "knowledge_graphs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" text NOT NULL,
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

    // Deduplicate model_workspaces before adding unique index (keep lowest id per tenant+name)
    // Must reassign FK references from duplicate rows to the canonical (min id) row first
    try {
      // Reassign model_datasets FK references from duplicate workspace rows to canonical rows
      await client.query(`
        UPDATE "model_datasets" md
        SET workspace_id = canonical.min_id
        FROM (
          SELECT tenant_id, name, MIN(id) AS min_id FROM "model_workspaces" GROUP BY tenant_id, name
        ) canonical
        JOIN "model_workspaces" dup ON dup.tenant_id = canonical.tenant_id AND dup.name = canonical.name
        WHERE md.workspace_id = dup.id AND dup.id != canonical.min_id
      `);
      // Reassign model_registrations FK references
      await client.query(`
        UPDATE "model_registrations" mr
        SET workspace_id = canonical.min_id
        FROM (
          SELECT tenant_id, name, MIN(id) AS min_id FROM "model_workspaces" GROUP BY tenant_id, name
        ) canonical
        JOIN "model_workspaces" dup ON dup.tenant_id = canonical.tenant_id AND dup.name = canonical.name
        WHERE mr.workspace_id = dup.id AND dup.id != canonical.min_id
      `);
      // Now safe to delete duplicates
      await client.query(`
        DELETE FROM "model_workspaces"
        WHERE id NOT IN (
          SELECT MIN(id) FROM "model_workspaces" GROUP BY tenant_id, name
        )
      `);
      // Idempotent unique constraint for workspace deduplication
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "model_workspaces_tenant_name_uidx"
          ON "model_workspaces" ("tenant_id", "name")
      `);
    } catch (dedupErr) {
      logger.warn({ dedupErr }, "model_workspaces dedup/unique-index skipped — continuing");
    }

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

    // ZIE tables created by runZieMigration() (called separately)

    // ── Counsel runs (async receipt store, C12) ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS "counsel_runs" (
        "id" uuid PRIMARY KEY NOT NULL,
        "input_sha256" text NOT NULL,
        "perspective" text NOT NULL DEFAULT 'company',
        "status" text NOT NULL DEFAULT 'running',
        "counsel_mode" text NOT NULL DEFAULT 'orchestrator',
        "result" jsonb,
        "error" text,
        "grounded_count" integer,
        "grounded_ratio" double precision,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "counsel_runs_status_idx" ON "counsel_runs" ("status");
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "counsel_runs_sha_idx" ON "counsel_runs" ("input_sha256");
    `);


    // ── Workflow engine tables (Sprint 1+2 from HANDOFF doc) ─────────────────
    // business_objects: tenant-scoped shared objects (invoice, contract, speaker, opportunity)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "business_objects" (
        "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"   text        NOT NULL,
        "workspace_id" integer,
        "object_type" text        NOT NULL,
        "slug"        text        NOT NULL,
        "display_name" text       NOT NULL,
        "data"        jsonb       NOT NULL DEFAULT '{}',
        "status"      text        NOT NULL DEFAULT 'active',
        "created_by"  text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "business_objects_tenant_idx"
        ON "business_objects" ("tenant_id", "object_type");
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "business_objects_tenant_slug_idx"
        ON "business_objects" ("tenant_id", "slug");
    `);

    // workflow_definitions: reusable step templates
    await client.query(`
      CREATE TABLE IF NOT EXISTS "workflow_definitions" (
        "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"   text        NOT NULL,
        "workspace_id" integer,
        "name"        text        NOT NULL,
        "description" text,
        "trigger"     text        NOT NULL DEFAULT 'manual',
        "steps"       jsonb       NOT NULL DEFAULT '[]',
        "policy_id"   uuid,
        "version"     integer     NOT NULL DEFAULT 1,
        "is_active"   boolean     NOT NULL DEFAULT true,
        "created_by"  text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "workflow_definitions_tenant_idx"
        ON "workflow_definitions" ("tenant_id");
    `);

    // workflow_runs: instances of workflow_definitions
    await client.query(`
      CREATE TABLE IF NOT EXISTS "workflow_runs" (
        "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "definition_id" uuid        REFERENCES "workflow_definitions"("id") ON DELETE SET NULL,
        "tenant_id"     text        NOT NULL,
        "workspace_id"  integer,
        "status"        text        NOT NULL DEFAULT 'pending',
        "trigger_kind"  text        NOT NULL DEFAULT 'manual',
        "input"         jsonb       NOT NULL DEFAULT '{}',
        "output"        jsonb,
        "error"         text,
        "started_at"    timestamptz,
        "completed_at"  timestamptz,
        "created_by"    text,
        "created_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "workflow_runs_tenant_status_idx"
        ON "workflow_runs" ("tenant_id", "status");
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "workflow_runs_definition_idx"
        ON "workflow_runs" ("definition_id");
    `);

    // workflow_step_results: per-step outputs for a run
    await client.query(`
      CREATE TABLE IF NOT EXISTS "workflow_step_results" (
        "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id"      uuid        NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
        "step_index"  integer     NOT NULL,
        "skill_id"    text,
        "status"      text        NOT NULL DEFAULT 'pending',
        "input"       jsonb       NOT NULL DEFAULT '{}',
        "output"      jsonb,
        "error"       text,
        "duration_ms" integer,
        "started_at"  timestamptz,
        "completed_at" timestamptz,
        "created_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "workflow_step_results_run_step_idx"
        ON "workflow_step_results" ("run_id", "step_index");
    `);

    // platform_policies: governance gate (Sprint 5 from HANDOFF doc)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "platform_policies" (
        "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"   text        NOT NULL,
        "policy_type" text        NOT NULL,
        "name"        text        NOT NULL,
        "description" text,
        "rules"       jsonb       NOT NULL DEFAULT '{}',
        "is_active"   boolean     NOT NULL DEFAULT true,
        "created_by"  text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "platform_policies_tenant_type_idx"
        ON "platform_policies" ("tenant_id", "policy_type");
    `);

    logger.info("DB migrations complete.");
  } finally {
    client.release();
  }
}

// Register admin router (needs pool + runMigrations — can't go in app.ts)
app.use("/api/admin", createAdminRouter(pool, runMigrations));

// Benchmark + promotion + judge extensions — unprotected like /api/mcps so
// automation and dashboards can hit them without a Clerk session.
app.use("/api/v1", intelligenceExtrasRouter(pool));

// MCP training dispatch + webhook receiver. Path convention matches the
// routes/index.ts mount so any client that walks /api/v1/mcps/training/*
// hits the same endpoints regardless of which router chain served them.
app.use("/api/v1/mcps/training", mcpTrainingRouter);

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
  // Run migrations independently so ZIE tables are always created even if
  // the main migration partially fails. Both run in parallel, then seed + scheduler.
  Promise.allSettled([
    runMigrations().catch((err) => {
      logger.error({ err }, "runMigrations failed — server continues");
    }),
    runZieMigration().catch((err) => {
      logger.error({ err }, "runZieMigration failed — ZIE tables may be missing");
    }),
  ])
    .then(() => {
      // ── Initialize workflowEngine IMMEDIATELY after migrations ──────────────
      // This MUST happen before runSeed() so that:
      //   1. Skills are always registered even if seed throws
      //   2. /api/status shows correct skill count after every restart
      //   3. POST /api/workflows/runs works without needing /api/admin/reinit
      workflowEngine.init(pool);
      registerAACRSkills();
      registerZOASkills();
      logger.info({ skills: workflowEngine.listSkills() }, "workflowEngine initialized with AACR + ZOA skills");

      // Recover inproc- jobs stuck in 'running' from a previous server instance.
      pool.query(
        `UPDATE training_jobs
         SET status='failed', error='Server restarted — in-process run lost', updated_at=now()
         WHERE status='running' AND kairos_run_id LIKE 'inproc-%'`
      ).then((r: { rowCount: number | null }) => {
        if ((r.rowCount ?? 0) > 0) {
          logger.warn({ count: r.rowCount }, "[startup] Marked stuck inproc- jobs as failed after restart");
        }
      }).catch((err: unknown) => {
        logger.warn({ err }, "[startup] Failed to recover stuck inproc- jobs — continuing");
      });

      // Seed runs after engine init — seed failure does NOT block skill registration
      // or scheduler/daemon startup. Isolate its failure so the chain keeps going.
      return runSeed().catch((err) => {
        logger.error({ err }, "DB seed/scheduler failed — server continues.");
      });
    })
    .then(() => {
      logger.info("DB migrations, engine init, and seed complete.");
      return startForgeScheduler();
    })
    .then(() => {
      logger.info("Forge scheduler started.");
      // Start Archon triage daemon. Self-gated by ARCHON_TRIAGE_ENABLED.
      // Disabled by default — safe to call unconditionally.
      startArchonDaemon(pool);
      // Start Autopilot daemon. Self-gated by AUTOPILOT_ENABLED (default 0) and
      // per-bucket opt-in via zie_autopilot_settings — safe to call unconditionally.
      startAutopilotDaemon(pool);
    })
    .catch((err) => {
      // Soft-fail: log the error but do NOT crash the server.
      logger.error({ err }, "post-migration boot chain failed — server continues.");
    });

  // ── MCP training seed loader (INDEPENDENT of DB migrations) ─────────────
  // Runs on its own microtask chain so that DB migration / seed failures
  // (e.g. missing pgvector extension in a local dev sandbox) do not prevent
  // the MCP training buffer from being hydrated. The MCP training loop is
  // pure in-memory + JSONL — it does not depend on Postgres.
  //
  // Off by default. When MCP_TRAINING_LOAD_SEED is unset OR =1, reads the
  // synthesised MCP preference-pair corpus and hydrates the in-memory
  // training buffer so the router-policy trigger can fire without a live
  // operator loop. This is the deployment lever that turns the training
  // loop from "wired" to "primed" — the file is the same 2,400-pair JSONL
  // synthesised by scripts/synthesize-mcp-pairs.ts.
  if (
    process.env.MCP_TRAINING_LOAD_SEED === undefined ||
    process.env.MCP_TRAINING_LOAD_SEED === "1"
  ) {
    void (async () => {
      try {
        const [{ bulkImportPairs, checkAndDispatch }, fsMod, pathMod] =
          await Promise.all([
            import("./lib/mcps/trainingLoop.js"),
            import("fs"),
            import("path"),
          ]);
        const seedPath =
          process.env.MCP_TRAINING_SEED_PATH ??
          pathMod.resolve(
            process.cwd(),
            "artifacts/api-server/corpus/mcp-training-seed.jsonl",
          );
        const altPath = pathMod.resolve(
          process.cwd(),
          "corpus/mcp-training-seed.jsonl",
        );
        const resolvedPath = fsMod.existsSync(seedPath)
          ? seedPath
          : fsMod.existsSync(altPath)
            ? altPath
            : null;
        if (!resolvedPath) {
          logger.warn(
            { seedPath, altPath },
            "[mcp.training.seed] corpus file not found — skipping",
          );
          return;
        }
        const raw = fsMod.readFileSync(resolvedPath, "utf-8");
        const rows: unknown[] = raw
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter((x) => x !== null);
        const loaded = bulkImportPairs(rows as any[]);
        logger.info(
          { path: resolvedPath, loaded, MCP_EVAL_DRY: process.env.MCP_EVAL_DRY ?? "1" },
          "[mcp.training.seed] hydrated MCP training buffer",
        );
        // Trigger a first threshold check so the training tab shows
        // dispatched pairs immediately after boot.
        const dispatches = await checkAndDispatch();
        const fired = dispatches.filter((d) => d.dispatched).length;
        logger.info(
          { fired, total: dispatches.length },
          "[mcp.training.seed] initial threshold check",
        );
      } catch (err) {
        logger.warn(
          { err: String(err) },
          "[mcp.training.seed] seed load failed — training loop still functional",
        );
      }
    })();
  } else {
    logger.info(
      "[mcp.training.seed] MCP_TRAINING_LOAD_SEED=0 — skipping corpus hydration",
    );
  }

  // Graceful shutdown — stop pg-boss before process exits
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal — stopping forge scheduler + archon + autopilot daemons");
    stopArchonDaemon();
    stopAutopilotDaemon();
    await stopForgeScheduler().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
});
