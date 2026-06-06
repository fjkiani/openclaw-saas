/**
 * legal.clause.draft.ts
 *
 * POST /api/v1/legal/clause/draft
 *
 * Modes:
 *   from_run  — fetch analysis from semantic_clause_analyses
 *   inline    — caller provides all clause fields
 *   generate  — clause_type + context + instructions (mode optional if clause_type present)
 *
 * Vault writes return a DB receipt (pair_id, vault_written) — not hardcoded.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { draftClause, generateAgreement } from "../lib/draftAgent.js";
import type { VaultWriteReceipt } from "../lib/draftVault.js";

const router = Router();

/** Accept agent runbook shape: clause_type + instructions without explicit mode. */
function normalizeDraftBody(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  if (
    body.mode === undefined &&
    typeof body.clause_type === "string" &&
    typeof body.instructions === "string" &&
    body.instructions.length >= 10
  ) {
    return { ...body, mode: "generate" };
  }
  return raw;
}

const DraftRequestSchema = z.union([
  z.object({
    mode: z.literal("from_run").optional().default("from_run"),
    run_id: z.string().uuid("run_id must be a UUID"),
    clause_id: z.string().min(1),
    original_text: z.string().min(1).optional(),
    tenant_id: z.string().optional(),
  }),
  z.object({
    mode: z.literal("inline"),
    clause_id: z.string().min(1),
    clause_label: z.string().min(1),
    doc_class: z.string().min(1),
    original_text: z.string().min(1),
    semantic_position: z.string().min(1),
    risk_level: z.string().min(1),
    target_redline: z.string().optional(),
    recommended_action: z.string().min(1),
    rationale: z.string().min(1),
    tenant_id: z.string().optional(),
  }),
  z.object({
    mode: z.literal("generate"),
    clause_type: z.string().min(1),
    context: z.record(z.unknown()).optional().default({}),
    instructions: z.string().min(10),
    tenant_id: z.string().optional(),
  }),
]);

function vaultFields(vault: VaultWriteReceipt) {
  return {
    vault_written: vault.vault_written,
    vault: {
      prompt_hash: vault.prompt_hash,
      pair_id: vault.pair_id,
      sft_inserted: vault.sft_inserted,
      dpo_inserted: vault.dpo_inserted,
      task_type: vault.task_type,
      domain: vault.domain,
    },
  };
}

router.post(
  "/v1/legal/clause/draft",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = DraftRequestSchema.safeParse(normalizeDraftBody(req.body));
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;

    try {
      if (body.mode === "generate") {
        const genOutput = await generateAgreement({
          clauseType: body.clause_type,
          context: body.context ?? {},
          instructions: body.instructions,
          tenantId: body.tenant_id,
        });
        res.status(200).json({
          ok: true,
          clause_type: genOutput.clauseType,
          improved_text: genOutput.improvedText,
          changes_summary: genOutput.changesSummary,
          risk_reduction: genOutput.riskReduction,
          confidence: genOutput.confidence,
          model_used: genOutput.modelUsed,
          ...vaultFields(genOutput.vault),
        });
        return;
      }

      let draftInput: Parameters<typeof draftClause>[0];

      if (body.mode === "inline") {
        draftInput = {
          clauseId: body.clause_id,
          clauseLabel: body.clause_label,
          docClass: body.doc_class,
          originalText: body.original_text,
          semanticPosition: body.semantic_position,
          riskLevel: body.risk_level,
          targetRedline: body.target_redline,
          recommendedAction: body.recommended_action,
          rationale: body.rationale,
          tenantId: body.tenant_id,
        };
      } else {
        const clauseRow = await pool.query<{
          clause_id: string;
          clause_label: string;
          doc_class: string;
          semantic_position: string;
          risk_level: string;
          rationale_summary: string;
          recommended_action: string;
          target_redline: string | null;
        }>(
          `SELECT a.clause_id, a.clause_label, r.doc_class,
                  a.semantic_position, a.risk_level,
                  a.rationale_summary, a.recommended_action,
                  a.target_redline
           FROM semantic_clause_analyses a
           JOIN semantic_clause_analysis_runs r ON r.run_id = a.run_id
           WHERE r.run_id = $1 AND a.clause_id = $2
           LIMIT 1`,
          [body.run_id, body.clause_id],
        );

        if (clauseRow.rows.length === 0) {
          res.status(404).json({
            error: `No analysis found for run_id=${body.run_id} clause_id=${body.clause_id}`,
          });
          return;
        }

        const row = clauseRow.rows[0];
        const originalText =
          body.original_text ??
          `[Original ${row.clause_label} clause — provide original_text for best results]`;

        draftInput = {
          clauseId: row.clause_id,
          clauseLabel: row.clause_label,
          docClass: row.doc_class,
          originalText,
          semanticPosition: row.semantic_position,
          riskLevel: row.risk_level,
          targetRedline: row.target_redline ?? undefined,
          recommendedAction: row.recommended_action,
          rationale: row.rationale_summary,
          tenantId: body.tenant_id,
        };
      }

      logger.info(
        { clauseId: draftInput.clauseId, docClass: draftInput.docClass, riskLevel: draftInput.riskLevel },
        "legal.clause.draft: invoking draftAgent",
      );

      const output = await draftClause(draftInput);

      res.status(200).json({
        ok: true,
        clause_id: output.clauseId,
        clause_label: output.clauseLabel,
        improved_text: output.improvedText,
        changes_summary: output.changesSummary,
        risk_reduction: output.riskReduction,
        confidence: output.confidence,
        model_used: output.modelUsed,
        ...vaultFields(output.vault),
      });
    } catch (err: unknown) {
      logger.error({ err }, "legal.clause.draft: unhandled error");
      res.status(502).json({
        error: "Draft agent failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

export default router;
