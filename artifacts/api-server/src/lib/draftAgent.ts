/**
 * draftAgent.ts
 *
 * ZIE Legal Drafting Agent — turns clause analysis output into improved contract text.
 *
 * Input:  one analyzed clause (from semanticLegalAnalyzer / semantic_clause_analyses table)
 * Output: improved clause text + change summary + vault writes (SFT + DPO pair)
 *
 * Vault writes per draft call:
 *   zie_training_records  — domain=legal, task_type=legal_clause_draft, source_kind=draft_agent
 *   zie_preference_pairs  — chosen=improved_text, rejected=original_text, preference_source=draft_agent
 *
 * This is what feeds the flywheel for the legal DRAFTING capability specifically.
 * At 50 judge-verified drafting pairs → Modal fires a fine-tune on legal_clause_draft.
 */

import crypto from "crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import { invokeWithFallback, type ModelRouteConfig } from "./modelRouter.js";
import { z } from "zod";

// ── Model chain ───────────────────────────────────────────────────────────────
// Same quality tier as judge: Groq 70B first, OR 120B fallback.

const DRAFT_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 1024,
    timeoutMs: 25_000,
    tags: ["70b", "draft-primary"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 1024,
    timeoutMs: 55_000,
    tags: ["120b", "draft-fallback"],
  },
];

// ── I/O types ─────────────────────────────────────────────────────────────────

export interface DraftClauseInput {
  clauseId: string;
  clauseLabel: string;
  docClass: string;
  originalText: string;          // the clause text from the submitted document
  semanticPosition: string;      // from PremiumClauseAnalysis / SemanticClauseAnalysis
  riskLevel: string;             // critical | high | medium | low | none
  targetRedline?: string;        // from PremiumClauseAnalysis (premium only)
  recommendedAction: string;
  rationale: string;
  tenantId?: string;
  workspaceId?: number;
}

export interface DraftClauseOutput {
  clauseId: string;
  clauseLabel: string;
  improvedText: string;          // actual contract language — not commentary
  changesSummary: string;        // 1-3 sentences: what changed and why
  riskReduction: "eliminated" | "reduced" | "flagged_for_counsel";
  confidence: number;
  modelUsed: string;
}

// ── Zod schema for LLM output ─────────────────────────────────────────────────

const DraftOutputSchema = z.object({
  improved_text: z.string().min(20, "improved_text must be at least 20 characters"),
  changes_summary: z
    .string()
    .min(20, "changes_summary must be at least 20 characters")
    .max(500, "changes_summary must be at most 500 characters"),
  risk_reduction: z.enum(["eliminated", "reduced", "flagged_for_counsel"]),
  confidence: z.number().min(0).max(1),
});

// ── System prompt ─────────────────────────────────────────────────────────────

const DRAFT_SYSTEM_PROMPT = `You are a contract drafter, not an analyst. Your job is to rewrite a specific contract clause to reduce legal risk.

You will receive:
- The original clause text
- The risk level and semantic position from prior analysis
- The recommended action and target redline from the analysis
- The rationale explaining what is wrong

Your output must be:
1. improved_text: The rewritten clause in proper contract language. This is actual contract text, not commentary. Use formal legal drafting style. Do not include explanations inside the clause text.
2. changes_summary: 1-3 sentences explaining what you changed and why. Be specific — name the exact terms, percentages, or provisions you modified.
3. risk_reduction: One of "eliminated" (risk is fully addressed), "reduced" (risk is materially lowered but human review still advised), or "flagged_for_counsel" (risk requires attorney judgment — provide best-effort draft only).
4. confidence: Float 0.0-1.0 reflecting your confidence in the improved text.

Rules:
- Output ONLY valid JSON. No markdown. No prose outside the JSON.
- improved_text must be standalone contract language — a party should be able to paste it directly into an agreement.
- If the original clause is absent (not present in the document), draft a complete clause from scratch.
- Do not hedge inside improved_text. Hedging belongs in changes_summary.
- If risk_level is "critical" and you cannot fully eliminate the risk, set risk_reduction to "flagged_for_counsel".

Output format:
{
  "improved_text": "<contract language>",
  "changes_summary": "<1-3 sentences>",
  "risk_reduction": "eliminated|reduced|flagged_for_counsel",
  "confidence": 0.0-1.0
}`;

