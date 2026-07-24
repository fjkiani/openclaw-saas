/**
 * capture.ts — persist a completed Rigor-Gate run into the behavioral lake.
 *
 * Writes ONE zie_rigor_records row (prompt_hash UNIQUE → idempotent, re-running
 * the same prompt does not duplicate) and, when the run was a genuine
 * reject→correct cycle (a captured slop distinct from the rigorous final), ONE
 * zie_preference_pairs row with preference_source="rigor_gate" so the existing
 * judge/exporter/promotion tooling picks it up unchanged.
 *
 * zie_preference_pairs has no UNIQUE(prompt_hash), so we guard the pair insert
 * on the rigor_records insert having actually happened (xmax=0 ⇒ fresh insert),
 * which gives us the same no-duplicate guarantee for the pair.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import type { ExecutorEnvelope, RigorRunResult } from "./types.js";

function renderForPair(env: ExecutorEnvelope | null): string {
  if (!env) return "";
  const parts: string[] = [];
  if (env.answer_text) parts.push(env.answer_text);
  for (const a of env.artifacts ?? []) parts.push(`\n\n\`\`\`${a.name}\n${a.content}\n\`\`\``);
  return parts.join("");
}

export interface CaptureResult {
  recorded: boolean;
  duplicate: boolean;
  dpo_pair_written: boolean;
}

export async function captureRun(
  result: RigorRunResult,
  promptText: string,
): Promise<CaptureResult> {
  const scoreBefore = result.rigor_score_before;
  const scoreAfter = result.rigor_score_after;
  const lastVerdicts =
    result.attempts.length > 0
      ? result.attempts[result.attempts.length - 1].panel.verdicts
      : [];

  try {
    // Insert the record; RETURNING (xmax = 0) tells us whether this was a fresh
    // insert (true) or a conflict-skip (the row already existed).
    const insertRes = await pool.query(
      `INSERT INTO zie_rigor_records
         (task_type, house_model, prompt_hash, prompt_json, slop_output_json,
          guardian_verdicts_json, corrected_output_json, attempts, model_path,
          executor_path, rigor_score_before, rigor_score_after, escalated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (prompt_hash) DO NOTHING
       RETURNING (xmax = 0) AS inserted`,
      [
        result.task_type,
        result.house_model,
        result.prompt_hash,
        JSON.stringify({ prompt: promptText }),
        JSON.stringify(result.slop_envelope ?? {}),
        JSON.stringify(lastVerdicts),
        JSON.stringify(result.final_envelope),
        result.n_attempts,
        JSON.stringify(result.model_path),
        result.executor_path,
        scoreBefore,
        scoreAfter,
        result.escalated,
      ],
    );

    const freshInsert = (insertRes.rowCount ?? 0) > 0;
    if (!freshInsert) {
      return { recorded: false, duplicate: true, dpo_pair_written: false };
    }

    // DPO pair only for a real reject→correct cycle that PASSED (not escalated),
    // with a captured slop distinct from the rigorous final.
    let dpoWritten = false;
    const chosen = renderForPair(result.final_envelope);
    const rejected = renderForPair(result.slop_envelope);
    if (!result.escalated && result.slop_envelope && chosen && rejected && chosen !== rejected) {
      await pool.query(
        `INSERT INTO zie_preference_pairs
           (task_type, domain, source_kind, preference_source, prompt_hash,
            chosen_response_json, rejected_response_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          result.task_type,
          "rigor",
          "rigor_gate",
          "rigor_gate",
          result.prompt_hash,
          JSON.stringify({ text: chosen, envelope: result.final_envelope }),
          JSON.stringify({ text: rejected, envelope: result.slop_envelope }),
        ],
      );
      dpoWritten = true;
    }

    return { recorded: true, duplicate: false, dpo_pair_written: dpoWritten };
  } catch (err) {
    logger.error({ err: String(err), run_id: result.run_id }, "[rigor.capture] persist failed");
    return { recorded: false, duplicate: false, dpo_pair_written: false };
  }
}
