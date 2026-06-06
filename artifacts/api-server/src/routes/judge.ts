/**
 * judge.ts — HTTP routes for LLM-as-judge (implementation in lib/judgePair.ts).
 */

import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { judgePairById, type JudgeResult } from "../lib/judgePair.js";

const router = Router();

function sendJudgeResult(res: Response, result: JudgeResult): void {
  switch (result.kind) {
    case "ok":
      res.status(200).json(result.receipt);
      return;
    case "already_verified":
      res.status(200).json({
        ok: true,
        pair_id: result.pair_id,
        already_verified: true,
        message: "Pair already judge-verified — skipping re-evaluation",
      });
      return;
    case "not_found":
      res.status(404).json({ error: `Pair ${result.pair_id} not found` });
      return;
    case "llm_failed":
      res.status(502).json({ error: "Judge LLM failed after all fallbacks" });
      return;
    case "persist_failed":
      res.status(500).json({ error: "Failed to persist judge evaluation bridge" });
      return;
  }
}

router.post(
  "/v1/judge/pair/:pairId",
  async (req: Request, res: Response): Promise<void> => {
    const { pairId } = req.params;
    const result = await judgePairById(pairId, pool);
    sendJudgeResult(res, result);
  },
);

router.post(
  "/v1/judge/latest",
  async (req: Request, res: Response): Promise<void> => {
    const domain =
      typeof req.query.domain === "string" ? req.query.domain : undefined;

    const row = await pool.query<{ id: string }>(
      `SELECT id
       FROM zie_preference_pairs
       WHERE judge_verified = false${domain ? " AND domain = $1" : ""}
       ORDER BY created_at DESC
       LIMIT 1`,
      domain ? [domain] : [],
    );

    if (row.rows.length === 0) {
      res
        .status(404)
        .json({ error: "No unverified pairs found", domain: domain ?? "any" });
      return;
    }

    const result = await judgePairById(row.rows[0].id, pool);
    sendJudgeResult(res, result);
  },
);

export default router;
