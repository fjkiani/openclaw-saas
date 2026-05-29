/**
 * verifiedRationale.ts
 *
 * Verified Rationale Engine — v1.0
 *
 * Produces a VerifiedRationale for each clause section in a draft.
 * Rationale text is drawn ONLY from:
 *   (a) variant.jurisdiction_notes[jurisdiction] — static authored text
 *   (b) Literal string constants defined in this file
 *
 * NEVER from a model call. NEVER from generated text.
 *
 * Safety invariants (enforced in buildVerifiedRationale):
 *   - verified = false  →  auto_insert_allowed = false  (always, no exceptions)
 *   - verified = false  →  counsel_review_required = true  (always)
 *   - risk_level = "requires_counsel"  →  counsel_review_required = true
 *   - rationale_source always identifies the exact static source or "unverified"
 */

import type { ClauseVariant } from "./clauseLibrary.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RationaleType =
  | "playbook"           // approved variant from clauseLibrary with reviewed_by set
  | "internal_business"  // reserved for future: verified internal business rationale
  | "counsel_authored"   // reserved for future: verified counsel-authored rationale
  | "unverified";        // no verified rationale on file

export interface VerifiedRationale {
  rationale_type: RationaleType;
  rationale_text: string;
  rationale_source: string;         // e.g. "clauseLibrary:IP-001", "unverified"
  verified: boolean;
  auto_insert_allowed: boolean;     // false when verified === false, always
  counsel_review_required: boolean; // true when verified === false OR risk_level === "requires_counsel"
}

// ── Literal string constants (the only permitted rationale text sources) ──────

const RATIONALE_APPROVED_STANDARD =
  "Approved playbook variant — standard risk level. Reviewed and approved for use.";

const RATIONALE_APPROVED_ELEVATED =
  "Approved playbook variant — elevated risk level. Counsel review recommended before execution.";

const RATIONALE_APPROVED_REQUIRES_COUNSEL =
  "Approved playbook variant — requires counsel review. Do not execute without qualified legal review.";

const RATIONALE_NO_VARIANT =
  "No approved variant on file for this section in the requested jurisdiction.";

const RATIONALE_NOT_APPROVED =
  "No verified rationale on file — counsel review required.";

const RATIONALE_MISSING_REVIEWED_BY =
  "Variant exists but has not been reviewed. No verified rationale on file — counsel review required.";

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Builds a VerifiedRationale for a given clause section.
 *
 * @param variant   The ClauseVariant selected for this section, or null if none found.
 * @param jurisdiction The jurisdiction string from DraftIntake.
 */
export function buildVerifiedRationale(
  variant: ClauseVariant | null,
  jurisdiction: string,
): VerifiedRationale {
  // Case 1: No variant found for this section/jurisdiction
  if (variant === null) {
    return {
      rationale_type: "unverified",
      rationale_text: RATIONALE_NO_VARIANT,
      rationale_source: "unverified",
      verified: false,
      auto_insert_allowed: false,
      counsel_review_required: true,
    };
  }

  // Case 2: Variant exists but not approved or not reviewed
  if (!variant.approved_for_use || !variant.reviewed_by || variant.reviewed_by.trim() === "") {
    return {
      rationale_type: "unverified",
      rationale_text: variant.reviewed_by
        ? RATIONALE_NOT_APPROVED
        : RATIONALE_MISSING_REVIEWED_BY,
      rationale_source: "unverified",
      verified: false,
      auto_insert_allowed: false,
      counsel_review_required: true,
    };
  }

  // Case 3: Approved and reviewed — build verified rationale
  // rationale_text: prefer jurisdiction-specific note, fall back to risk-level constant
  const jurisdictionNote = variant.jurisdiction_notes[jurisdiction] ?? null;
  const fallbackText = riskLevelRationaleText(variant.risk_level);
  const rationaleText = jurisdictionNote !== null ? jurisdictionNote : fallbackText;

  const counselRequired = variant.risk_level === "requires_counsel";
  const autoInsertAllowed = !counselRequired; // requires_counsel → no auto-insert

  return {
    rationale_type: "playbook",
    rationale_source: `clauseLibrary:${variant.variant_id}`,
    rationale_text: rationaleText,
    verified: true,
    auto_insert_allowed: autoInsertAllowed,
    counsel_review_required: counselRequired,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function riskLevelRationaleText(
  riskLevel: ClauseVariant["risk_level"],
): string {
  switch (riskLevel) {
    case "standard":
      return RATIONALE_APPROVED_STANDARD;
    case "elevated":
      return RATIONALE_APPROVED_ELEVATED;
    case "requires_counsel":
      return RATIONALE_APPROVED_REQUIRES_COUNSEL;
  }
}

/**
 * Batch helper: builds VerifiedRationale for a list of (sectionId, variant) pairs.
 * Used by the analyze route to attach rationale to all sections in one pass.
 */
export function buildVerifiedRationaleMap(
  entries: Array<{ section_id: string; variant: ClauseVariant | null; jurisdiction: string }>,
): Map<string, VerifiedRationale> {
  const result = new Map<string, VerifiedRationale>();
  for (const entry of entries) {
    result.set(
      entry.section_id,
buildVerifiedRationale(entry.variant, entry.jurisdiction),
    );
  }
  return result;
}
