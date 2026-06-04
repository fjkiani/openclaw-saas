/**
 * flywheel.ts
 *
 * GET /api/v1/legal/flywheel/status
 *   Returns per-domain, per-task_type progress toward the training threshold.
 *   Used by CounselUI History tab to show the flywheel progress bar.
 *
 * GET /api/v1/seo/flywheel/status
 *   SEO-specific flywheel status. Only queries zie_training_records and
 *   zie_preference_pairs — no dependency on training_jobs table.
 *   This is the acceptance-gate endpoint for Priority 1.
 *
 * Response shape (both endpoints):
 * {
 *   threshold: 50,
 *   domains: [
 *     {
 *       domain: "seo",
 *       task_type: "seo_audit",
 *       sft_records: 4,          // rows in zie_training_records where domain='seo'
 *       total_pairs: 2,          // rows in zie_preference_pairs where domain='seo'
 *       verified_pairs: 0,       // judge_verified = true
 *       pct: 0,                  // verified_pairs / threshold * 100
 *       training_status: "accumulating"
 *     },
 *     ...
 *   ]
 * }
 */

import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { VERIFIED_DPO_THRESHOLD } from "../lib/modalDispatch.js";

const router = Router();

// ── GET /api/v1/seo/flywheel/status ──────────────────────────────────────────
// SEO-only flywheel status. No training_jobs dependency.
// This is the acceptance-gate endpoint: run an audit, call this, see count increase.

router.get(
  "/v1/seo/flywheel/status",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      // SFT records per task_type (domain='seo')
      const sftRes = await pool.query<{
        task_type: string;
        sft_records: string;
        remote_records: string;
        local_records: string;
        latest_created_at: string;
      }>(
        `SELECT
           task_type,
           COUNT(*) AS sft_records,
           SUM(CASE WHEN source_kind = 'remote_promoted' THEN 1 ELSE 0 END) AS remote_records,
           SUM(CASE WHEN source_kind = 'local_rejected'  THEN 1 ELSE 0 END) AS local_records,
           MAX(created_at) AS latest_created_at
         FROM zie_training_records
         WHERE domain = 'seo'
         GROUP BY task_type
         ORDER BY task_type`,
      );

      // DPO pairs per task_type (domain='seo')
      const pairsRes = await pool.query<{
        task_type: string;
        total_pairs: string;
        verified_pairs: string;
      }>(
        `SELECT
           task_type,
           COUNT(*) AS total_pairs,
           SUM(CASE WHEN judge_verified THEN 1 ELSE 0 END) AS verified_pairs
         FROM zie_preference_pairs
         WHERE domain = 'seo'
         GROUP BY task_type
         ORDER BY task_type`,
      );

      // Merge by task_type
      const pairsByTaskType = new Map<string, { total: number; verified: number }>();
      for (const row of pairsRes.rows) {
        pairsByTaskType.set(row.task_type, {
          total: parseInt(row.total_pairs, 10),
          verified: parseInt(row.verified_pairs, 10),
        });
      }

      const domains = sftRes.rows.map((row) => {
        const sftRecords = parseInt(row.sft_records, 10);
        const pairs = pairsByTaskType.get(row.task_type) ?? { total: 0, verified: 0 };
        const pct = Math.min(
          100,
          Math.round((pairs.verified / VERIFIED_DPO_THRESHOLD) * 100),
        );

        let trainingStatus: "accumulating" | "threshold_met" | "training" | "deployed";
        if (pairs.verified >= VERIFIED_DPO_THRESHOLD) {
          trainingStatus = "threshold_met";
        } else {
          trainingStatus = "accumulating";
        }

        return {
          domain: "seo",
          task_type: row.task_type,
          sft_records: sftRecords,
          remote_records: parseInt(row.remote_records, 10),
          local_records: parseInt(row.local_records, 10),
          total_pairs: pairs.total,
          verified_pairs: pairs.verified,
          pct,
          training_status: trainingStatus,
          latest_audit_at: row.latest_created_at ?? null,
        };
      });

      // If no rows yet, return a zero-state so the UI can render the empty bar
      if (domains.length === 0) {
        res.status(200).json({
          threshold: VERIFIED_DPO_THRESHOLD,
          domains: [
            {
              domain: "seo",
              task_type: "seo_audit",
              sft_records: 0,
              remote_records: 0,
              local_records: 0,
              total_pairs: 0,
              verified_pairs: 0,
              pct: 0,
              training_status: "accumulating",
              latest_audit_at: null,
            },
          ],
        });
        return;
      }

      res.status(200).json({ threshold: VERIFIED_DPO_THRESHOLD, domains });
    } catch (err: unknown) {
      logger.error({ err }, "flywheel.ts: seo flywheel status query failed");
      res.status(500).json({ error: "SEO flywheel status query failed" });
    }
  },
);

