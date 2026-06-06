/**
 * legalCounsel/runStore.ts — Async counsel run store.
 *
 * Supports two modes:
 *   1. Sync: caller awaits runLegalCounselAnalyze() directly (short text, fast model).
 *   2. Async: caller gets run_id immediately; background job updates row on completion.
 *
 * counsel_runs table is created in index.ts startup migration.
 */

import { randomUUID, createHash } from "crypto";
import { pool } from "@workspace/db";
import { logger } from "../logger.js";

export type RunStatus = "running" | "done" | "failed";

export interface CounselRunRow {
  id: string;
  input_sha256: string;
  perspective: string;
  status: RunStatus;
  counsel_mode: string;
  result: unknown | null;
  error: string | null;
  grounded_count: number | null;
  grounded_ratio: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export function hashInput(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function createCounselRun(opts: {
  perspective: string;
  inputSha256: string;
  counselMode: string;
}): Promise<string> {
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO counsel_runs (id, input_sha256, perspective, status, counsel_mode, created_at)
       VALUES ($1, $2, $3, 'running', $4, now())`,
      [id, opts.inputSha256, opts.perspective, opts.counselMode],
    );
  } catch (err) {
    logger.warn({ err }, "runStore: failed to insert counsel_run row — continuing without receipt");
  }
  return id;
}

export async function completeCounselRun(opts: {
  runId: string;
  result: unknown;
  groundedCount: number;
  groundedRatio: number;
}): Promise<void> {
  try {
    await pool.query(
      `UPDATE counsel_runs
       SET status = 'done', result = $2, grounded_count = $3, grounded_ratio = $4, completed_at = now()
       WHERE id = $1`,
      [opts.runId, JSON.stringify(opts.result), opts.groundedCount, opts.groundedRatio],
    );
  } catch (err) {
    logger.warn({ err }, "runStore: failed to update counsel_run row");
  }
}

export async function failCounselRun(runId: string, error: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE counsel_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
      [runId, error],
    );
  } catch (err) {
    logger.warn({ err }, "runStore: failed to mark counsel_run as failed");
  }
}

export async function getCounselRun(runId: string): Promise<CounselRunRow | null> {
  try {
    const res = await pool.query<CounselRunRow>(
      `SELECT id, input_sha256, perspective, status, counsel_mode, result, error,
              grounded_count, grounded_ratio, created_at, completed_at
       FROM counsel_runs WHERE id = $1`,
      [runId],
    );
    return res.rows[0] ?? null;
  } catch (err) {
    logger.warn({ err }, "runStore: failed to fetch counsel_run row");
    return null;
  }
}
