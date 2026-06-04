/**
 * legal.clause.draft.ts
 *
 * POST /api/v1/legal/clause/draft
 *
 * Turns a previously analyzed clause into improved contract text.
 *
 * Two input modes:
 *   A. run_id + clause_id  — fetches analysis from semantic_clause_analyses table
 *   B. inline              — caller provides all fields directly (no prior run needed)
 *
 * Vault writes (via draftAgent.ts):
 *   zie_training_records  — domain=legal, task_type=legal_clause_draft, source_kind=draft_agent
 *   zie_preference_pairs  — chosen=improved_text, rejected=original_text, preference_source=draft_agent
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { draftClause } from "../lib/draftAgent.js";

const router = Router();

// ── Request schema ────────────────────────────────────────────────────────────

const DraftRequestSchema = z.union([
  // Mode A: fetch from DB by run_id + clause_id
  z.object({
    mode: z.literal("from_run").optional().default("from_run"),
    run_id: z.string().uuid("run_id must be a UUID"),
    clause_id: z.string().min(1),
    original_text: z.string().min(1).optional(),  // override if provided
    tenant_id: z.string().optional(),
  }),
  // Mode B: inline — all fields provided directly
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
]);

// ── POST /api/v1/legal/clause/draft ──────────────────────────────────────────

router.post(
  "/api/v1/legal/clause/draft",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = DraftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;

    try {
      let draftInput: Parameters<typeof draftClause>[0];

      if (body.mode === "inline") {
        // Mode B — all fields provided
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
        // Mode A — fetch from semantic_clause_analyses
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

        // Fetch original text from the run's document if not overridden
        // (stored in semantic_clause_analysis_runs.document_text if that column exists,
        //  otherwise caller must provide original_text override)
        const originalText = body.original_text ?? `[Original ${row.clause_label} clause — provide original_text for best results]`;

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
        vault_written: true,  // SFT + DPO pair written async
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
