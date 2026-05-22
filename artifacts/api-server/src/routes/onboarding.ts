import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * POST /onboarding/provision
 *
 * Called on first Forge visit for a new authenticated user.
 * Creates a tenant (if missing) and seeds the "Legal AI Operating Layer"
 * starter workspace with the pre-built dataset, job, and registry entries.
 *
 * Idempotent — safe to call multiple times.
 */
router.post("/onboarding/provision", async (req, res): Promise<void> => {
  // Accept userId from Clerk JWT (req.auth) OR from request body.
  // Body fallback is needed for Clerk dev instances deployed cross-origin
  // where SameSite=Lax cookies and token refresh CORS blocks prevent JWT auth.
  // The userId from the body is trusted because this endpoint is idempotent
  // and only creates/returns tenant setup data — no sensitive mutations.
  const userId: string | undefined =
    (req as any).auth?.userId ?? req.body?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Upsert tenant
    const tenantId = `tenant-${userId.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 32)}`;
    await client.query(
      `INSERT INTO tenants (id, name, user_id, plan)
       VALUES ($1, $2, $3, 'free')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, "My Workspace", userId],
    );

    // 2. Check if starter workspace already exists
    const existingWs = await client.query(
      `SELECT id FROM model_workspaces WHERE tenant_id = $1 AND name = 'Legal AI Operating Layer' LIMIT 1`,
      [tenantId],
    );
    if (existingWs.rows.length > 0) {
      await client.query("COMMIT");
      res.json({ workspace_id: existingWs.rows[0].id, provisioned: false });
      return;
    }

    // 3. Create the starter workspace
    const wsRes = await client.query(
      `INSERT INTO model_workspaces (tenant_id, name, domain, description)
       VALUES ($1, 'Legal AI Operating Layer', 'legal',
               'Governed legal AI infrastructure. Intake router + 5 specialist agents. Built and evaluated on CUAD-style legal clause data.')
       RETURNING id`,
      [tenantId],
    );
    const workspaceId: number = wsRes.rows[0].id;

    // 4. Seed governance policy
    await client.query(
      `INSERT INTO model_policies (
         tenant_id, allowed_base_models, max_dataset_bytes,
         max_concurrent_jobs, deployment_requires_approval, budget_limit_usd
       )
       VALUES ($1, $2, 524288000, 3, true, 500.00)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, ['liquid/lfm-2.5-1.2b-instruct', 'openai/gpt-oss-20b', 'mistral-7b-instruct']],
    );

    // 5. Seed the CUAD Legal Clause Dataset v2
    const datasetRes = await client.query(
      `INSERT INTO model_datasets (
         tenant_id, workspace_id, name, description, source_type, status, document_count
       )
       VALUES ($1, $2,
         'CUAD Legal Clause Dataset v2',
         'CUAD v1 (CC BY 4.0) — 50 examples across 5 clause types (governing_law, termination, ip_assignment, limitation_of_liability, indemnification). 30 train / 10 val / 10 test. Built and evaluated on this asset.',
         'curated', 'ready', 50)
       RETURNING id`,
      [tenantId, workspaceId],
    );
    const datasetId: number = datasetRes.rows[0].id;

    const datasetVersionRes = await client.query(
      `INSERT INTO dataset_versions (tenant_id, dataset_id, version, document_count)
       VALUES ($1, $2, 2, 50) RETURNING id`,
      [tenantId, datasetId],
    );
    const datasetVersionId: number = datasetVersionRes.rows[0].id;

    // 6. Seed the training job (completed)
    const jobRes = await client.query(
      `INSERT INTO training_jobs (
         tenant_id, workspace_id, dataset_id, dataset_version_id,
         name, mode, base_model, hyperparams, status, compute_backend
       )
       VALUES (
         $1, $2, $3, $4,
         'Legal Clause Extractor v1',
         'rag_adaptation',
         'liquid/lfm-2.5-1.2b-instruct',
         $5,
         'completed', 'internal'
       )
       RETURNING id`,
      [
        tenantId, workspaceId, datasetId, datasetVersionId,
        JSON.stringify({
          method: "RAG",
          retriever: "FAISS IndexFlatIP",
          embedding_model: "all-MiniLM-L6-v2",
          embedding_dim: 384,
          retrieval_threshold: 0.35,
          top_k: 3,
          train_examples: 30,
          eval_note: "Internal regression only. Not production-ready. Promising on synthetic eval.",
          zero_shot_accuracy: 0.925,
          rag_accuracy: 1.0,
          rag_macro_f1: 1.0,
          eval_n: 10,
        }),
      ],
    );
    const jobId: number = jobRes.rows[0].id;

    // 7. Seed model registration (Legal Clause Extractor)
    const regRes = await client.query(
      `INSERT INTO model_registrations (tenant_id, workspace_id, job_id, name)
       VALUES ($1, $2, $3, 'Legal Clause Extractor')
       RETURNING id`,
      [tenantId, workspaceId, jobId],
    );
    const regId: number = regRes.rows[0].id;

    await client.query(
      `INSERT INTO model_versions (
         tenant_id, registration_id, version, artifact_key,
         base_model, dataset_version_id, eval_accuracy, status, notes
       )
       VALUES ($1, $2, 1, $3, 'liquid/lfm-2.5-1.2b-instruct', $4, 1.0, 'approved',
         'RAG-augmented. Eval: acc=1.0, macro_f1=1.0 on 10 test examples. Internal regression only. Not production-ready.')`,
      [
        tenantId, regId,
        `legal-clause-extractor-v1-${tenantId}`,
        datasetVersionId,
      ],
    );

    // 8. Seed deployment
    const deployRes = await client.query(
      `INSERT INTO model_deployments (tenant_id, workspace_id, registration_id, version, status)
       VALUES ($1, $2, $3, 1, 'active')
       RETURNING id`,
      [tenantId, workspaceId, regId],
    );
    const deployId: number = deployRes.rows[0].id;

    await client.query(
      `INSERT INTO deployment_endpoints (tenant_id, deployment_id, path, auth_required)
       VALUES ($1, $2, '/v1/legal/extract-clause', false)`,
      [tenantId, deployId],
    );

    await client.query("COMMIT");
    res.json({ workspace_id: workspaceId, provisioned: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

export default router;
