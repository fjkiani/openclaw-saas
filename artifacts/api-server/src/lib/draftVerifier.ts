import type {
  DraftIntake,
  VerifierResult,
  ArtifactStatus,
  MissingDataFlag,
  LegalConflictFlag,
  TemplateFailureFlag,
  JurisdictionFlag,
  ReviewThreshold,
} from "./draftReceiptEngine";
import type { BuildDraftResult } from "./draftEngine";
import { getEscalationTrigger } from "./draftIntakeSchemas";

export const VERIFIER_VERSION = "v1";

// ── ReviewThreshold ordering ──────────────────────────────────────────────────
const THRESHOLD_ORDER: ReviewThreshold[] = [
  "self_review_ok",
  "business_review_required",
  "counsel_review_required",
  "blocked",
];

function maxThreshold(a: ReviewThreshold, b: ReviewThreshold): ReviewThreshold {
  return THRESHOLD_ORDER.indexOf(a) >= THRESHOLD_ORDER.indexOf(b) ? a : b;
}

// ── GovernanceResult ──────────────────────────────────────────────────────────
// review_threshold is a v0.5 addition — always present, coexists with artifact_status
export interface GovernanceResult {
  artifact_status: ArtifactStatus;
  escalation_required: boolean;
  review_threshold: ReviewThreshold;   // v0.5 — aggregate max across all flags
}

// ── Option A comment ──────────────────────────────────────────────────────────
// CA_NONCOMPETE_VOID is a REVISION-PATH GUARD only.
// On the initial draft path, the template correctly omits non_solicitation and
// non_compete for CA jurisdiction (condition: jurisdiction !== "CA"). This check
// fires only when a prohibited section is present in the assembled draft — which
// can only happen if a revision instruction explicitly inserted it.
// Do NOT add proactive firing logic for clean CA drafts.

// ── 83(b) flag naming ─────────────────────────────────────────────────────────
// The canonical flag identifier is SECTION_83B_TIMING_WARNING.
// The legacy name CA_83B_WINDOW_NOTE is a misnomer — the 30-day IRS filing window
// applies in all US jurisdictions, not only California. Do not use CA_83B_WINDOW_NOTE
// in any new code.

