/**
 * seed.ts — Idempotent demo seed. Runs on every server startup.
 * Safe to run multiple times (ON CONFLICT DO NOTHING / DO UPDATE).
 */
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const DEMO_USER_ID = process.env.DEMO_USER_ID || "user_3DhVktxcTmcEqDWgYpMihDOy00t";

const ZOA_SKILLS = [
  { slug: "zoa-billing",     name: "ZOA Billing Agent",     category: "Finance",    description: "Automates invoice processing, payment reconciliation, and billing dispute resolution.", featured: true,  l4: 9.1, l3: 88, l2: 72, l1: 91, grade: "CERTIFIED" },
  { slug: "zoa-scheduling",  name: "ZOA Scheduling Agent",  category: "Operations", description: "Manages calendar coordination, meeting scheduling, and resource allocation.", featured: true,  l4: 8.7, l3: 85, l2: 68, l1: 89, grade: "CERTIFIED" },
  { slug: "zoa-payroll",     name: "ZOA Payroll Agent",     category: "HR",         description: "Handles payroll calculations, tax withholding, direct deposit, and compliance reporting.", featured: true,  l4: 8.0, l3: 82, l2: 65, l1: 87, grade: "CERTIFIED" },
  { slug: "zoa-hr",          name: "ZOA HR Agent",          category: "HR",         description: "Automates onboarding, offboarding, PTO tracking, and employee record management.", featured: false, l4: 6.2, l3: 75, l2: 55, l1: 78, grade: "CONDITIONAL" },
  { slug: "zoa-procurement", name: "ZOA Procurement Agent", category: "Operations", description: "Manages purchase orders, vendor negotiations, and supply chain coordination.", featured: false, l4: 6.0, l3: 72, l2: 52, l1: 74, grade: "CONDITIONAL" },
  { slug: "zoa-compliance",  name: "ZOA Compliance Agent",  category: "Legal",      description: "Monitors regulatory requirements, generates compliance reports, and flags policy violations.", featured: false, l4: 2.8, l3: 45, l2: 38, l1: 52, grade: "FAILED" },
];

