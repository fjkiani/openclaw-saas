/**
 * semanticClauseSchema.ts
 *
 * Semantic Law Counsel v1 — Zod schemas and response classification utilities.
 *
 * Two schema tiers:
 *   standard-v1  — routine documents (contractor_ip_assignment, advisor_agreement)
 *   premium-v1   — high-exposure documents (co_founder_agreement)
 *
 * Rationale quality controls (Revision 2):
 *   - Word count floors/ceilings enforced via .refine()
 *   - Generic-phrase blocklist rejects filler rationale
 *   - Specificity check on recommended_action / target_redline
 *
 * Response classification (Revision 6):
 *   classifyModelResponse  — classifies raw model output before parse
 *   detectUnusableOutput   — detects schema-valid but semantically empty output
 */

import { z } from "zod";

// ── Word count helper ─────────────────────────────────────────────────────────

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ── Generic-phrase blocklist ──────────────────────────────────────────────────
// rationale_summary must not contain these patterns.

const GENERIC_PHRASES: RegExp[] = [
  /\bthis clause (is|appears|seems)\b/i,
  /\bneeds (further|additional) review\b/i,
  /\bconsult (a |an |your )?attorney\b/i,
  /\bseek legal (advice|counsel)\b/i,
  /\bthis (is|may be) (important|significant|relevant)\b/i,
  /\bcareful (review|consideration) (is |may be )?required\b/i,
  /\bplease (review|consult|consider)\b/i,
];

function hasGenericPhrase(s: string): boolean {
  return GENERIC_PHRASES.some((p) => p.test(s));
}

// ── Specificity check ─────────────────────────────────────────────────────────
// recommended_action / target_redline must reference at least one concrete term.

const SPECIFICITY_PATTERN =
  /\b(\d+[\s-]?(day|month|year|%)|clause|section|§|party|assignee|licensor|licensee|indemnif|terminat|vest|assign|warrant|represent|covenant|jurisdict|govern|arbitrat|ip|intellectual property|equity|shares|stock)\b/i;

function isSpecific(s: string): boolean {
  return SPECIFICITY_PATTERN.test(s);
}

// ── Standard schema ───────────────────────────────────────────────────────────
// Used for: contractor_ip_assignment, advisor_agreement, and any non-premium doc class.

export const SemanticClauseAnalysisSchema = z.object({
  clause_id: z.string().min(1),
  clause_label: z.string().min(1),
  semantic_position: z.enum([
    "high_leverage",
    "acceptable",
    "below_minimum",
    "absent",
    "needs_review",
    "unknown",
  ]),
  risk_level: z.enum(["critical", "high", "medium", "low", "none"]),
  rationale_summary: z
    .string()
    .refine((s) => wordCount(s) >= 50, {
      message: "rationale_summary must be at least 50 words",
    })
    .refine((s) => wordCount(s) <= 300, {
      message: "rationale_summary must be at most 300 words",
    })
    .refine((s) => !hasGenericPhrase(s), {
      message: "rationale_summary contains generic filler phrase",
    }),
  recommended_action: z
    .string()
    .min(10, { message: "recommended_action must be at least 10 characters" })
    .refine(isSpecific, {
      message: "recommended_action must reference a specific clause, term, or party",
    }),
  confidence: z.number().min(0).max(1),
  deterministic_position: z
    .enum([
      "high_leverage",
      "acceptable",
      "below_minimum",
      "absent",
      "needs_review",
      "unknown",
    ])
    .optional(),
  deterministic_agreement: z.boolean().optional(),
  flags: z.array(z.string()).default([]),
  // Revision 7: audit fields
  prompt_version: z.string().min(1),
  schema_version: z.literal("standard-v1"),
  route_chain_id: z.string().min(1),
});

export type SemanticClauseAnalysis = z.infer<typeof SemanticClauseAnalysisSchema>;

// ── Premium schema ────────────────────────────────────────────────────────────
// Used for: co_founder_agreement. Stricter contract, not just inflated word count.

