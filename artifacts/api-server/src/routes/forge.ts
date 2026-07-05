import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { requireWorkspaceMember } from "../middleware/requireWorkspaceMember";
import { kairosClient } from "../lib/kairosClient";
import { jobMonitor } from "../lib/jobMonitor";

const router: IRouter = Router();

// ─── Helper ───────────────────────────────────────────────────────────────────

function assertJobStatus(job: { status: string }, ...allowed: string[]): void {
  if (!allowed.includes(job.status)) {
    throw Object.assign(new Error("Invalid transition"), {
      statusCode: 409,
      current: job.status,
      required: allowed,
    });
  }
}

/** Recompute dataset status from its documents and update the row. */
async function recomputeDatasetStatus(
  client: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  datasetId: number,
): Promise<void> {
  const docRes = await client.query(
    `SELECT status, COUNT(*) as cnt FROM dataset_documents WHERE dataset_id = $1 GROUP BY status`,
    [datasetId],
  );

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of docRes.rows) {
    counts[row.status] = parseInt(row.cnt, 10);
    total += parseInt(row.cnt, 10);
  }

  let newStatus: string;
  if (counts["error"] > 0) {
    newStatus = "error";
  } else if (counts["pending"] > 0) {
    newStatus = "processing";
  } else if (total > 0) {
    newStatus = "ready";
  } else {
    newStatus = "pending";
  }

  await client.query(
    `UPDATE model_datasets SET status=$1, document_count=$2, updated_at=now() WHERE id=$3`,
    [newStatus, total, datasetId],
  );
}

// ─── Workspace routes (no :wid middleware) ────────────────────────────────────

// GET /forge/workspaces
router.get("/forge/workspaces", async (req, res): Promise<void> => {
  const jwtUserId: string | undefined = (req as any).auth?.userId;
  const rawHeaderUserId: unknown = (req as any).headers["x-user-id"];
  const headerUserId: string | undefined =
    typeof rawHeaderUserId === "string" && rawHeaderUserId.startsWith("user_")
      ? rawHeaderUserId : undefined;
  const userId = jwtUserId ?? headerUserId;
  if (!userId) {
    res.json([]);
    return;
  }

  let tenantRes = await pool.query(
    `SELECT t.id as tenant_id FROM tenants t WHERE t.user_id = $1`,
    [userId],
  );
  if (tenantRes.rows.length === 0) {
    // No tenant yet — return empty list; provision happens on first workspace create
    res.json([]);
    return;
  }
  const tenantId: string = tenantRes.rows[0].tenant_id;

  const wsRes = await pool.query(
    `SELECT * FROM model_workspaces WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  res.json(wsRes.rows);
});

// POST /forge/workspaces
router.post("/forge/workspaces", async (req, res): Promise<void> => {
  const { name, domain, description, userId: bodyUserId } = req.body ?? {};
  if (!name || !domain) {
    res.status(400).json({ error: "name and domain are required" });
    return;
  }

  // Accept userId from Clerk JWT or request body (dev instance cross-origin fallback).
  // Body userId must start with "user_" (Clerk ID format) to prevent trivial spoofing.
  const validBodyUserId = typeof bodyUserId === "string" && bodyUserId.startsWith("user_") ? bodyUserId : undefined;
  const userId: string | undefined = (req as any).auth?.userId ?? validBodyUserId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Auto-provision tenant if none exists for this user
  let tenantRes = await pool.query(
    `SELECT t.id as tenant_id FROM tenants t WHERE t.user_id = $1`,
    [userId],
  );
  let tenantId: string;
  if (tenantRes.rows.length === 0) {
    const newTenantId = `tenant-${userId.replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 32)}`;
    await pool.query(
      `INSERT INTO tenants (id, name, user_id, plan)
       VALUES ($1, $2, $3, 'free')
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [newTenantId, "My Workspace", userId],
    );
    tenantId = newTenantId;
  } else {
    tenantId = tenantRes.rows[0].tenant_id;
  }

  const wsRes = await pool.query(
    `INSERT INTO model_workspaces (tenant_id, name, domain, description)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tenantId, name, domain, description ?? null],
  );
  const workspace = wsRes.rows[0];

  // Insert default policy row (idempotent)
  await pool.query(
    `INSERT INTO model_policies (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );

  res.status(201).json(workspace);
});

