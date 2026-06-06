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
import { logger } from "./logger.js";
import { invokeWithFallback, type ModelRouteConfig } from "./modelRouter.js";
import { persistDraftVault, type VaultWriteReceipt } from "./draftVault.js";
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
  vault: VaultWriteReceipt;
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

  const promptJson = JSON.stringify({ clause_id: clauseId, doc_class: docClass, original_text: originalText });
  const responseJson = JSON.stringify(draftOutput);

  const vault = await persistDraftVault({
    domain: "legal",
    taskType: "legal_clause_draft",
    sourceKind: "draft_agent",
    preferenceSource: "draft_agent",
    promptHash,
    promptJson,
    responseJson,
    qualityScore: draftOutput.confidence,
    chosenJson: JSON.stringify({
      text: draftOutput.improved_text,
      changes_summary: draftOutput.changes_summary,
    }),
    rejectedJson: JSON.stringify({ text: originalText, reason: "original — pre-improvement" }),
  });

  logger.info({ clauseId, docClass, vault }, "draftAgent: vault write complete");

  return {
    clauseId,
    clauseLabel,
    improvedText: draftOutput.improved_text,
    changesSummary: draftOutput.changes_summary,
    riskReduction: draftOutput.risk_reduction,
    confidence: draftOutput.confidence,
    modelUsed,
    vault,
  };
}

// ── GenerateAgreementInput / Output ───────────────────────────────────────────

export interface GenerateAgreementInput {
  clauseType: string;           // e.g. "co_founder_agreement"
  context: Record<string, unknown>;  // parties, vesting, jurisdiction, etc.
  instructions: string;         // free-form drafting instructions
  tenantId?: string;
}

export interface GenerateAgreementOutput {
  clauseType: string;
  improvedText: string;         // the full agreement text
  changesSummary: string;       // what was drafted and key provisions
  riskReduction: "eliminated" | "reduced" | "flagged_for_counsel";
  confidence: number;
  modelUsed: string;
  vault: VaultWriteReceipt;
}

// ── System prompt for full agreement generation ───────────────────────────────

const GENERATE_SYSTEM_PROMPT = `You are a senior corporate attorney drafting a complete legal agreement from scratch.

You will receive:
- clause_type: the type of agreement to draft
- context: structured data about the parties, terms, and deal parameters
- instructions: specific drafting requirements

Your output must be:
1. improved_text: The complete agreement in proper legal drafting style. Include all sections, numbered clauses, recitals, signature blocks. Use formal contract language throughout. This must be a complete, standalone document.
2. changes_summary: 2-4 sentences summarizing the key provisions drafted and any notable choices made.
3. risk_reduction: "eliminated" if all standard risks are addressed, "reduced" if some provisions need attorney review, "flagged_for_counsel" if the instructions require judgment calls beyond standard drafting.
4. confidence: Float 0.0-1.0 reflecting your confidence in the drafted agreement.

Rules:
- Output ONLY valid JSON. No markdown fences. No prose outside the JSON.
- improved_text must be a complete, executable legal document.
- Include all sections specified in the instructions. Do not omit any.
- Use Delaware law defaults unless jurisdiction is specified otherwise.
- For co-founder agreements: always include equity, vesting, IP assignment, decision-making, departure/buyback, non-compete, and dispute resolution sections.
- Number all sections. Use defined terms in ALL CAPS on first use.

Output format:
{
  "improved_text": "<complete agreement text>",
  "changes_summary": "<2-4 sentences>",
  "risk_reduction": "eliminated|reduced|flagged_for_counsel",
  "confidence": 0.0-1.0
}`;

// ── Model chain for generation (needs higher token limit) ─────────────────────

const GENERATE_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 4096,
    timeoutMs: 60_000,
    tags: ["70b", "generate-primary"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 4096,
    timeoutMs: 90_000,
    tags: ["120b", "generate-fallback"],
  },
];

// ── generateAgreement ─────────────────────────────────────────────────────────

export async function generateAgreement(input: GenerateAgreementInput): Promise<GenerateAgreementOutput> {
  const {
    clauseType,
    context,
    instructions,
    tenantId = "system",
  } = input;

  const userContent = JSON.stringify({
    clause_type: clauseType,
    context,
    instructions,
  });

  const contextStr = JSON.stringify(context).slice(0, 500);
  const promptHash = hashPrompt(`legal_generate:${clauseType}:${contextStr}:${instructions.slice(0, 200)}`);

  // ── Invoke model ──────────────────────────────────────────────────────────
  const result = await invokeWithFallback<z.infer<typeof DraftOutputSchema>>(
    {
      systemPrompt: GENERATE_SYSTEM_PROMPT,
      userContent,
      title: `OpenClaw Agreement Generator - ${clauseType}`,
      maxTokens: 4096,
      temperature: 0.2,
    },
    GENERATE_CHAIN,
    {
      validator: (raw) => DraftOutputSchema.parse(raw),
      routeChainId: "zie-generate-agent",
      schemaType: "seo",
    },
  );

  const draftOutput = result.parsed;
  const modelUsed = result.model_used;

  const promptJson = JSON.stringify({ clause_type: clauseType, context, instructions });
  const responseJson = JSON.stringify(draftOutput);

  const vault = await persistDraftVault({
    domain: "legal",
    taskType: "legal_agreement_generate",
    sourceKind: "generate_agent",
    preferenceSource: "generate_agent",
    promptHash,
    promptJson,
    responseJson,
    qualityScore: draftOutput.confidence,
    chosenJson: JSON.stringify({
      text: draftOutput.improved_text,
      changes_summary: draftOutput.changes_summary,
    }),
    rejectedJson: JSON.stringify({ text: "", reason: "no prior draft — generated from scratch" }),
  });

  logger.info({ clauseType, vault }, "generateAgent: vault write complete");

  return {
    clauseType,
    improvedText: draftOutput.improved_text,
    changesSummary: draftOutput.changes_summary,
    riskReduction: draftOutput.risk_reduction,
    confidence: draftOutput.confidence,
    modelUsed,
    vault,
  };
}
