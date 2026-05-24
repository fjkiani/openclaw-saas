import crypto from "crypto";
import type {
  DocClass,
  DraftIntake,
  DraftSection,
  StoredDraftArtifact,
  ReviewThreshold,
  SectionRationale,
} from "./draftReceiptEngine";
import { getTemplate, TEMPLATE_VERSION } from "./startupTemplates";
import { selectVariant, CLAUSE_LIBRARY, CLAUSE_LIBRARY_VERSION } from "./clauseLibrary";
import { ESCALATION_TRIGGERS } from "./draftIntakeSchemas";
import { INTAKE_QUESTION_CATALOG } from "./intakeQuestions";

export { TEMPLATE_VERSION, CLAUSE_LIBRARY_VERSION };
// Re-export SectionRationale for convenience — defined in draftReceiptEngine to avoid circular import
export type { SectionRationale };

// ── ReviewThreshold severity order ───────────────────────────────────────────
const THRESHOLD_ORDER: ReviewThreshold[] = [
  "self_review_ok",
  "business_review_required",
  "counsel_review_required",
  "blocked",
];

function maxThreshold(a: ReviewThreshold, b: ReviewThreshold): ReviewThreshold {
  return THRESHOLD_ORDER.indexOf(a) >= THRESHOLD_ORDER.indexOf(b) ? a : b;
}

function riskLevelToThreshold(
  risk_level: "standard" | "elevated" | "requires_counsel",
): ReviewThreshold {
  if (risk_level === "standard") return "self_review_ok";
  if (risk_level === "elevated") return "business_review_required";
  return "counsel_review_required";
}

// ── Result types ──────────────────────────────────────────────────────────────
export interface MissingDecisionPrompt {
  field: string;
  question: string;
  why_it_matters: string;
  minimum_answer: string;
  risk_if_skipped: string;
  review_threshold: ReviewThreshold;
  /** 1 = highest priority; max 5 prompts returned */
  priority: number;
}

export interface BuildDraftResult {
  sections: DraftSection[];
  full_text: string;
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  /** v0.5 — always an array, may be empty; max 5 entries */
  missing_decision_prompts: MissingDecisionPrompt[];
}

export interface RevisionResult {
  new_sections: DraftSection[]; // NOT "sections"
  new_full_text: string; // NOT "full_text"
  new_section_map: string[]; // NOT "section_map"
  assumptions: string[];
  missing_info_flags: string[];
  not_implemented?: boolean;
}