// GET /forge/workspaces/:wid
router.get(
  "/forge/workspaces/:wid",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    res.json(req.resolvedWorkspace);
  },
);

// ─── Dataset routes ───────────────────────────────────────────────────────────

// GET /forge/workspaces/:wid/datasets
router.get(
  "/forge/workspaces/:wid/datasets",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const workspaceId = req.resolvedWorkspace!.id;
    const tenantId = req.resolvedTenantId!;

    const result = await pool.query(
      `SELECT * FROM model_datasets WHERE workspace_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [workspaceId, tenantId],
    );
    res.json(result.rows);
  },
);

// POST /forge/workspaces/:wid/datasets
router.post(
  "/forge/workspaces/:wid/datasets",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const { name, description, source_type, sensitivity } = req.body ?? {};
    if (!name || !source_type) {
      res.status(400).json({ error: "name and source_type are required" });
      return;
    }
    const validSourceTypes = ["upload", "url", "connector"];
    if (!validSourceTypes.includes(source_type)) {
      res.status(400).json({ error: `source_type must be one of: ${validSourceTypes.join(" | ")}` });
      return;
    }

    const workspaceId = req.resolvedWorkspace!.id;
    const tenantId = req.resolvedTenantId!;

    const result = await pool.query(
      `INSERT INTO model_datasets (tenant_id, workspace_id, name, description, source_type, sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, workspaceId, name, description ?? null, source_type, sensitivity ?? "internal"],
    );
    res.status(201).json(result.rows[0]);
  },
);

// GET /forge/workspaces/:wid/datasets/:did
router.get(
  "/forge/workspaces/:wid/datasets/:did",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const datasetId = parseInt(req.params.did as string, 10);
    if (isNaN(datasetId)) {
      res.status(400).json({ error: "Invalid dataset id" });
      return;
    }

    const dsRes = await pool.query(
      `SELECT * FROM model_datasets WHERE id = $1 AND tenant_id = $2`,
      [datasetId, tenantId],
    );
    if (dsRes.rows.length === 0) {
      res.status(404).json({ error: "Dataset not found" });
      return;
    }
    const dataset = dsRes.rows[0];

    const docsRes = await pool.query(
      `SELECT * FROM dataset_documents WHERE dataset_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [datasetId, tenantId],
    );

    res.json({ ...dataset, documents: docsRes.rows });
  },
);

// POST /forge/workspaces/:wid/datasets/:did/documents
router.post(
  "/forge/workspaces/:wid/datasets/:did/documents",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const { filename, size_bytes, mime_type, source_url } = req.body ?? {};
    if (!filename) {
      res.status(400).json({ error: "filename is required" });
      return;
    }

    const tenantId = req.resolvedTenantId!;
    const datasetId = parseInt(req.params.did as string, 10);
    if (isNaN(datasetId)) {
      res.status(400).json({ error: "Invalid dataset id" });
      return;
    }

    // Verify dataset belongs to resolved tenant
    const dsRes = await pool.query(
      `SELECT id FROM model_datasets WHERE id = $1 AND tenant_id = $2`,
      [datasetId, tenantId],
    );
    if (dsRes.rows.length === 0) {
      res.status(404).json({ error: "Dataset not found" });
      return;
    }

    const docRes = await pool.query(
      `INSERT INTO dataset_documents (tenant_id, dataset_id, filename, size_bytes, mime_type, source_url, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       RETURNING *`,
      [tenantId, datasetId, filename, size_bytes ?? 0, mime_type ?? null, source_url ?? null],
    );
    const doc = docRes.rows[0];

    // Recompute dataset status
    await recomputeDatasetStatus(pool, datasetId);

    res.status(201).json(doc);
  },
);

// DELETE /forge/workspaces/:wid/datasets/:did/documents/:docId
router.delete(
  "/forge/workspaces/:wid/datasets/:did/documents/:docId",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const datasetId = parseInt(req.params.did as string, 10);
    const docId = parseInt(req.params.docId as string, 10);
    if (isNaN(datasetId) || isNaN(docId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify document belongs to resolved tenant
    const docRes = await pool.query(
      `SELECT id FROM dataset_documents WHERE id = $1 AND tenant_id = $2 AND dataset_id = $3`,
      [docId, tenantId, datasetId],
    );
    if (docRes.rows.length === 0) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    await pool.query(`DELETE FROM dataset_documents WHERE id = $1`, [docId]);

    // Recompute dataset status
    await recomputeDatasetStatus(pool, datasetId);

    res.sendStatus(204);
  },
);

// POST /forge/workspaces/:wid/datasets/:did/version
router.post(
  "/forge/workspaces/:wid/datasets/:did/version",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const datasetId = parseInt(req.params.did as string, 10);
    if (isNaN(datasetId)) {
      res.status(400).json({ error: "Invalid dataset id" });
      return;
    }

    // Verify dataset belongs to resolved tenant
    const dsRes = await pool.query(
      `SELECT id FROM model_datasets WHERE id = $1 AND tenant_id = $2`,
      [datasetId, tenantId],
    );
    if (dsRes.rows.length === 0) {
      res.status(404).json({ error: "Dataset not found" });
      return;
    }

    // Get current document count and sum of size_bytes
    const statsRes = await pool.query(
      `SELECT COUNT(*) as doc_count, COALESCE(SUM(size_bytes), 0) as total_bytes
       FROM dataset_documents WHERE dataset_id = $1 AND tenant_id = $2`,
      [datasetId, tenantId],
    );
    const docCount = parseInt(statsRes.rows[0].doc_count, 10);
    const totalBytes = parseInt(statsRes.rows[0].total_bytes, 10);

    // Get next version number
    const versionRes = await pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM dataset_versions WHERE dataset_id = $1`,
      [datasetId],
    );
    const nextVersion = parseInt(versionRes.rows[0].next_version, 10);

    const insertRes = await pool.query(
      `INSERT INTO dataset_versions (tenant_id, dataset_id, version, document_count, total_bytes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, datasetId, nextVersion, docCount, totalBytes],
    );

    res.status(201).json(insertRes.rows[0]);
  },
);

// ─── Training job routes ──────────────────────────────────────────────────────

// GET /forge/workspaces/:wid/jobs
router.get(
  "/forge/workspaces/:wid/jobs",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const workspaceId = req.resolvedWorkspace!.id;
    const tenantId = req.resolvedTenantId!;

    const result = await pool.query(
      `SELECT * FROM training_jobs WHERE workspace_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [workspaceId, tenantId],
    );
    res.json(result.rows);
  },
);