export async function runSeed(): Promise<void> {
  const client = await pool.connect();
  try {
    const skillIds: Record<string, number> = {};

    for (const s of ZOA_SKILLS) {
      const res = await client.query(`
        INSERT INTO skills (name, slug, description, category, featured, tags, source)
        VALUES ($1,$2,$3,$4,$5,$6,'manual')
        ON CONFLICT (slug) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description,
          category=EXCLUDED.category, featured=EXCLUDED.featured
        RETURNING id
      `, [s.name, s.slug, s.description, s.category, s.featured,
          ["zoa", "multi-agent", s.category.toLowerCase()]]);
      skillIds[s.slug] = res.rows[0].id;
    }

    for (const s of ZOA_SKILLS) {
      await client.query(`
        INSERT INTO skill_benchmarks (skill_id, benchmark_id, status, overall_score, level_scores, grade, result_json)
        VALUES ($1,$2,'completed',$3,$4,$5,$6)
        ON CONFLICT DO NOTHING
      `, [
        skillIds[s.slug],
        `demo-${s.slug}`,
        s.l4,
        JSON.stringify({ l1: s.l1, l2: s.l2, l3: s.l3, l4: s.l4 }),
        s.grade,
        JSON.stringify({ grade: s.grade, levelScores: { l1: s.l1, l2: s.l2, l3: s.l3, l4: s.l4 } }),
      ]);
    }

    const tenantId = "tenant-demo-openclaw";
    await client.query(`
      INSERT INTO tenants (id, name, user_id, plan)
      VALUES ($1,'Demo Workspace',$2,'free')
      ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name
    `, [tenantId, DEMO_USER_ID]);

    for (const s of ZOA_SKILLS) {
      await client.query(`
        INSERT INTO tenant_skills (tenant_id, skill_id, enabled)
        VALUES ($1,$2,true) ON CONFLICT DO NOTHING
      `, [tenantId, skillIds[s.slug]]);
    }

    // ── Model Forge demo seed ─────────────────────────────────────────────────
    // Workspace: Legal Intelligence Lab
    const wsRes = await client.query(`
      INSERT INTO model_workspaces (tenant_id, name, description)
      VALUES ($1, 'Legal Intelligence Lab', 'Fine-tuning workspace for contract analysis and legal NLU models.')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [tenantId]);

    // If already seeded, look up the existing workspace id
    let workspaceId: number;
    if (wsRes.rows.length > 0) {
      workspaceId = wsRes.rows[0].id;
    } else {
      const existing = await client.query(
        `SELECT id FROM model_workspaces WHERE tenant_id=$1 AND name='Legal Intelligence Lab' LIMIT 1`,
        [tenantId]
      );
      workspaceId = existing.rows[0].id;
    }

    // Dataset: Contract Corpus v1
    const dsRes = await client.query(`
      INSERT INTO model_datasets (tenant_id, workspace_id, name, description, source_type, status)
      VALUES ($1, $2, 'Contract Corpus v1',
              'Curated set of NDA and MSA contracts for legal NLU fine-tuning.',
              'upload', 'ready')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [tenantId, workspaceId]);

    let datasetId: number;
    if (dsRes.rows.length > 0) {
      datasetId = dsRes.rows[0].id;
    } else {
      const existing = await client.query(
        `SELECT id FROM model_datasets WHERE tenant_id=$1 AND workspace_id=$2 AND name='Contract Corpus v1' LIMIT 1`,
        [tenantId, workspaceId]
      );
      datasetId = existing.rows[0].id;
    }

    // Two demo documents (metadata-only, no real file storage)
    await client.query(`
      INSERT INTO dataset_documents (tenant_id, dataset_id, filename, mime_type, size_bytes)
      VALUES
        ($1, $2, 'nda_corpus_500.jsonl',  'application/jsonl', 2621440),
        ($1, $2, 'msa_corpus_300.jsonl',  'application/jsonl', 1572864)
      ON CONFLICT DO NOTHING
    `, [tenantId, datasetId]);

    // Version snapshot v1
    const vRes = await client.query(`
      INSERT INTO dataset_versions (tenant_id, dataset_id, version, document_count, status)
      VALUES ($1, $2, 1, 2, 'ready')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [tenantId, datasetId]);

    let versionId: number;
    if (vRes.rows.length > 0) {
      versionId = vRes.rows[0].id;
    } else {
      const existing = await client.query(
        `SELECT id FROM dataset_versions WHERE tenant_id=$1 AND dataset_id=$2 AND version=1 LIMIT 1`,
        [tenantId, datasetId]
      );
      versionId = existing.rows[0].id;
    }

    // Training job: Legal NLU v1 — status=queued (submitted, awaiting dispatch)
    // Preserves governance step: job is visible in UI, can be dispatched or cancelled.
    await client.query(`
      INSERT INTO training_jobs (
        tenant_id, workspace_id, dataset_id, dataset_version_id,
        name, mode, base_model, hyperparams, status, compute_backend
      )
      VALUES (
        $1, $2, $3, $4,
        'Legal NLU v1', 'fine-tune', 'mistral-7b-instruct',
        '{"epochs":3,"learning_rate":2e-5,"batch_size":8}',
        'queued', 'stub'
      )
      ON CONFLICT DO NOTHING
    `, [tenantId, workspaceId, datasetId, versionId]);

    // Governance policy for the tenant
    await client.query(`
      INSERT INTO model_policies (
        tenant_id, allowed_base_models, max_dataset_bytes,
        max_concurrent_jobs, deployment_requires_approval, budget_limit_usd
      )
      VALUES ($1, $2, 524288000, 3, true, 500.00)
      ON CONFLICT (tenant_id) DO UPDATE SET
        allowed_base_models = EXCLUDED.allowed_base_models,
        deployment_requires_approval = EXCLUDED.deployment_requires_approval,
        budget_limit_usd = EXCLUDED.budget_limit_usd
    `, [tenantId, ['mistral-7b-instruct', 'llama-3-8b-instruct', 'phi-3-mini']]);

    logger.info(
      { userId: DEMO_USER_ID, tenantId, skills: ZOA_SKILLS.length, workspaceId, datasetId, versionId },
      "Seed complete (ZOA + Model Forge)"
    );
  } finally {
    client.release();
  }
}