// ── hashPrompt ────────────────────────────────────────────────────────────────

function hashPrompt(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ── draftClause ───────────────────────────────────────────────────────────────

export async function draftClause(input: DraftClauseInput): Promise<DraftClauseOutput> {
  const {
    clauseId,
    clauseLabel,
    docClass,
    originalText,
    semanticPosition,
    riskLevel,
    targetRedline,
    recommendedAction,
    rationale,
    tenantId = "system",
    workspaceId,
  } = input;

  // Build user content for the LLM
  const userContent = JSON.stringify({
    clause_id: clauseId,
    clause_label: clauseLabel,
    doc_class: docClass,
    original_text: originalText,
    semantic_position: semanticPosition,
    risk_level: riskLevel,
    target_redline: targetRedline ?? null,
    recommended_action: recommendedAction,
    rationale_summary: rationale,
  });

  const promptHash = hashPrompt(`legal_clause_draft:${docClass}:${clauseId}:${originalText.slice(0, 500)}`);

  // ── Invoke model ──────────────────────────────────────────────────────────
  let draftOutput: z.infer<typeof DraftOutputSchema>;
  let modelUsed: string;

  const result = await invokeWithFallback<z.infer<typeof DraftOutputSchema>>(
    {
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      userContent,
      title: `OpenClaw Draft Agent - ${clauseLabel}`,
      maxTokens: 1024,
      temperature: 0.2,  // slight creativity for drafting, not zero like judge
    },
    DRAFT_CHAIN,
    {
      validator: (raw) => DraftOutputSchema.parse(raw),
      routeChainId: "zie-draft-agent",
      schemaType: "seo",  // bypass legal-specific detectUnusableOutput (different schema)
    },
  );
  draftOutput = result.parsed;
  modelUsed = result.model_used;

  // ── Vault writes (SFT + DPO pair) ─────────────────────────────────────────
  // Both writes are fire-and-forget — they never block the response.
  setImmediate(async () => {
    try {
      const promptJson = JSON.stringify({ clause_id: clauseId, doc_class: docClass, original_text: originalText });
      const responseJson = JSON.stringify(draftOutput);

      // SFT record
      await pool.query(
        `INSERT INTO zie_training_records
           (domain, task_type, source_kind, quality_score, prompt_hash,
            prompt_json, remote_response_json)
         VALUES ('legal', 'legal_clause_draft', 'draft_agent', $1, $2, $3, $4)
         ON CONFLICT (prompt_hash) DO NOTHING`,
        [draftOutput.confidence, promptHash, promptJson, responseJson],
      );

      // DPO preference pair: chosen=improved_text, rejected=original_text
      // This is what feeds the flywheel for the drafting task specifically.
      await pool.query(
        `INSERT INTO zie_preference_pairs
           (domain, task_type, preference_source,
            prompt_hash, chosen_response_json, rejected_response_json,
            source_kind)
         VALUES ('legal', 'legal_clause_draft', 'draft_agent',
                 $1, $2, $3, 'draft_agent')`,
        [
          promptHash,
          JSON.stringify({ text: draftOutput.improved_text, changes_summary: draftOutput.changes_summary }),
          JSON.stringify({ text: originalText, reason: "original — pre-improvement" }),
        ],
      );

      logger.info(
        { clauseId, docClass, promptHash, confidence: draftOutput.confidence },
        "draftAgent: vault writes complete (SFT + DPO pair)",
      );
    } catch (vaultErr) {
      logger.error({ vaultErr, clauseId }, "draftAgent: vault write failed (non-blocking)");
    }
  });

  return {
    clauseId,
    clauseLabel,
    improvedText: draftOutput.improved_text,
    changesSummary: draftOutput.changes_summary,
    riskReduction: draftOutput.risk_reduction,
    confidence: draftOutput.confidence,
    modelUsed,
  };
}