// ── GET /api/v1/legal/flywheel/status ─────────────────────────────────────────
// Original legal flywheel status. Fixed: training_jobs query is now wrapped in
// its own try/catch so a missing table doesn't crash the entire response.

router.get(
  "/v1/legal/flywheel/status",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      // Per task_type: verified pairs, total pairs
      const pairsRes = await pool.query<{
        domain: string;
        task_type: string;
        total_pairs: string;
        verified_pairs: string;
      }>(
        `SELECT
           domain,
           task_type,
           COUNT(*) AS total_pairs,
           SUM(CASE WHEN judge_verified THEN 1 ELSE 0 END) AS verified_pairs
         FROM zie_preference_pairs
         GROUP BY domain, task_type
         ORDER BY domain, task_type`,
      );

      // Per task_type: SFT records
      const sftRes = await pool.query<{
        domain: string;
        task_type: string;
        sft_records: string;
      }>(
        `SELECT domain, task_type, COUNT(*) AS sft_records
         FROM zie_training_records
         GROUP BY domain, task_type
         ORDER BY domain, task_type`,
      );

      // Per task_type: latest training job status
      // Wrapped in its own try/catch — training_jobs table may not exist yet.
      const jobStatusByTaskType = new Map<string, string>();
      try {
        const jobRes = await pool.query<{
          task_type: string;
          status: string;
        }>(
          `SELECT DISTINCT ON (
             (hyperparams->>'task_type')
           )
             hyperparams->>'task_type' AS task_type,
             status
           FROM training_jobs
           WHERE hyperparams->>'task_type' IS NOT NULL
           ORDER BY (hyperparams->>'task_type'), id DESC`,
        );
        for (const row of jobRes.rows) {
          if (row.task_type) jobStatusByTaskType.set(row.task_type, row.status);
        }
      } catch (jobErr: unknown) {
        // training_jobs table not yet migrated — safe to continue without it.
        logger.warn(
          { err: jobErr },
          "flywheel.ts: training_jobs query failed (table may not exist yet) — continuing without job status",
        );
      }

      // Build lookup maps
      const sftByTaskType = new Map<string, number>();
      for (const row of sftRes.rows) {
        sftByTaskType.set(`${row.domain}:${row.task_type}`, parseInt(row.sft_records, 10));
      }

      // Build domain entries
      const domains = pairsRes.rows.map((row) => {
        const verifiedPairs = parseInt(row.verified_pairs, 10);
        const totalPairs = parseInt(row.total_pairs, 10);
        const sftRecords = sftByTaskType.get(`${row.domain}:${row.task_type}`) ?? 0;
        const pct = Math.min(100, Math.round((verifiedPairs / VERIFIED_DPO_THRESHOLD) * 100));

        const jobStatus = jobStatusByTaskType.get(row.task_type);
        let trainingStatus: "accumulating" | "threshold_met" | "training" | "deployed";
        if (jobStatus === "completed") {
          trainingStatus = "deployed";
        } else if (jobStatus === "running") {
          trainingStatus = "training";
        } else if (verifiedPairs >= VERIFIED_DPO_THRESHOLD) {
          trainingStatus = "threshold_met";
        } else {
          trainingStatus = "accumulating";
        }

        return {
          domain: row.domain,
          task_type: row.task_type,
          verified_pairs: verifiedPairs,
          total_pairs: totalPairs,
          sft_records: sftRecords,
          pct,
          training_status: trainingStatus,
        };
      });

      res.status(200).json({
        threshold: VERIFIED_DPO_THRESHOLD,
        domains,
      });
    } catch (err: unknown) {
      logger.error({ err }, "flywheel.ts: status query failed");
      res.status(500).json({ error: "Flywheel status query failed" });
    }
  },
);

export default router;
