/**
 * vaultAutoJudge.ts — run LLM judge after vault write (replaces manual-only flow).
 * Set AUTO_JUDGE_VAULT=false to disable.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import { judgePairById } from "./judgePair.js";

export function scheduleAutoJudge(pairId: string, taskType: string): void {
  if (process.env.AUTO_JUDGE_VAULT === "false") {
    return;
  }

  setImmediate(async () => {
    try {
      const result = await judgePairById(pairId, pool);
      if (result.kind === "ok") {
        logger.info(
          {
            pairId,
            taskType,
            judge_verified: result.receipt.judge_verified,
            judge_run_id: result.receipt.judge_run_id,
          },
          "vaultAutoJudge: pair judged",
        );
      } else if (result.kind !== "already_verified") {
        logger.warn({ pairId, taskType, kind: result.kind }, "vaultAutoJudge: judge skipped or failed");
      }
    } catch (err: unknown) {
      logger.error({ err, pairId, taskType }, "vaultAutoJudge: unexpected error");
    }
  });
}
