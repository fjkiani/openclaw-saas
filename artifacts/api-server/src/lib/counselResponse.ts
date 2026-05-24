import type {
  DocClass,
  DraftSection,
  VerifierResult,
  ArtifactStatus,
  ReviewThreshold,
} from "./draftReceiptEngine";
import type { MissingDecisionPrompt } from "./draftEngine";

// ── DraftResponse ─────────────────────────────────────────────────────────────
// Mirrors the HTTP response shape of POST /v1/legal/draft and /v1/legal/draft/revise.
// Used as input to buildCounselResponse — not the internal BuildDraftResult.
export interface DraftResponse {
  draft_id: string;
  doc_class: DocClass;
  draft: {
    title: string;
    sections: DraftSection[];
    full_text: string;
  };
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  missing_decision_prompts: MissingDecisionPrompt[];
  verifier: VerifierResult;
  governance: {
    artifact_status: ArtifactStatus;
    escalation_required: boolean;
    review_threshold: ReviewThreshold;
    human_review_required: true;
    not_legal_advice: true;
    privilege_warning: string;
  };
}

// ── Output types ──────────────────────────────────────────────────────────────
export interface AssumptionNote {
  /** Section the assumption applies to (parsed from assumption string prefix) */
  section: string;
  /** Plain-language description of what was decided on the user's behalf */
  assumption: string;
  /** Always true in v0/v0.5 — all assumptions are revisable via /revise */
  can_change: boolean;
}

export interface MissingDecisionNote {
  field: string;
  question: string;
  why_it_matters: string;
  priority: number;
}

export interface ReviewGuidanceNote {
  /** Section this guidance applies to */
  section: string;
  threshold: ReviewThreshold;
  /** Plain-language guidance for the reviewer */
  guidance: string;
  /** Verifier flag IDs that triggered this note */
  flag_ids: string[];
}

export interface CounselResponse {
  /** 1–2 sentence summary of what was drafted */
  summary: string;
  /** What the engine decided on the user's behalf */
  assumptions_made: AssumptionNote[];
  /** Fields still needing input */
  missing_decisions: MissingDecisionNote[];
  /** Sections requiring careful review, with guidance */
  review_guidance: ReviewGuidanceNote[];
  /** Aggregate review threshold across all sections and flags */
  overall_threshold: ReviewThreshold;
  /** true if artifact_status === "draft_pending_approval" */
  ready_to_proceed: boolean;
}

// ── Static maps ───────────────────────────────────────────────────────────────

const DOC_CLASS_LABELS: Record<DocClass, string> = {
  co_founder_agreement: "Co-Founder Agreement",
  contractor_ip_assignment: "Contractor IP Assignment",
  advisor_agreement: "Advisor Agreement",
};

// Static per-section guidance text.
// Used when a section's review_threshold is above "self_review_ok".
const SECTION_GUIDANCE: Record<string, string> = {
  election_83b:
    "The 83(b) election window is 30 days from grant date — absolute, no extensions. File by certified mail and retain proof.",
  ip_assignment:
    "Confirm the IP scope matches what was negotiated. Broad assignment captures all inventions; work-product-only is narrower. Prior inventions carve-out (Schedule A) must be completed before signing.",
  equity_split:
    "Verify all percentages sum to 100% and match the cap table. Board resolution required before issuance (DE).",
  vesting_schedule:
    "Confirm cliff and total vesting period match the negotiated terms. Cliff must be less than total vesting period.",
  governing_law:
    "Choice-of-law clause may not override California law for California residents. Confirm jurisdiction with counsel.",
  non_solicitation:
    "Non-solicitation scope and duration must be reasonable. Void in California regardless of choice-of-law.",
  prior_inventions_carveout:
    "Schedule A must be completed with all prior inventions before signing. Blank Schedule A is not protective.",
};

// Threshold ordering for comparison
const THRESHOLD_ORDER: ReviewThreshold[] = [
  "self_review_ok",
  "business_review_required",
  "counsel_review_required",
  "blocked",
];

function isAboveSelfReview(t: ReviewThreshold): boolean {
  return THRESHOLD_ORDER.indexOf(t) > 0;
}

