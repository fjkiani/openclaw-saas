/**
 * flywheel.ts
 *
 * GET /api/v1/legal/flywheel/status
 *
 * Returns per-domain, per-task_type progress toward the training threshold.
 * Used by CounselUI History tab to show the flywheel progress bar.
 *
 * Response shape:
 * {
 *   threshold: 50,
 *   domains: [
 *     {
 *       domain: "legal",
 *       task_type: "legal_clause_analysis",
 *       verified_pairs: 1,
 *       total_pairs: 1,
 *       sft_records: 1,
 *       pct: 2,
 *       training_status: "accumulating" | "threshold_met" | "training" | "deployed"
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

router.get(
  "/api/v1/legal/flywheel/status",
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

      // Build lookup maps
      const sftByTaskType = new Map<string, number>();
      for (const row of sftRes.rows) {
        sftByTaskType.set(`${row.domain}:${row.task_type}`, parseInt(row.sft_records, 10));
      }

      const jobStatusByTaskType = new Map<string, string>();
      for (const row of jobRes.rows) {
        if (row.task_type) jobStatusByTaskType.set(row.task_type, row.status);
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
