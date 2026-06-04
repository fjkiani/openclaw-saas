/**
 * semanticLegalAnalyzer.ts
 *
 * Semantic Law Counsel v1 — Shadow-mode orchestrator + ZIE Factory integration.
 *
 * runSemanticShadow() is called fire-and-forget from legal.ts after the
 * deterministic pipeline completes. It never throws into the caller.
 *
 * ZIE Factory integration (v2):
 *   For each clause analyzed, the result is also fed into executeDoubleDip()
 *   using task_type = "legal_clause_analysis". This means:
 *     - The 120B output for each clause is stolen into zie_training_records
 *     - The local vs 120B comparison is stored in zie_preference_pairs
 *     - Once 200 SFT + 100 DPO pairs accumulate, checkThresholdsAndDispatch()
 *       triggers Modal to fine-tune the local model on legal clause analysis
 *     - After training, updateRoutingPolicy() points the fast path at the
 *       newly trained LoRA adapter, reducing OpenRouter spend for legal clauses
 *
 * Flow:
 *   1. Map specialist → SemanticDocClass via SPECIALIST_TO_DOC_CLASS
 *   2. Guard: skip unsupported doc classes ("nda", "default")
 *   3. Get route policy → build full model chain
 *   4. Insert semantic_clause_analysis_runs row (status = "running")
 *   5. Detect clauses via reviewDocumentCoverage
 *   6. For each clause: invoke model, validate schema, persist result
 *   7. Feed each clause result into executeDoubleDip() for vault capture
 *   8. Update run row to "completed" (or "failed" on unhandled error)
 */

import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import { reviewDocumentCoverage } from "./documentCoverage.js";
import {
  invokeWithFallback,
  RouterExhaustedError,
  type ModelInvocationInput,
} from "./modelRouter.js";
import {
  classifyModelResponse,
  detectUnusableOutput,
  SemanticClauseAnalysisSchema,
  PremiumClauseAnalysisSchema,
  type SemanticClauseAnalysis,
  type PremiumClauseAnalysis,
} from "./semanticClauseSchema.js";
import {
  getRoutePolicy,
  buildFullChain,
  type SemanticDocClass,
} from "./routePolicy.js";
import type { DocClass } from "./draftReceiptEngine.js";
import { executeDoubleDip, hashPrompt } from "./doubleDipRouter.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const SEMANTIC_PROMPT_VERSION = "semantic-v1.0";
export const LEGAL_TASK_TYPE = "legal_clause_analysis";

export const SPECIALIST_TO_DOC_CLASS: Record<string, SemanticDocClass> = {
  cofounder: "co_founder_agreement",
  // contractor: "contractor_ip_assignment",
  // advisor:    "advisor_agreement",
};

const UNSUPPORTED_DOC_CLASSES: SemanticDocClass[] = ["nda", "default"];

// ── ZIE Factory: Legal clause → SlopSchema bridge ────────────────────────────
//
// The ZIE vault uses SlopSchema for all domains. For legal clauses, we map:
//   risk_level critical/high → severity critical/high
//   semantic_position        → tag (overclaiming if absent, thin_methods if weak)
//   rationale_summary        → evidenceSpans (split into sentences as evidence)
//
// This bridge lets the same vault, DPO pairs, and Modal training loop serve
// both Manuscript and Legal domains without separate schemas.