// POST /forge/workspaces/:wid/jobs
router.post(
  "/forge/workspaces/:wid/jobs",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const { name, mode, base_model, dataset_id, dataset_version_id, hyperparams } = req.body ?? {};
    if (!name || !mode || !base_model || !dataset_id || !dataset_version_id) {
      res.status(400).json({ error: "name, mode, base_model, dataset_id, dataset_version_id are required" });
      return;
    }
    const validModes = ["prompt_tuning", "rag_adaptation", "fine_tuning"];
    if (!validModes.includes(mode)) {
      res.status(400).json({ error: `mode must be one of: ${validModes.join(" | ")}` });
      return;
    }

    const workspaceId = req.resolvedWorkspace!.id;
    const tenantId = req.resolvedTenantId!;

    // Verify dataset_version_id belongs to dataset_id and tenant
    const versionRes = await pool.query(
      `SELECT dv.id FROM dataset_versions dv
       JOIN model_datasets md ON md.id = dv.dataset_id
       WHERE dv.id = $1 AND dv.dataset_id = $2 AND md.tenant_id = $3`,
      [dataset_version_id, dataset_id, tenantId],
    );
    if (versionRes.rows.length === 0) {
      res.status(404).json({ error: "Dataset version not found or does not belong to this tenant" });
      return;
    }

    const jobRes = await pool.query(
      `INSERT INTO training_jobs (tenant_id, workspace_id, dataset_id, dataset_version_id, name, mode, base_model, hyperparams, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       RETURNING *`,
      [tenantId, workspaceId, dataset_id, dataset_version_id, name, mode, base_model, JSON.stringify(hyperparams ?? {})],
    );

    res.status(201).json(jobRes.rows[0]);
  },
);

// GET /forge/workspaces/:wid/jobs/:jid
router.get(
  "/forge/workspaces/:wid/jobs/:jid",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    let kairosStatus: any = null;
    if (job.kairos_run_id) {
      try {
        kairosStatus = await kairosClient.getRunStatus(job.kairos_run_id);
      } catch {
        kairosStatus = null;
      }
    }

    res.json({ ...job, kairosStatus });
  },
);

