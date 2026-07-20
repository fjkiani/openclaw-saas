/**
 * regressionSuite.ts — gated regression harness.
 *
 * On adapter promotion (from workflow.ts::promote) we run the active regression
 * suite for (mcp_slug, tool_name), score each response against the rubric, and
 * BLOCK the promotion if either:
 *   - pass rate < PASS_RATE_MIN (default 0.80), or
 *   - pass rate dropped > PASS_RATE_DROP (default 0.05) vs the last baseline run.
 *
 * Rubric fields (per suite row):
 *   {
 *     "must_include": ["...", "..."],           // OR-set of tokens (soft)
 *     "must_not_include": ["..."],              // hard fail if any hit
 *     "min_length": 20,
 *     "max_length": 2000
 *   }
 */
import { pool } from "@workspace/db";
import { runInference } from "./modal/inferenceClient.js";
import { logger } from "./logger.js";

export const PASS_RATE_MIN = Number(process.env.REGRESSION_PASS_RATE_MIN ?? 0.8);
export const PASS_RATE_DROP = Number(process.env.REGRESSION_PASS_RATE_DROP ?? 0.05);

export interface RegressionCaseResult {
  suite_id: number;
  category: string | null;
  pass: boolean;
  score: number;
  actual: string;
  reasoning: string;
}

export interface RegressionSummary {
  total: number;
  passed: number;
  pass_rate: number;
  baseline_pass_rate: number | null;
  drop: number | null;
  gate_ok: boolean;
  gate_reason: string[];
  cases: RegressionCaseResult[];
}

function score_case(
  actual: string,
  rubric: Record<string, unknown>,
  gold: string | null
): { pass: boolean; score: number; reasoning: string } {
  const text = actual.trim();
  const must_include = (rubric.must_include as string[]) ?? [];
  const must_not_include = (rubric.must_not_include as string[]) ?? [];
  const min_length = Number(rubric.min_length ?? 0);
  const max_length = Number(rubric.max_length ?? 100000);

  const hits = must_include.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
  const forbidden = must_not_include.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
  const lenOK = text.length >= min_length && text.length <= max_length;

  let score = 0;
  if (must_include.length > 0) score += 0.5 * (hits.length / must_include.length);
  else score += 0.5;
  if (forbidden.length === 0) score += 0.3;
  if (lenOK) score += 0.2;

  // Gold-response substring match — bonus if any 20-char slice of gold appears.
  if (gold) {
    const slice = gold.trim().slice(0, 20).toLowerCase();
    if (slice.length >= 4 && text.toLowerCase().includes(slice)) {
      score = Math.min(1.0, score + 0.1);
    }
  }
  score = Math.max(0, Math.min(1.0, score));

  const pass = forbidden.length === 0 && score >= 0.6 && lenOK;
  const parts: string[] = [];
  if (must_include.length) parts.push(`hits ${hits.length}/${must_include.length}`);
  if (forbidden.length) parts.push(`forbidden hit: ${forbidden.join(",")}`);
  if (!lenOK) parts.push(`len ${text.length} not in [${min_length}, ${max_length}]`);
  return { pass, score: Number(score.toFixed(3)), reasoning: parts.join("; ") || "ok" };
}

export async function runRegression(
  mcp_slug: string,
  tool_name: string,
  adapter_id: string | null
): Promise<RegressionSummary> {
  const suite = await pool.query(
    `SELECT id, prompt, gold_response, rubric, category
     FROM zie_regression_suite
     WHERE mcp_slug=$1 AND tool_name=$2 AND active=true`,
    [mcp_slug, tool_name]
  );

  const cases: RegressionCaseResult[] = [];
  for (const row of suite.rows) {
    let actual = "";
    try {
      const inf = await runInference({
        mcp_slug,
        tool_name,
        prompt: row.prompt,
        adapter_id: adapter_id ?? undefined,
        max_new_tokens: 96,
      });
      actual = inf.completion || "";
    } catch (err) {
      actual = `[inference error: ${(err as Error).message}]`;
    }
    const scored = score_case(actual, row.rubric ?? {}, row.gold_response ?? null);
    cases.push({
      suite_id: row.id,
      category: row.category,
      pass: scored.pass,
      score: scored.score,
      actual,
      reasoning: scored.reasoning,
    });
    await pool.query(
      `INSERT INTO zie_regression_runs (suite_id, adapter_id, pass, score, actual_response, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, adapter_id, scored.pass, scored.score, actual, scored.reasoning]
    );
  }

  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  const pass_rate = total ? passed / total : 1;

  // Baseline lookup: median pass_rate over previous distinct adapter runs.
  const baselineQ = await pool.query(
    `SELECT AVG(CASE WHEN pass THEN 1 ELSE 0 END)::float AS pr
     FROM zie_regression_runs
     WHERE suite_id IN (SELECT id FROM zie_regression_suite WHERE mcp_slug=$1 AND tool_name=$2)
       AND ($3::text IS NULL OR adapter_id IS DISTINCT FROM $3)`,
    [mcp_slug, tool_name, adapter_id]
  );
  const baseline_pass_rate = baselineQ.rows[0]?.pr ?? null;
  const drop = baseline_pass_rate !== null ? Number((baseline_pass_rate - pass_rate).toFixed(3)) : null;

  const gate_reason: string[] = [];
  let gate_ok = true;
  if (pass_rate < PASS_RATE_MIN) {
    gate_ok = false;
    gate_reason.push(`pass_rate ${pass_rate.toFixed(2)} < ${PASS_RATE_MIN}`);
  }
  if (drop !== null && drop > PASS_RATE_DROP) {
    gate_ok = false;
    gate_reason.push(`regression drop ${drop.toFixed(3)} > ${PASS_RATE_DROP}`);
  }
  if (total === 0) {
    // No suite → treat as neutral (don't block, but flag).
    gate_ok = true;
    gate_reason.push("no active regression cases for bucket");
  }

  return {
    total,
    passed,
    pass_rate: Number(pass_rate.toFixed(3)),
    baseline_pass_rate: baseline_pass_rate !== null ? Number(baseline_pass_rate.toFixed(3)) : null,
    drop,
    gate_ok,
    gate_reason,
    cases,
  };
}