export function verifyDraft(
  result: BuildDraftResult,
  intake: DraftIntake,
): VerifierResult {
  const missing_data: MissingDataFlag[] = [];
  const legal_conflicts: LegalConflictFlag[] = [];
  const template_failures: TemplateFailureFlag[] = [];
  const jurisdiction_escalations: JurisdictionFlag[] = [];

  // ── Template failures ──────────────────────────────────────────────────────

  // PLACEHOLDER_LEAK: any unresolved [PLACEHOLDER: ...] in full_text
  const leakMatches = result.full_text.match(/\[PLACEHOLDER:[^\]]+\]/g) ?? [];
  for (const leak of leakMatches) {
    const ownerSection =
      result.sections.find((s) => s.body.includes(leak))?.section_id ?? "unknown";
    template_failures.push({
      failure_id: "PLACEHOLDER_LEAK",
      section: ownerSection,
      detail: leak,
      severity: "warning",
      review_threshold: "business_review_required",   // v0.5
    });
  }

  // MISSING_REQUIRED_SECTION: section with empty body
  for (const s of result.sections) {
    if (!s.body || s.body.trim() === "") {
      template_failures.push({
        failure_id: "MISSING_REQUIRED_SECTION",
        section: s.section_id,
        detail: `Section '${s.section_id}' has empty body`,
        severity: "blocking",
        review_threshold: "blocked",   // v0.5
      });
    }
  }

  // UNAPPROVED_VARIANT: body is the "no approved variant" placeholder
  for (const s of result.sections) {
    if (
      s.body.startsWith("[PLACEHOLDER:") &&
      s.body.includes("no approved variant")
    ) {
      template_failures.push({
        failure_id: "UNAPPROVED_VARIANT",
        section: s.section_id,
        detail: `No approved variant found for section '${s.section_id}' in jurisdiction '${intake.jurisdiction}'`,
        severity: "blocking",
        review_threshold: "blocked",   // v0.5
      });
    }
  }

  // ── Missing data ───────────────────────────────────────────────────────────
  for (const flag of result.missing_info_flags) {
    // Derive review_threshold from ESCALATION_TRIGGERS if available
    const fieldKey = flag.split(":")[0].trim();
    const trigger = getEscalationTrigger(fieldKey, intake.doc_class);
    missing_data.push({
      field: flag,
      impact: "Section uses placeholder or default value",
      review_threshold: trigger?.review_threshold ?? "business_review_required",   // v0.5
    });
  }

  // ── Legal conflicts ────────────────────────────────────────────────────────

  // CLIFF_EXCEEDS_TOTAL
  const vy = intake.equity?.vesting_years;
  const cm = intake.equity?.cliff_months;
  if (vy != null && cm != null && cm >= vy * 12) {
    legal_conflicts.push({
      conflict_id: "CLIFF_EXCEEDS_TOTAL",
      description: `cliff_months (${cm}) must be less than vesting_years * 12 (${vy * 12})`,
      sections_involved: ["vesting_schedule"],
      severity: "blocking",
      review_threshold: "counsel_review_required",   // v0.5
    });
  }

  // EQUITY_SPLIT_NOT_100
  const split = intake.equity?.split;
  if (split != null) {
    const total = Object.values(split).reduce((acc, v) => acc + v, 0);
    if (Math.abs(total - 100) > 0.01) {
      legal_conflicts.push({
        conflict_id: "EQUITY_SPLIT_NOT_100",
        description: `equity.split sums to ${total.toFixed(2)}, must equal 100`,
        sections_involved: ["equity_split"],
        severity: "blocking",
        review_threshold: "blocked",   // v0.5
      });
    }
  }

  // ── Jurisdiction escalations ───────────────────────────────────────────────
  const sectionIds = new Set(result.sections.map((s) => s.section_id));

  // CA_NONCOMPETE_VOID — revision-path guard (see Option A comment above)
  if (
    intake.jurisdiction === "CA" &&
    (sectionIds.has("non_solicitation") || sectionIds.has("non_compete"))
  ) {
    jurisdiction_escalations.push({
      flag_id: "CA_NONCOMPETE_VOID",
      jurisdiction: "CA",
      section: sectionIds.has("non_compete") ? "non_compete" : "non_solicitation",
      description:
        "Non-compete and non-solicitation clauses are void under CA Bus. & Prof. Code § 16600",
      severity: "blocking",
      recommended_action: "Remove non-compete and non-solicitation sections",
      review_threshold: "blocked",   // v0.5
    });
  }

  // SECTION_83B_TIMING_WARNING — fires for any jurisdiction when election_83b is present
  // (The 30-day IRS window is not CA-specific. Legacy name CA_83B_WINDOW_NOTE is retired.)
  if (sectionIds.has("election_83b")) {
    jurisdiction_escalations.push({
      flag_id: "SECTION_83B_TIMING_WARNING",
      jurisdiction: intake.jurisdiction,
      section: "election_83b",
      description:
        "83(b) election must be filed within 30 days of grant date — no extensions. Applies in all US jurisdictions.",
      severity: "warning",
      recommended_action:
        "File by certified mail within 30 days of grant date and retain proof of filing",
      review_threshold: "counsel_review_required",   // v0.5
    });
  }

  // DE_BOARD_APPROVAL
  if (
    intake.jurisdiction === "DE" &&
    (sectionIds.has("equity_split") || sectionIds.has("equity_compensation"))
  ) {
    jurisdiction_escalations.push({
      flag_id: "DE_BOARD_APPROVAL",
      jurisdiction: "DE",
      section: sectionIds.has("equity_split") ? "equity_split" : "equity_compensation",
      description: "DGCL § 152 requires board authorization for equity issuances",
      severity: "warning",
      recommended_action: "Obtain board resolution before issuing equity",
      review_threshold: "counsel_review_required",   // v0.5
    });
  }

  // CA_MORAL_RIGHTS
  if (intake.jurisdiction === "CA" && sectionIds.has("moral_rights_waiver")) {
    jurisdiction_escalations.push({
      flag_id: "CA_MORAL_RIGHTS",
      jurisdiction: "CA",
      section: "moral_rights_waiver",
      description:
        "17 U.S.C. § 106A moral rights apply to works of visual art in California",
      severity: "warning",
      recommended_action:
        "Confirm work-for-hire scope excludes visual art or obtain separate waiver",
      review_threshold: "business_review_required",   // v0.5
    });
  }

  const passed =
    template_failures.filter((f) => f.severity === "blocking").length === 0 &&
    legal_conflicts.filter((f) => f.severity === "blocking").length === 0 &&
    jurisdiction_escalations.filter((f) => f.severity === "blocking").length === 0;

  return {
    passed,
    missing_data,
    legal_conflicts,
    template_failures,
    jurisdiction_escalations,
  };
}

// ── buildDraftGovernance ──────────────────────────────────────────────────────
export function buildDraftGovernance(verifier: VerifierResult): GovernanceResult {
  const hasBlockingJurisdiction = verifier.jurisdiction_escalations.some(
    (f) => f.severity === "blocking",
  );
  const hasBlockingTemplateFailure = verifier.template_failures.some(
    (f) => f.severity === "blocking",
  );
  const hasBlockingConflict = verifier.legal_conflicts.some(
    (f) => f.severity === "blocking",
  );

  // artifact_status: jurisdiction blocking takes precedence
  let artifact_status: ArtifactStatus;
  if (hasBlockingJurisdiction) {
    artifact_status = "blocked";
  } else if (hasBlockingTemplateFailure || hasBlockingConflict) {
    artifact_status = "needs_revision";
  } else {
    artifact_status = "draft_pending_approval";
  }

  const escalation_required = hasBlockingJurisdiction || hasBlockingTemplateFailure || hasBlockingConflict;

  // v0.5: compute aggregate review_threshold — max across all flag buckets
  let review_threshold: ReviewThreshold = "self_review_ok";

  for (const f of verifier.template_failures) {
    if (f.review_threshold) review_threshold = maxThreshold(review_threshold, f.review_threshold);
  }
  for (const f of verifier.legal_conflicts) {
    if (f.review_threshold) review_threshold = maxThreshold(review_threshold, f.review_threshold);
  }
  for (const f of verifier.jurisdiction_escalations) {
    if (f.review_threshold) review_threshold = maxThreshold(review_threshold, f.review_threshold);
  }
  for (const f of verifier.missing_data) {
    if (f.review_threshold) review_threshold = maxThreshold(review_threshold, f.review_threshold);
  }

  return { artifact_status, escalation_required, review_threshold };
}