// POST /forge/workspaces/:wid/jobs/:jid/submit
router.post(
  "/forge/workspaces/:wid/jobs/:jid/submit",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    // Idempotent: if already queued, return 200
    if (job.status === "queued") {
      res.json(job);
      return;
    }

    try {
      assertJobStatus(job, "draft");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    // Server-side validation
    let failReason: string | null = null;

    // 1. Get dataset: must have status=ready
    const dsRes = await pool.query(
      `SELECT * FROM model_datasets WHERE id = $1 AND tenant_id = $2`,
      [job.dataset_id, tenantId],
    );
    const dataset = dsRes.rows[0];
    if (!dataset || dataset.status !== "ready") {
      failReason = `Dataset is not ready (status: ${dataset?.status ?? "not found"})`;
    }

    if (!failReason) {
      // 2. Get policy for tenant
      const policyRes = await pool.query(
        `SELECT * FROM model_policies WHERE tenant_id = $1`,
        [tenantId],
      );
      const policy = policyRes.rows[0] ?? {
        allowed_base_models: [],
        max_concurrent_jobs: 2,
      };

      const allowedModels: string[] = policy.allowed_base_models ?? [];
      const maxConcurrent: number = policy.max_concurrent_jobs ?? 2;

      // 3. Check base model allowlist
      if (allowedModels.length > 0 && !allowedModels.includes(job.base_model)) {
        failReason = `Base model '${job.base_model}' is not in the allowed list`;
      }

      if (!failReason) {
        // 4. Count running/queued jobs
        const countRes = await pool.query(
          `SELECT COUNT(*) as cnt FROM training_jobs WHERE tenant_id = $1 AND status IN ('running', 'queued')`,
          [tenantId],
        );
        const runningCount = parseInt(countRes.rows[0].cnt, 10);
        if (runningCount >= maxConcurrent) {
          failReason = `Max concurrent jobs (${maxConcurrent}) reached`;
        }
      }
    }

    if (failReason) {
      // 6. Fail the job
      await pool.query(
        `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
        [failReason, jobId],
      );
      const updatedRes = await pool.query(`SELECT * FROM training_jobs WHERE id = $1`, [jobId]);
      res.json(updatedRes.rows[0]);
      return;
    }

    // 5. All pass: update status to queued
    await pool.query(
      `UPDATE training_jobs SET status='queued', updated_at=now() WHERE id=$1`,
      [jobId],
    );
    const updatedRes = await pool.query(`SELECT * FROM training_jobs WHERE id = $1`, [jobId]);
    res.json(updatedRes.rows[0]);
  },
);

// POST /forge/workspaces/:wid/jobs/:jid/dispatch
router.post(
  "/forge/workspaces/:wid/jobs/:jid/dispatch",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const workspace = req.resolvedWorkspace!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    try {
      assertJobStatus(job, "queued");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    // Fetch dataset and version for goal string
    const dsRes = await pool.query(
      `SELECT * FROM model_datasets WHERE id = $1`,
      [job.dataset_id],
    );
    const dataset = dsRes.rows[0];

    const versionRes = await pool.query(
      `SELECT * FROM dataset_versions WHERE id = $1`,
      [job.dataset_version_id],
    );
    const version = versionRes.rows[0];

    const goal = `Execute ${job.mode} training workflow for workspace '${workspace.name}' (domain: '${workspace.domain}'). Dataset: '${dataset?.name ?? "unknown"}' v${version?.version ?? 1}, ${version?.document_count ?? 0} documents. Base model: '${job.base_model}'. Hyperparams: ${JSON.stringify(job.hyperparams)}. Tenant: ${tenantId}.`;

    // Soft-fail: if KAIROS_SERVICE_URL is unset, localhost, or unreachable,
    // queue the job with a stub run_id so the UI doesn't hard-fail.
    const kairosUrl = process.env.KAIROS_SERVICE_URL;
    const kairosConfiguredLocally = !kairosUrl || kairosUrl.includes("localhost");

    let runId: string;
    let usedStub = false;

    if (kairosConfiguredLocally) {
      // No real Kairos — use stub immediately
      runId = `stub-${jobId}-${Date.now()}`;
      usedStub = true;
      logger.warn({ jobId, runId }, "[forge] KAIROS_SERVICE_URL not set — using stub run_id");
    } else {
      // Try real Kairos; fall back to stub on any network/service error
      try {
        const run = await kairosClient.runWorkflow({
          skill_id: `forge-job-${job.id}`,
          goal,
          tenant_id: tenantId,
          max_turns: 10,
        });
        runId = run.run_id;
        // Start job monitor only for real Kairos runs
        jobMonitor.start(jobId, runId, tenantId, workspace.id);
      } catch (kairosErr: any) {
        // Kairos unreachable or returned error — soft-fail to stub
        runId = `stub-${jobId}-${Date.now()}`;
        usedStub = true;
        logger.warn({ jobId, runId, kairosErr: kairosErr.message }, "[forge] Kairos unreachable — falling back to stub run_id");
      }
    }

    try {
      // Update job status to running
      await pool.query(
        `UPDATE training_jobs SET status='running', kairos_run_id=$1, updated_at=now() WHERE id=$2`,
        [runId, jobId],
      );

      // Insert usage event
      await pool.query(
        `INSERT INTO model_usage_events (tenant_id, job_id, event_type) VALUES ($1, $2, 'training_started')`,
        [tenantId, jobId],
      );

      const updatedRes = await pool.query(`SELECT * FROM training_jobs WHERE id = $1`, [jobId]);
      res.json({ ...updatedRes.rows[0], kairosRunId: runId, stub: usedStub });
    } catch (err: any) {
      // DB error — mark job failed
      await pool.query(
        `UPDATE training_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
        [err.message, jobId],
      );
      res.status(500).json({ error: "Failed to update job status", details: err.message });
    }
  },
);