// ── Placeholder filler ────────────────────────────────────────────────────────
// Fills [PLACEHOLDER: field.path] markers from intake using dot-path traversal.
// Special case: effective_date absent → fills "the date last signed below" (no leak).
// Unresolved markers are left as-is (trigger PLACEHOLDER_LEAK in verifier).
function fillPlaceholders(body: string, intake: DraftIntake): string {
  return body.replace(/\[PLACEHOLDER:\s*([^\]]+)\]/g, (_match, rawPath: string) => {
    const path = rawPath.trim();

    // Special case: effective_date absent → deterministic fallback, no placeholder leak
    if (path === "effective_date") {
      return intake.effective_date ?? "the date last signed below";
    }

    const parts = path.split(".");
    let val: unknown = intake;
    for (const part of parts) {
      if (val == null || typeof val !== "object") {
        val = undefined;
        break;
      }
      val = (val as Record<string, unknown>)[part];
    }
    if (val == null) return `[PLACEHOLDER: ${path}]`; // leave unresolved
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

// ── Title builder ─────────────────────────────────────────────────────────────
function buildTitle(title_template: string, intake: DraftIntake): string {
  const names = intake.parties.map((p) => p.name).join(" / ");
  return title_template.replace("[PARTY_NAMES]", names);
}

// ── buildMissingDecisionPrompts ───────────────────────────────────────────────
// Builds up to 5 prioritised prompts from ESCALATION_TRIGGERS for fields absent in intake.
// Sort order: blocked → counsel_review_required (blocking:true) →
//             counsel_review_required (blocking:false) → business_review_required
function buildMissingDecisionPrompts(
  intake: DraftIntake,
): MissingDecisionPrompt[] {
  const absent = ESCALATION_TRIGGERS.filter((trigger) => {
    if (!trigger.doc_classes.includes(intake.doc_class)) return false;
    return isIntakeFieldAbsent(trigger.field, intake);
  });

  // Sort by severity then blocking flag
  absent.sort((a, b) => {
    const aIdx = THRESHOLD_ORDER.indexOf(a.review_threshold);
    const bIdx = THRESHOLD_ORDER.indexOf(b.review_threshold);
    if (bIdx !== aIdx) return bIdx - aIdx; // higher threshold first
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1; // blocking first
    return 0;
  });

  return absent.slice(0, 5).map((trigger, idx) => {
    const question = INTAKE_QUESTION_CATALOG.find(
      (q) => q.field === trigger.field && q.doc_classes.includes(intake.doc_class),
    );
    return {
      field: trigger.field,
      question: question?.question_text ?? `Provide ${trigger.field}`,
      why_it_matters: question?.why_it_matters ?? trigger.risk_if_absent,
      minimum_answer: trigger.blocking
        ? "Required before draft can proceed"
        : "Recommended — draft proceeds with default or placeholder",
      risk_if_skipped: trigger.risk_if_absent,
      review_threshold: trigger.review_threshold,
      priority: idx + 1,
    };
  });
}

// ── isIntakeFieldAbsent ───────────────────────────────────────────────────────
function isIntakeFieldAbsent(field: string, intake: DraftIntake): boolean {
  if (field === "parties[*].entity_type") {
    return intake.parties.some((p) => p.entity_type == null || p.entity_type.trim() === "");
  }
  const parts = field.split(".");
  let val: unknown = intake;
  for (const part of parts) {
    if (val == null || typeof val !== "object") return true;
    val = (val as Record<string, unknown>)[part];
  }
  return val == null || (typeof val === "string" && val.trim() === "");
}

// ── buildDraft ────────────────────────────────────────────────────────────────
// Takes intake only — template loaded internally. NOT buildDraft(intake, template).
// CLAUSE_LIBRARY is imported at module level — never inside this function.
export function buildDraft(intake: DraftIntake): BuildDraftResult {
  const assumptions: string[] = [];
  const missing_info_flags: string[] = [];

  // Apply defaults — mutate a shallow copy so original intake is not modified
  let i: DraftIntake = { ...intake };

  if (
    i.doc_class === "co_founder_agreement" ||
    i.doc_class === "advisor_agreement"
  ) {
    if (i.equity?.acceleration == null) {
      assumptions.push(
        "equity.acceleration: not provided — defaulted to 'none'",
      );
      i = { ...i, equity: { ...i.equity, acceleration: "none" } };
    }
    if (i.equity?.vesting_years == null) {
      assumptions.push(
        "vesting_schedule: equity.vesting_years not provided — defaulted to 4yr/1yr cliff",
      );
      i = {
        ...i,
        equity: {
          ...i.equity,
          vesting_years: 4,
          cliff_months: i.equity?.cliff_months ?? 12,
        },
      };
    }
  }

  if (i.doc_class === "co_founder_agreement" && i.ip?.scope == null) {
    assumptions.push("ip_assignment: ip.scope not provided — defaulted to 'broad'");
    i = { ...i, ip: { ...i.ip, scope: "broad" } };
  }

  const template = getTemplate(i.doc_class);

  // Determine active sections
  const activeSectionIds: string[] = [...template.required_sections];
  for (const opt of template.optional_sections) {
    if (opt.condition(i)) {
      activeSectionIds.push(opt.section_id);
    }
  }

  // Build each section
  const sections: DraftSection[] = [];
  for (const section_id of activeSectionIds) {
    const variant = selectVariant(section_id, i.doc_class, i.jurisdiction, CLAUSE_LIBRARY);
    if (!variant) {
      missing_info_flags.push(
        `${section_id}: no approved variant for jurisdiction ${i.jurisdiction}`,
      );
      sections.push({
        section_id,
        title: section_id.replace(/_/g, " "),
        body: `[PLACEHOLDER: ${section_id} clause — no approved variant for jurisdiction ${i.jurisdiction}]`,
      });
      continue;
    }

    const body = fillPlaceholders(variant.body, i);

    // v0.5: build rationale for this section
    const threshold = riskLevelToThreshold(variant.risk_level);
    const assumptionsApplied = assumptions.filter((a) =>
      a.startsWith(section_id + ":"),
    );
    const jurisdictionNote = variant.jurisdiction_notes[i.jurisdiction] ?? null;

    let selectionReason = `Selected ${variant.label} (${variant.variant_id}).`;
    if (assumptionsApplied.length > 0) {
      selectionReason += ` Default applied: ${assumptionsApplied[0].split(":").slice(1).join(":").trim()}.`;
    }

    const rationale: SectionRationale = {
      selection_reason: selectionReason,
      condition_matched: variant.conditions[0] ?? "default",
      jurisdiction_note_applied: jurisdictionNote,
      review_threshold: threshold,
      assumptions_applied: assumptionsApplied,
    };

    sections.push({
      section_id,
      title: variant.label,
      body,
      variant_used: variant.variant_id,
      rationale,
    });
  }

  const full_text = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n---\n\n");
  const section_map = sections.map((s) => s.section_id);

  // v0.5: build missing decision prompts from original intake (not defaulted copy)
  const missing_decision_prompts = buildMissingDecisionPrompts(intake);

  return {
    sections,
    full_text,
    section_map,
    assumptions,
    missing_info_flags,
    missing_decision_prompts,
  };
}

// ── applyRevision ─────────────────────────────────────────────────────────────
// Deterministic revision parser. Trusted intake comes from stored.intake — never from client.
export function applyRevision(
  stored: StoredDraftArtifact,
  revision_instruction: string,
  allow_model_rewrite = false,
): RevisionResult {
  if (allow_model_rewrite) {
    return {
      new_sections: stored.sections,
      new_full_text: stored.full_text,
      new_section_map: stored.section_map,
      assumptions: stored.assumptions,
      missing_info_flags: ["model_clause_rewrite_not_implemented"],
      not_implemented: true,
    };
  }

  const instruction = revision_instruction.toLowerCase();
  // Preserve section objects — map creates shallow copies
  const sections: DraftSection[] = stored.sections.map((s) => ({ ...s }));
  const assumptions: string[] = [...stored.assumptions];
  const missing_info_flags: string[] = [];

  // "change vesting to Xyr/Ymo" or "use Xyr/Ymo"
  const vestingMatch = instruction.match(
    /(?:change vesting to|use)\s+(\d+)yr\/(\d+)(?:mo|month)/,
  );

  // "switch governing law to XX" or "change governing law to XX"
  const govLawMatch = instruction.match(
    /(?:switch|change) governing law to\s+([a-z]{2,})/,
  );

  // "remove <section_id>"
  const removeMatch = instruction.match(/remove\s+([\w-]+)/);

  if (vestingMatch) {
    const years = parseInt(vestingMatch[1], 10);
    const months = parseInt(vestingMatch[2], 10);
    // Build a temporary intake with new vesting values to select the right variant
    const newIntake: DraftIntake = {
      ...stored.intake,
      equity: { ...stored.intake.equity, vesting_years: years, cliff_months: months },
    };
    const rebuilt = buildDraft(newIntake);
    const newVesting = rebuilt.sections.find((s) => s.section_id === "vesting_schedule");
    const existingIdx = sections.findIndex((s) => s.section_id === "vesting_schedule");
    if (newVesting && existingIdx >= 0) {
      // Replace in-place — preserves section order
      sections[existingIdx] = newVesting;
      assumptions.push(
        `vesting_schedule: revised to ${years}yr/${months}mo cliff per instruction`,
      );
    } else {
      missing_info_flags.push(`no_vesting_variant_for_${years}yr_${months}mo`);
    }
  } else if (govLawMatch) {
    const newJurisdiction = govLawMatch[1].toUpperCase();
    const newIntake: DraftIntake = { ...stored.intake, jurisdiction: newJurisdiction };
    const rebuilt = buildDraft(newIntake);
    const newGl = rebuilt.sections.find((s) => s.section_id === "governing_law");
    const existingIdx = sections.findIndex((s) => s.section_id === "governing_law");
    if (newGl && existingIdx >= 0) {
      sections[existingIdx] = newGl;
      assumptions.push(`governing_law: revised to ${newJurisdiction} per instruction`);
    }
  } else if (removeMatch) {
    const target = removeMatch[1].replace(/-/g, "_");
    const idx = sections.findIndex((s) => s.section_id === target);
    if (idx >= 0) {
      sections.splice(idx, 1);
      assumptions.push(`${target}: removed per instruction`);
    }
  } else {
    missing_info_flags.push("revision_instruction_not_parseable");
  }

  const new_full_text = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n---\n\n");
  const new_section_map = sections.map((s) => s.section_id);

  return {
    new_sections: sections,
    new_full_text,
    new_section_map,
    assumptions,
    missing_info_flags,
  };
}

// ── buildTitle export (used by route handler) ─────────────────────────────────
export { buildTitle };
