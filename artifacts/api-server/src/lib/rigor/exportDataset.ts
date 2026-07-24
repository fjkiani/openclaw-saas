/**
 * exportDataset.ts — emit the captured Rigor-Gate lake as training JSONL.
 *
 * Two formats (mirrors the prior double-dip exporter contract):
 *   - dpo: {"prompt","chosen","rejected"}  — preference pairs (rigor beats slop)
 *   - sft: {"messages":[...], "completion"} — supervised fine-tune on the rigorous final
 *
 * Source of truth is zie_rigor_records (one row per gated run, prompt_hash
 * UNIQUE so no duplicates). We read the prompt, the rejected slop envelope, and
 * the corrected final envelope, and serialize their answer_text (+ artifacts
 * summary) as the chosen/rejected strings. No fine-tune is run here (dry phase).
 */
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import type { ExecutorEnvelope } from "./types.js";

export type ExportFormat = "dpo" | "sft";

interface RigorRecordRow {
  prompt_json: unknown;
  slop_output_json: unknown;
  corrected_output_json: unknown;
  task_type: string;
  escalated: boolean;
}

/** Render an envelope into a single training-target string. */
function renderEnvelope(env: Partial<ExecutorEnvelope> | null): string {
  if (!env) return "";
  const parts: string[] = [];
  if (env.answer_text) parts.push(env.answer_text);
  if (env.artifacts && env.artifacts.length > 0) {
    for (const a of env.artifacts) {
      parts.push(`\n\n\`\`\`${a.name}\n${a.content}\n\`\`\``);
    }
  }
  return parts.join("");
}

function promptText(promptJson: unknown): string {
  if (typeof promptJson === "string") return promptJson;
  if (promptJson && typeof promptJson === "object") {
    const p = promptJson as Record<string, unknown>;
    if (typeof p.prompt === "string") return p.prompt;
    if (typeof p.task === "string") return p.task;
  }
  return JSON.stringify(promptJson ?? "");
}

/**
 * Build the JSONL export. For DPO we require BOTH a rejected slop and a distinct
 * chosen final (a reject→correct cycle). For SFT we emit every record that has a
 * non-empty corrected final. Returns the JSONL string (one object per line).
 */
export async function exportDataset(format: ExportFormat, limit = 10000): Promise<{
  jsonl: string;
  count: number;
}> {
  let rows: RigorRecordRow[] = [];
  try {
    const res = await pool.query(
      `SELECT prompt_json, slop_output_json, corrected_output_json, task_type, escalated
         FROM zie_rigor_records
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    rows = res.rows as RigorRecordRow[];
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor.export] DB read failed");
    return { jsonl: "", count: 0 };
  }

  const lines: string[] = [];
  for (const r of rows) {
    const prompt = promptText(r.prompt_json);
    const chosen = renderEnvelope(r.corrected_output_json as Partial<ExecutorEnvelope> | null);
    const rejected = renderEnvelope(r.slop_output_json as Partial<ExecutorEnvelope> | null);

    if (format === "dpo") {
      // A valid preference pair needs a rejected slop AND a distinct chosen.
      if (!chosen || !rejected || chosen === rejected) continue;
      lines.push(JSON.stringify({ prompt, chosen, rejected }));
    } else {
      // SFT trains on the rigorous final only.
      if (!chosen) continue;
      lines.push(
        JSON.stringify({
          messages: [
            { role: "system", content: "You are a rigorous, anti-slop assistant. Back every claim with an artifact; state numbers that match your artifacts; be decisive." },
            { role: "user", content: prompt },
          ],
          completion: chosen,
        }),
      );
    }
  }

  return { jsonl: lines.join("\n"), count: lines.length };
}