// ── buildCounselResponse ──────────────────────────────────────────────────────
// Pure function. No side effects. No model calls.
// Converts a structured DraftResponse into an advisor-style explanation.
export function buildCounselResponse(draftResponse: DraftResponse): CounselResponse {
  const { doc_class, draft, assumptions, missing_decision_prompts, verifier, governance } =
    draftResponse;

  // 1. Summary — deterministic string construction
  const label = DOC_CLASS_LABELS[doc_class];
  const partyNames = draft.sections
    .length > 0
    ? extractPartyNames(draft.title)
    : "the parties";
  const sectionCount = draft.sections.length;
  const assumptionCount = assumptions.length;
  const assumptionClause =
    assumptionCount > 0
      ? `, ${assumptionCount} assumption${assumptionCount === 1 ? "" : "s"} applied`
      : "";
  const summary = `Drafted a ${label} under the governing law specified. ${sectionCount} section${sectionCount === 1 ? "" : "s"} assembled${assumptionClause}.`;

  // 2. Assumptions made — parse each assumption string on first ":"
  const assumptions_made: AssumptionNote[] = assumptions.map((a) => {
    const colonIdx = a.indexOf(":");
    if (colonIdx === -1) {
      return { section: "general", assumption: a.trim(), can_change: true };
    }
    return {
      section: a.slice(0, colonIdx).trim(),
      assumption: a.slice(colonIdx + 1).trim(),
      can_change: true,
    };
  });

  // 3. Missing decisions — direct map from missing_decision_prompts
  const missing_decisions: MissingDecisionNote[] = missing_decision_prompts.map((p) => ({
    field: p.field,
    question: p.question,
    why_it_matters: p.why_it_matters,
    priority: p.priority,
  }));

  // 4. Review guidance — one note per section where rationale.review_threshold > self_review_ok
  // Collect verifier flag IDs per section for cross-referencing
  const flagIdsBySection = buildFlagIdsBySection(verifier);

  const review_guidance: ReviewGuidanceNote[] = [];
  const seenSections = new Set<string>();

  for (const section of draft.sections) {
    const threshold = section.rationale?.review_threshold;
    if (!threshold || !isAboveSelfReview(threshold)) continue;
    if (seenSections.has(section.section_id)) continue;
    seenSections.add(section.section_id);

    const guidance =
      SECTION_GUIDANCE[section.section_id] ??
      `Review the ${section.section_id.replace(/_/g, " ")} section carefully before signing.`;

    review_guidance.push({
      section: section.section_id,
      threshold,
      guidance,
      flag_ids: flagIdsBySection[section.section_id] ?? [],
    });
  }

  // 5. Overall threshold and ready_to_proceed
  const overall_threshold = governance.review_threshold;
  const ready_to_proceed = governance.artifact_status === "draft_pending_approval";

  return {
    summary,
    assumptions_made,
    missing_decisions,
    review_guidance,
    overall_threshold,
    ready_to_proceed,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract party names from a draft title like "Co-Founder Agreement — Alice Chen / Bob Park"
// Falls back to "the parties" if the title doesn't contain " — "
function extractPartyNames(title: string): string {
  const dashIdx = title.indexOf(" — ");
  if (dashIdx === -1) return "the parties";
  return title.slice(dashIdx + 3).trim();
}

// Build a map of section_id → flag_ids from all four verifier buckets
function buildFlagIdsBySection(verifier: VerifierResult): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  const addFlag = (section: string, id: string) => {
    if (!map[section]) map[section] = [];
    if (!map[section].includes(id)) map[section].push(id);
  };

  for (const f of verifier.template_failures) {
    addFlag(f.section, f.failure_id);
  }
  for (const f of verifier.legal_conflicts) {
    for (const s of f.sections_involved) addFlag(s, f.conflict_id);
  }
  for (const f of verifier.jurisdiction_escalations) {
    addFlag(f.section, f.flag_id);
  }
  // missing_data flags use dot-path fields, not section IDs — skip for section mapping

  return map;
}