function legalClauseToSlopPayload(
  clauseLabel: string,
  clauseText: string,
  docClass: string,
): { text: string; domain: string; clause_label: string } {
  return {
    text: clauseText,
    domain: "legal",
    clause_label: clauseLabel,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildRouteChainId(policy: ReturnType<typeof getRoutePolicy>): string {
  return `${policy.docClass}:${policy.riskTier}:${SEMANTIC_PROMPT_VERSION}`;
}

function resolveDocClass(specialist: string): SemanticDocClass {
  return SPECIALIST_TO_DOC_CLASS[specialist] ?? "default";
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildClauseInvocationInput(
  clauseId: string,
  clauseLabel: string,
  docClass: string,
  documentText: string,
  schemaType: "standard" | "premium",
  routeChainId: string,
): ModelInvocationInput {
  const schemaVersion = schemaType === "premium" ? "premium-v1" : "standard-v1";

  const standardFields = `{
  "clause_id": "${clauseId}",
  "clause_label": "${clauseLabel}",
  "semantic_position": "<high_leverage|acceptable|below_minimum|absent|needs_review|unknown>",
  "risk_level": "<critical|high|medium|low|none>",
  "rationale_summary": "<50-300 words, specific — no filler phrases>",
  "recommended_action": "<actionable, references specific clause or term>",
  "confidence": <0.0-1.0>,
  "flags": [],
  "prompt_version": "${SEMANTIC_PROMPT_VERSION}",
  "schema_version": "${schemaVersion}",
  "route_chain_id": "${routeChainId}"
}`;

  const premiumFields = `{
  "clause_id": "${clauseId}",
  "clause_label": "${clauseLabel}",
  "semantic_position": "<high_leverage|acceptable|below_minimum|absent|needs_review|unknown>",
  "risk_level": "<critical|high|medium|low|none>",
  "rationale_summary": "<75-400 words, specific — no filler phrases>",
  "precedent_or_market_norm_note": "<references specific norm, standard, or jurisdiction>",
  "target_redline": "<specific clause or term to change>",
  "key_risk_if_accepted": "<specific legal or financial risk>",
  "recommended_action": "<actionable, references specific clause or term>",
  "confidence": <0.0-1.0>,
  "requires_human_review": true,
  "flags": [],
  "prompt_version": "${SEMANTIC_PROMPT_VERSION}",
  "schema_version": "${schemaVersion}",
  "route_chain_id": "${routeChainId}"
}`;

  return {
    systemPrompt:
      `You are a legal clause analyst specializing in startup agreements. ` +
      `Analyze the specified clause and return ONLY valid JSON. No markdown fences, no prose outside the JSON object. ` +
      `Be specific — do not use generic filler language. ` +
      `rationale_summary must reference specific provisions, parties, or risks found (or absent) in the document.`,
    userContent:
      `Document type: ${docClass}\n` +
      `Clause to analyze: ${clauseLabel} (id: ${clauseId})\n\n` +
      `Return this exact JSON structure:\n${schemaType === "premium" ? premiumFields : standardFields}\n\n` +
      `Rules:\n` +
      `- If the clause is absent, set semantic_position to "absent" and risk_level to "high" or "critical".\n` +
      `- rationale_summary must be specific — name the exact missing provisions or risks.\n` +
      `- Return ONLY valid JSON.\n\n` +
      `Document text (truncated to 8000 chars):\n---\n${documentText.slice(0, 8000)}\n---\n\n` +
      `Analyze the "${clauseLabel}" clause now.`,
    title: `Semantic Law Counsel v1 — ${clauseLabel}`,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function insertRunRow(params: {
  runId: string;
  matterId: string;
  tenantId: string;
  docClass: SemanticDocClass;
  routeChainId: string;
  promptVersion: string;
  status: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO semantic_clause_analysis_runs
       (run_id, matter_id, tenant_id, doc_class, route_chain_id, prompt_version, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      params.runId,
      params.matterId,
      params.tenantId,
      params.docClass,
      params.routeChainId,
      params.promptVersion,
      params.status,
    ],
  );
}

async function updateRunStatus(
  runId: string,
  status: string,
  completedAt = true,
): Promise<void> {
  await pool.query(
    `UPDATE semantic_clause_analysis_runs
        SET status = $1${completedAt ? ", completed_at = NOW()" : ""}
      WHERE run_id = $2`,
    [status, runId],
  );
}

async function insertAnalysisRow(params: {
  analysisId: string;
  runId: string;
  matterId: string;
  clauseId: string;
  clauseLabel: string;
  semanticPosition: string;
  riskLevel: string;
  rationaleSummary: string;
  recommendedAction: string;
  confidence: number;
  flags: string[];
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  rawResponse: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO semantic_clause_analyses
       (analysis_id, run_id, matter_id, clause_id, clause_label,
        risk_level, summary, missing_elements, recommended_action,
        confidence, reasoning, alternative_interpretations,
        model_id, prompt_version, schema_version, raw_response, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
    [
      params.analysisId,
      params.runId,
      params.matterId,
      params.clauseId,
      params.clauseLabel,
      params.riskLevel,
      params.rationaleSummary,
      JSON.stringify(params.flags),
      params.recommendedAction,
      String(params.confidence),
      params.semanticPosition,
      JSON.stringify([]),
      params.modelId,
      params.promptVersion,
      params.schemaVersion,
      params.rawResponse,
    ],
  );
}

async function insertAttemptRow(params: {
  attemptId: string;
  runId: string;
  clauseId: string;
  modelId: string;
  provider: string;
  attemptNumber: number;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO semantic_clause_analysis_attempts
       (attempt_id, run_id, clause_id, model_id, provider,
        attempt_number, status, error_code, error_message, latency_ms, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [
      params.attemptId,
      params.runId,
      params.clauseId,
      params.modelId,
      params.provider,
      params.attemptNumber,
      params.status,
      params.errorCode,
      params.errorMessage,
      params.latencyMs,
    ],
  );
}

// ── ZIE vault capture for legal clauses ──────────────────────────────────────
//
// After the deterministic clause analysis completes, we feed the same clause
// text into executeDoubleDip() with task_type = "legal_clause_analysis".
//
// executeDoubleDip() runs the fast/slow race, Zod-whips the 120B output,
// and persists to zie_training_records + zie_preference_pairs.
//
// This is fire-and-forget — it never blocks the clause analysis pipeline.

function captureClauseForVault(
  clauseLabel: string,
  clauseText: string,
  docClass: string,
): void {
  const payload = legalClauseToSlopPayload(clauseLabel, clauseText, docClass);
  const promptHash = hashPrompt(
    `${LEGAL_TASK_TYPE}:${docClass}:${clauseLabel}:${clauseText.slice(0, 500)}`,
  );

  void executeDoubleDip(payload, promptHash, LEGAL_TASK_TYPE, { domain: "legal", sourceKind: "shadow_hook" }).catch((err: unknown) => {
    logger.warn(
      { err, clauseLabel, docClass },
      "semanticLegalAnalyzer: ZIE vault capture failed for clause (non-fatal)",
    );
  });
}

// ── Core analysis ─────────────────────────────────────────────────────────────

export async function analyzeClausesSemantically(params: {
  runId: string;
  matterId: string;
  tenantId: string;
  documentText: string;
  docClass: DocClass;
  policy: ReturnType<typeof getRoutePolicy>;
}): Promise<void> {
  const { runId, matterId, documentText, docClass, policy } = params;

  const coverage = reviewDocumentCoverage(documentText, docClass);
  const detectedClauses = coverage.detected_clauses;

  if (detectedClauses.length === 0) {
    logger.warn({ runId, matterId, docClass }, "semantic: no clauses detected");
    await updateRunStatus(runId, "completed_no_clauses");
    return;
  }

  const fullChain = buildFullChain(policy);
  const routeChainId = buildRouteChainId(policy);
  let anyFailed = false;

  for (const clause of detectedClauses) {
    const analysisId = crypto.randomUUID();
    const invocationInput = buildClauseInvocationInput(
      clause.clause_id,
      clause.label,
      docClass,
      documentText,
      policy.schemaType,
      routeChainId,
    );

    const t0 = Date.now();
    let invokeResult: Awaited<ReturnType<typeof invokeWithFallback<unknown>>> | null = null;

    try {
      invokeResult = await invokeWithFallback<unknown>(invocationInput, fullChain, {
        routeChainId,
        schemaType: policy.schemaType,
      });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const isExhausted = err instanceof RouterExhaustedError;
      logger.warn({ runId, matterId, clauseId: clause.clause_id, err }, "semantic: router exhausted");

      await insertAttemptRow({
        attemptId: crypto.randomUUID(),
        runId,
        clauseId: clause.clause_id,
        modelId: "exhausted",
        provider: "none",
        attemptNumber: fullChain.length,
        status: isExhausted ? "exhausted" : "error",
        errorCode: isExhausted ? "ROUTER_EXHAUSTED" : "UNKNOWN",
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs,
      });

      anyFailed = true;
      continue;
    }

    const latencyMs = Date.now() - t0;
    const { raw, model_used, provider_used, fallback_count } = invokeResult;

    await insertAttemptRow({
      attemptId: crypto.randomUUID(),
      runId,
      clauseId: clause.clause_id,
      modelId: model_used,
      provider: provider_used,
      attemptNumber: fallback_count + 1,
      status: "success",
      errorCode: null,
      errorMessage: null,
      latencyMs,
    });

    const classification = classifyModelResponse(raw);

    if (classification.kind !== "valid_json") {
      logger.warn({ runId, clauseId: clause.clause_id, kind: classification.kind }, "semantic: non-JSON response");
      anyFailed = true;
      continue;
    }

    const unusableReason = detectUnusableOutput(classification.parsed, policy.schemaType);
    if (unusableReason !== null) {
      logger.warn({ runId, clauseId: clause.clause_id, reason: unusableReason }, "semantic: unusable output");
      anyFailed = true;
      continue;
    }

    const schema =
      policy.schemaType === "premium" ? PremiumClauseAnalysisSchema : SemanticClauseAnalysisSchema;

    const parsed = schema.safeParse(classification.parsed);
    if (!parsed.success) {
      logger.warn({ runId, clauseId: clause.clause_id, issues: parsed.error.issues }, "semantic: schema failed");
      anyFailed = true;
      continue;
    }

    const data = parsed.data as SemanticClauseAnalysis | PremiumClauseAnalysis;

    await insertAnalysisRow({
      analysisId,
      runId,
      matterId,
      clauseId: data.clause_id,
      clauseLabel: data.clause_label,
      semanticPosition: data.semantic_position,
      riskLevel: data.risk_level,
      rationaleSummary: data.rationale_summary,
      recommendedAction: data.recommended_action,
      confidence: data.confidence,
      flags: data.flags ?? [],
      modelId: model_used,
      promptVersion: data.prompt_version,
      schemaVersion: data.schema_version,
      rawResponse: raw,
    });

    // ── ZIE Factory: feed this clause into the vault (fire-and-forget) ───────
    // The clause text + label is the prompt. The 120B output is the gold label.
    // This runs concurrently and never blocks the clause analysis loop.
    captureClauseForVault(
      data.clause_label,
      documentText.slice(0, 2000), // clause context window
      docClass,
    );
  }

  await updateRunStatus(runId, anyFailed ? "completed_with_errors" : "completed");
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runSemanticShadow(params: {
  matterId: string;
  tenantId: string;
  specialist: string;
  documentText: string;
}): Promise<void> {
  const { matterId, tenantId, specialist, documentText } = params;
  const runId = crypto.randomUUID();

  try {
    const docClass = resolveDocClass(specialist);
    const policy = getRoutePolicy(docClass);
    const routeChainId = buildRouteChainId(policy);

    if (UNSUPPORTED_DOC_CLASSES.includes(docClass)) {
      logger.info({ runId, matterId, specialist, docClass }, "semantic: skipping unsupported doc class");
      await insertRunRow({
        runId, matterId, tenantId, docClass, routeChainId,
        promptVersion: SEMANTIC_PROMPT_VERSION,
        status: "skipped_unsupported_doc_class_mapping",
      });
      return;
    }

    await insertRunRow({
      runId, matterId, tenantId, docClass, routeChainId,
      promptVersion: SEMANTIC_PROMPT_VERSION,
      status: "running",
    });

    await analyzeClausesSemantically({
      runId, matterId, tenantId, documentText,
      docClass: docClass as DocClass,
      policy,
    });
  } catch (err) {
    logger.error({ runId, matterId, err }, "semantic: unhandled error in shadow run");
    try {
      await updateRunStatus(runId, "failed", true);
    } catch {
      // swallow
    }
  }
}