// GET /forge/workspaces/:wid/jobs/:jid/events
router.get(
  "/forge/workspaces/:wid/jobs/:jid/events",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    if (!job.kairos_run_id) {
      res.status(404).json({ error: "Job not dispatched yet" });
      return;
    }

    const streamUrl = kairosClient.getRunStreamUrl(job.kairos_run_id);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const upstream = await fetch(streamUrl, {
        signal: AbortSignal.timeout(300_000),
      });

      if (!upstream.ok || !upstream.body) {
        res.write(`data: ${JSON.stringify({ error: "Upstream SSE unavailable" })}\n\n`);
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      req.on("close", () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch {
      res.write(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`);
      res.end();
    }
  },
);

// POST /forge/workspaces/:wid/jobs/:jid/cancel
router.post(
  "/forge/workspaces/:wid/jobs/:jid/cancel",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    // Idempotent: if already failed, return 200
    if (job.status === "failed") {
      res.json(job);
      return;
    }

    try {
      assertJobStatus(job, "queued", "running");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    await pool.query(
      `UPDATE training_jobs SET status='failed', error='Cancelled by user', updated_at=now() WHERE id=$1`,
      [jobId],
    );
    jobMonitor.stop(jobId);

    const updatedRes = await pool.query(`SELECT * FROM training_jobs WHERE id = $1`, [jobId]);
    res.json(updatedRes.rows[0]);
  },
);

// ─── Scaffolded routes (Phases 5–8) ──────────────────────────────────────────

// GET /forge/workspaces/:wid/policies
router.get(
  "/forge/workspaces/:wid/policies",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;

    const result = await pool.query(
      `SELECT * FROM model_policies WHERE tenant_id = $1`,
      [tenantId],
    );

    if (result.rows.length === 0) {
      // Return default policy object without inserting
      res.json({
        tenant_id: tenantId,
        allowed_base_models: [],
        max_dataset_bytes: 104857600,
        max_concurrent_jobs: 2,
        deployment_requires_approval: true,
        budget_limit_usd: null,
      });
      return;
    }

    res.json(result.rows[0]);
  },
);

// PUT /forge/workspaces/:wid/policies
router.put(
  "/forge/workspaces/:wid/policies",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const {
      allowed_base_models,
      max_dataset_bytes,
      max_concurrent_jobs,
      deployment_requires_approval,
      budget_limit_usd,
    } = req.body ?? {};

    const result = await pool.query(
      `INSERT INTO model_policies (tenant_id, allowed_base_models, max_dataset_bytes, max_concurrent_jobs, deployment_requires_approval, budget_limit_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         allowed_base_models = COALESCE($2, model_policies.allowed_base_models),
         max_dataset_bytes = COALESCE($3, model_policies.max_dataset_bytes),
         max_concurrent_jobs = COALESCE($4, model_policies.max_concurrent_jobs),
         deployment_requires_approval = COALESCE($5, model_policies.deployment_requires_approval),
         budget_limit_usd = COALESCE($6, model_policies.budget_limit_usd),
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        allowed_base_models ?? [],
        max_dataset_bytes ?? 104857600,
        max_concurrent_jobs ?? 2,
        deployment_requires_approval ?? true,
        budget_limit_usd ?? null,
      ],
    );

    res.json(result.rows[0]);
  },
);

// GET /forge/workspaces/:wid/registry
router.get(
  "/forge/workspaces/:wid/registry",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const workspaceId = req.resolvedWorkspace!.id;
    const tenantId = req.resolvedTenantId!;

    const regsRes = await pool.query(
      `SELECT * FROM model_registrations WHERE workspace_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [workspaceId, tenantId],
    );

    const registrations = await Promise.all(
      regsRes.rows.map(async (reg: any) => {
        const versionsRes = await pool.query(
          `SELECT * FROM model_versions WHERE registration_id = $1 ORDER BY version ASC`,
          [reg.id],
        );
        return { registration: reg, versions: versionsRes.rows };
      }),
    );

    res.json(registrations);
  },
);

// POST /forge/workspaces/:wid/registry/:rid/versions/:vid/approve
router.post(
  "/forge/workspaces/:wid/registry/:rid/versions/:vid/approve",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const versionId = parseInt(req.params.vid as string, 10);
    const registrationId = parseInt(req.params.rid as string, 10);
    if (isNaN(versionId) || isNaN(registrationId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify version belongs to resolved tenant
    const versionRes = await pool.query(
      `SELECT mv.* FROM model_versions mv
       JOIN model_registrations mr ON mr.id = mv.registration_id
       WHERE mv.id = $1 AND mv.registration_id = $2 AND mv.tenant_id = $3`,
      [versionId, registrationId, tenantId],
    );
    if (versionRes.rows.length === 0) {
      res.status(404).json({ error: "Model version not found" });
      return;
    }
    const version = versionRes.rows[0];

    try {
      assertJobStatus(version, "candidate");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    // Verify actor = tenant owner
    const jwtUserId2: string | undefined = (req as any).auth?.userId;
    const rawHdr2: unknown = (req as any).headers["x-user-id"];
    const hdrUserId2: string | undefined = typeof rawHdr2 === "string" && rawHdr2.startsWith("user_") ? rawHdr2 : undefined;
    const userId: string | undefined = jwtUserId2 ?? hdrUserId2;
    const tenantOwnerRes = await pool.query(
      `SELECT user_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantOwnerRes.rows.length === 0 || tenantOwnerRes.rows[0].user_id !== userId) {
      res.status(403).json({ error: "Only the tenant owner can approve model versions" });
      return;
    }

    // Update version status
    const updatedRes = await pool.query(
      `UPDATE model_versions SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2 RETURNING *`,
      [userId, versionId],
    );

    // Insert approval record
    await pool.query(
      `INSERT INTO model_approvals (tenant_id, version_id, action, actor_id) VALUES ($1, $2, 'approved', $3)`,
      [tenantId, versionId, userId],
    );

    res.json(updatedRes.rows[0]);
  },
);

// GET /forge/workspaces/:wid/deployments
router.get(
  "/forge/workspaces/:wid/deployments",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;

    const result = await pool.query(
      `SELECT * FROM model_deployments WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    res.json(result.rows);
  },
);

// POST /forge/workspaces/:wid/jobs/:jid/deploy
router.post(
  "/forge/workspaces/:wid/jobs/:jid/deploy",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT * FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = jobRes.rows[0];

    try {
      assertJobStatus(job, "completed");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    // Find the model_version for this job (via model_registrations)
    const versionRes = await pool.query(
      `SELECT mv.* FROM model_versions mv
       JOIN model_registrations mr ON mr.id = mv.registration_id
       WHERE mr.job_id = $1 AND mr.tenant_id = $2
       ORDER BY mv.version DESC
       LIMIT 1`,
      [jobId, tenantId],
    );
    if (versionRes.rows.length === 0) {
      res.status(404).json({ error: "No model version found for this job" });
      return;
    }
    const version = versionRes.rows[0];

    try {
      assertJobStatus(version, "approved");
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: "Invalid transition", current: err.current, required: err.required });
        return;
      }
      throw err;
    }

    // Insert deployment
    const deployRes = await pool.query(
      `INSERT INTO model_deployments (tenant_id, version_id, status, compute_backend)
       VALUES ($1, $2, 'pending', 'stub')
       RETURNING *`,
      [tenantId, version.id],
    );

    // Update job status
    await pool.query(
      `UPDATE training_jobs SET status='deployed', updated_at=now() WHERE id=$1`,
      [jobId],
    );

    res.json(deployRes.rows[0]);
  },
);

// GET /forge/workspaces/:wid/jobs/:jid/eval
router.get(
  "/forge/workspaces/:wid/jobs/:jid/eval",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const jobId = parseInt(req.params.jid as string, 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const jobRes = await pool.query(
      `SELECT id FROM training_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    if (jobRes.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const runsRes = await pool.query(
      `SELECT * FROM evaluation_runs WHERE job_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [jobId, tenantId],
    );
    const runs = runsRes.rows;

    const metricsRes = await pool.query(
      `SELECT em.* FROM evaluation_metrics em
       JOIN evaluation_runs er ON er.id = em.eval_run_id
       WHERE er.job_id = $1 AND em.tenant_id = $2
       ORDER BY em.created_at DESC`,
      [jobId, tenantId],
    );
    const metrics = metricsRes.rows;

    res.json({ runs, metrics });
  },
);

// GET /forge/workspaces/:wid/registry/:rid/deployment
// Returns the active deployment for a registry item, including the callable endpoint_url.
// Used by the in-product "Use Model" panel in the Forge workspace UI.
router.get(
  "/forge/workspaces/:wid/registry/:rid/deployment",
  requireWorkspaceMember,
  async (req, res): Promise<void> => {
    const tenantId = req.resolvedTenantId!;
    const registrationId = parseInt(req.params.rid as string, 10);
    if (isNaN(registrationId)) {
      res.status(400).json({ error: "Invalid registration id" });
      return;
    }

    // Verify registration belongs to this tenant
    const regRes = await pool.query(
      `SELECT mr.id, mr.name FROM model_registrations mr
       WHERE mr.id = $1 AND mr.tenant_id = $2`,
      [registrationId, tenantId],
    );
    if (regRes.rows.length === 0) {
      res.status(404).json({ error: "Registration not found" });
      return;
    }

    // Find the latest approved version
    const versionRes = await pool.query(
      `SELECT mv.id, mv.version, mv.status, mv.notes, mv.artifact_key
       FROM model_versions mv
       WHERE mv.registration_id = $1 AND mv.tenant_id = $2 AND mv.status = 'approved'
       ORDER BY mv.version DESC
       LIMIT 1`,
      [registrationId, tenantId],
    );
    if (versionRes.rows.length === 0) {
      res.status(404).json({ error: "No approved version found" });
      return;
    }
    const version = versionRes.rows[0];

    // Find the active deployment for this version
    const deployRes = await pool.query(
      `SELECT md.id, md.status, md.compute_backend, md.deployed_at,
              de.path as endpoint_url, de.auth_required
       FROM model_deployments md
       LEFT JOIN deployment_endpoints de ON de.deployment_id = md.id AND de.tenant_id = md.tenant_id
       WHERE md.version_id = $1 AND md.tenant_id = $2 AND md.status = 'active'
       ORDER BY md.deployed_at DESC
       LIMIT 1`,
      [version.id, tenantId],
    );

    if (deployRes.rows.length === 0) {
      res.status(404).json({ error: "No active deployment found" });
      return;
    }
    const deployment = deployRes.rows[0];

    res.json({
      registration_id: registrationId,
      registration_name: regRes.rows[0].name,
      version: version.version,
      version_id: version.id,
      version_status: version.status,
      artifact_key: version.artifact_key,
      deployment_id: deployment.id,
      deployment_status: deployment.status,
      endpoint_url: deployment.endpoint_url,
      auth_required: deployment.auth_required ?? false,
      deployed_at: deployment.deployed_at,
    });
  },
);

export default router;