export const PremiumClauseAnalysisSchema = z.object({
  clause_id: z.string().min(1),
  clause_label: z.string().min(1),
  semantic_position: z.enum([
    "high_leverage",
    "acceptable",
    "below_minimum",
    "absent",
    "needs_review",
    "unknown",
  ]),
  risk_level: z.enum(["critical", "high", "medium", "low", "none"]),
  rationale_summary: z
    .string()
    .refine((s) => wordCount(s) >= 75, {
      message: "premium rationale_summary must be at least 75 words",
    })
    .refine((s) => wordCount(s) <= 400, {
      message: "premium rationale_summary must be at most 400 words",
    })
    .refine((s) => !hasGenericPhrase(s), {
      message: "rationale_summary contains generic filler phrase",
    }),
  // Structured fields — not essay theater
  precedent_or_market_norm_note: z
    .string()
    .min(10)
    .max(500, {
      message: "precedent_or_market_norm_note must be at most 500 characters",
    })
    .refine(isSpecific, {
      message:
        "precedent_or_market_norm_note must reference a specific norm, standard, or jurisdiction",
    }),
  target_redline: z
    .string()
    .min(10)
    .refine(isSpecific, {
      message: "target_redline must reference a specific clause or term to change",
    }),
  key_risk_if_accepted: z
    .string()
    .min(10)
    .refine(isSpecific, {
      message: "key_risk_if_accepted must name a specific legal or financial risk",
    }),
  recommended_action: z
    .string()
    .min(10)
    .refine(isSpecific, {
      message: "recommended_action must reference a specific clause, term, or party",
    }),
  confidence: z.number().min(0).max(1),
  // Revision 3: human review mandatory for high-exposure docs — enforced by schema
  requires_human_review: z.literal(true),
  deterministic_position: z
    .enum([
      "high_leverage",
      "acceptable",
      "below_minimum",
      "absent",
      "needs_review",
      "unknown",
    ])
    .optional(),
  deterministic_agreement: z.boolean().optional(),
  flags: z.array(z.string()).default([]),
  // Revision 7: audit fields
  prompt_version: z.string().min(1),
  schema_version: z.literal("premium-v1"),
  route_chain_id: z.string().min(1),
});

export type PremiumClauseAnalysis = z.infer<typeof PremiumClauseAnalysisSchema>;
export type AnyClauseAnalysis = SemanticClauseAnalysis | PremiumClauseAnalysis;

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export const SemanticContractAnalysisSchema = z.object({
  analyses: z.array(z.union([SemanticClauseAnalysisSchema, PremiumClauseAnalysisSchema])),
  overall_risk_level: z.enum(["critical", "high", "medium", "low", "none"]),
  summary: z
    .string()
    .refine((s) => wordCount(s) >= 50, {
      message: "summary must be at least 50 words",
    })
    .refine((s) => wordCount(s) <= 400, {
      message: "summary must be at most 400 words",
    })
    .refine((s) => !hasGenericPhrase(s), {
      message: "summary contains generic filler phrase",
    }),
  human_review_required: z.boolean(),
  escalation_reason: z.string().nullable(),
});

// ── Response classification (Revision 6) ─────────────────────────────────────

export type ResponseClassification =
  | { kind: "valid_json"; parsed: unknown }
  | { kind: "refusal"; raw: string }
  | { kind: "partial_json"; raw: string }
  | { kind: "empty"; raw: string }
  | { kind: "schema_valid_unusable"; parsed: unknown; reason: string };

const REFUSAL_PATTERNS: RegExp[] = [
  /i('m| am) (unable|not able) to/i,
  /i (cannot|can't) (provide|assist|help)/i,
  /as an ai (language model|assistant)/i,
  /i (don't|do not) (have|provide) legal advice/i,
  /this (request|question) (is|falls) outside/i,
];

export function classifyModelResponse(raw: string): ResponseClassification {
  if (!raw || raw.trim().length === 0) return { kind: "empty", raw };

  if (REFUSAL_PATTERNS.some((p) => p.test(raw))) return { kind: "refusal", raw };

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { kind: "partial_json", raw };

  try {
    const parsed = JSON.parse(match[0]);
    return { kind: "valid_json", parsed };
  } catch {
    return { kind: "partial_json", raw };
  }
}

/**
 * detectUnusableOutput — called after successful JSON parse.
 * Checks for placeholder or empty critical fields that would pass JSON parse
 * but produce semantically worthless output.
 *
 * Returns a reason string if unusable, null if acceptable.
 */
export function detectUnusableOutput(
  parsed: unknown,
  schemaType: "standard" | "premium" | "seo" | "generic",
): string | null {
  // Non-legal schemas have their own validators — skip legal-specific field checks.
  // "generic" is for callers whose response shape is not a legal clause at all (for example the
  // verification rubric judge, which returns {overall, axes}). Such callers must supply their own
  // `validator`; applying the clause-field checks here would discard every valid response.
  if (schemaType === "seo" || schemaType === "generic") return null;
  const p = parsed as Record<string, unknown>;
  if (!p.rationale_summary || String(p.rationale_summary).trim().length === 0)
    return "empty rationale_summary";
  if (!p.recommended_action || String(p.recommended_action).trim().length === 0)
    return "empty recommended_action";
  if (String(p.rationale_summary).includes("[PLACEHOLDER]"))
    return "placeholder in rationale_summary";
  if (String(p.recommended_action).includes("[PLACEHOLDER]"))
    return "placeholder in recommended_action";
  if (schemaType === "premium") {
    if (!p.target_redline || String(p.target_redline).trim().length === 0)
      return "empty target_redline";
    if (!p.key_risk_if_accepted || String(p.key_risk_if_accepted).trim().length === 0)
      return "empty key_risk_if_accepted";
  }
  return null;
}
