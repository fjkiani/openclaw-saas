import type { DocClass, DraftIntake, ReviewThreshold } from "./draftReceiptEngine";
import { ESCALATION_TRIGGERS } from "./draftIntakeSchemas";

// ── IntakeQuestion ────────────────────────────────────────────────────────────
// Static question catalog for chatbot / intake-wizard use.
// This is the catalog — not the interrogation logic.
// The interrogation logic (which questions to surface given current intake state)
// lives in getUnansweredRequiredQuestions().
export interface IntakeQuestion {
  /** Dot-path into DraftIntake, e.g. "equity.vesting_years" */
  field: string;
  /** Which doc classes this question applies to */
  doc_classes: DocClass[];
  /** Plain-language question for display */
  question_text: string;
  /** One sentence: legal consequence of the answer */
  why_it_matters: string;
  answer_type: "text" | "number" | "select" | "multi_select" | "boolean" | "party_list";
  /** For select / multi_select answer types */
  options?: string[];
  /** Suggested default shown in UI */
  default_value?: unknown;
  /** true = must be answered before draft can proceed */
  required: boolean;
  /** Review threshold that applies if this field is missing */
  review_threshold_if_missing: ReviewThreshold;
}

// ── Catalog ───────────────────────────────────────────────────────────────────
// All questions across all doc classes.
// Order within the catalog is display order within each doc class.
export const INTAKE_QUESTION_CATALOG: IntakeQuestion[] = [
  // ── Shared: jurisdiction ──────────────────────────────────────────────────
  {
    field: "jurisdiction",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement"],
    question_text: "In which US state will this agreement be governed?",
    why_it_matters:
      "Choice of governing law determines which state's rules apply to IP assignment, non-compete enforceability, and equity issuance.",
    answer_type: "select",
    options: ["DE", "CA", "NY", "WA", "TX"],
    required: true,
    review_threshold_if_missing: "blocked",
  },

  // ── Shared: parties ───────────────────────────────────────────────────────
  {
    field: "parties[*].entity_type",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement"],
    question_text: "Is each party an individual or a legal entity (LLC, C-Corp, etc.)?",
    why_it_matters:
      "Entity type affects liability, tax treatment, and the correct signature block. An individual signing on behalf of an entity they have not yet formed creates personal liability.",
    answer_type: "party_list",
    options: ["individual", "LLC", "C-Corp", "S-Corp", "partnership", "other"],
    required: false,
    review_threshold_if_missing: "business_review_required",
  },

  // ── Co-founder: equity ────────────────────────────────────────────────────
  {
    field: "equity.split",
    doc_classes: ["co_founder_agreement"],
    question_text: "What percentage of the company does each founder receive?",
    why_it_matters:
      "Equity allocation is the core economic term of the agreement. An undefined or incorrect split makes the agreement unexecutable.",
    answer_type: "text",
    required: true,
    review_threshold_if_missing: "blocked",
  },
  {
    field: "equity.vesting_years",
    doc_classes: ["co_founder_agreement", "advisor_agreement"],
    question_text: "Over how many years does equity vest?",
    why_it_matters:
      "Vesting period determines how long a founder or advisor must remain with the company to earn their full equity. A default of 4 years is applied if not specified.",
    answer_type: "select",
    options: ["2", "3", "4"],
    default_value: 4,
    required: false,
    review_threshold_if_missing: "business_review_required",
  },
  {
    field: "equity.cliff_months",
    doc_classes: ["co_founder_agreement", "advisor_agreement"],
    question_text: "How many months before the first shares vest (cliff period)?",
    why_it_matters:
      "The cliff protects the company if a founder or advisor leaves early. A default of 12 months is applied if not specified. Cliff must be less than the total vesting period.",
    answer_type: "select",
    options: ["6", "12"],
    default_value: 12,
    required: false,
    review_threshold_if_missing: "business_review_required",
  },
  {
    field: "equity.acceleration",
    doc_classes: ["co_founder_agreement", "advisor_agreement"],
    question_text: "Does vesting accelerate on a change of control?",
    why_it_matters:
      "Acceleration clauses determine whether unvested equity vests immediately on acquisition. Single-trigger fires on acquisition alone; double-trigger requires both acquisition and termination.",
    answer_type: "select",
    options: ["none", "single", "double"],
    default_value: "none",
    required: false,
    review_threshold_if_missing: "self_review_ok",
  },

  // ── Co-founder / Contractor: IP ───────────────────────────────────────────
  {
    field: "ip.scope",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment"],
    question_text:
      "Should the IP assignment cover all inventions during the engagement, or only work product delivered under this agreement?",
    why_it_matters:
      "Broad assignment captures all inventions, including those developed on personal time. Work-product-only is narrower and more contractor-friendly.",
    answer_type: "select",
    options: ["broad", "work_product_only"],
    default_value: "broad",
    required: true,
    review_threshold_if_missing: "counsel_review_required",
  },
  {
    field: "ip.prior_inventions",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment"],
    question_text:
      "Does the contractor or founder have any pre-existing inventions or IP they want to exclude from this assignment?",
    why_it_matters:
      "Without a prior inventions carve-out (Schedule A), a broad IP assignment may inadvertently capture work created before this engagement. A blank Schedule A is not protective.",
    answer_type: "multi_select",
    required: false,
    review_threshold_if_missing: "counsel_review_required",
  },

  // ── Advisor: services and compensation ────────────────────────────────────
  {
    field: "advisory.services_description",
    doc_classes: ["advisor_agreement"],
    question_text:
      "Describe the advisory services in plain language (e.g., 'strategic introductions and go-to-market advisory').",
    why_it_matters:
      "The services description defines the advisor's obligation. Without it, the agreement has no enforceable scope and the equity grant may be challenged.",
    answer_type: "text",
    required: true,
    review_threshold_if_missing: "counsel_review_required",
  },
  {
    field: "advisory.equity_pct",
    doc_classes: ["advisor_agreement"],
    question_text:
      "What percentage of the company's fully diluted capitalization will the advisor receive?",
    why_it_matters:
      "The equity percentage is the primary economic term for the advisor. Without it, the equity compensation section contains a placeholder and the agreement is not executable.",
    answer_type: "number",
    required: false,
    review_threshold_if_missing: "business_review_required",
  },
  {
    field: "advisory.cash_fee",
    doc_classes: ["advisor_agreement"],
    question_text: "Will the advisor receive a cash fee? If so, what is the amount?",
    why_it_matters:
      "A cash fee creates a payment obligation. If absent, the cash compensation section is omitted from the draft.",
    answer_type: "number",
    required: false,
    review_threshold_if_missing: "self_review_ok",
  },
];

// ── getQuestionsForDocClass ───────────────────────────────────────────────────
// Returns all questions that apply to the given doc class, in catalog order.
export function getQuestionsForDocClass(doc_class: DocClass): IntakeQuestion[] {
  return INTAKE_QUESTION_CATALOG.filter((q) => q.doc_classes.includes(doc_class));
}

// ── getUnansweredRequiredQuestions ────────────────────────────────────────────
// Pure function — does not mutate intake, no side effects.
// Returns required questions whose fields are absent in the current intake state.
// Used by a chatbot or intake wizard to determine what to ask next.
export function getUnansweredRequiredQuestions(
  intake: Partial<DraftIntake>,
  doc_class: DocClass,
): IntakeQuestion[] {
  const questions = getQuestionsForDocClass(doc_class);
  return questions.filter((q) => {
    if (!q.required) return false;
    return isFieldAbsent(q.field, intake);
  });
}

// ── isFieldAbsent ─────────────────────────────────────────────────────────────
// Resolves a dot-path into a partial intake object.
// Returns true if the value at the path is null, undefined, or an empty string.
// Handles the special "parties[*].entity_type" path by checking all party entries.
function isFieldAbsent(field: string, intake: Partial<DraftIntake>): boolean {
  // Special case: parties[*].entity_type — absent if any party is missing entity_type
  if (field === "parties[*].entity_type") {
    const parties = intake.parties;
    if (!parties || parties.length === 0) return true;
    return parties.some((p) => p.entity_type == null || p.entity_type.trim() === "");
  }

  const parts = field.split(".");
  let val: unknown = intake;
  for (const part of parts) {
    if (val == null || typeof val !== "object") return true;
    val = (val as Record<string, unknown>)[part];
  }
  if (val == null) return true;
  if (typeof val === "string" && val.trim() === "") return true;
  return false;
}

// ── getEscalatingAbsentFields ─────────────────────────────────────────────────
// Returns escalation triggers for fields that are absent in the current intake.
// Used by buildDraft() to generate missing_decision_prompts.
// Re-exported here for convenience — primary source is draftIntakeSchemas.ts.
export { ESCALATION_TRIGGERS } from "./draftIntakeSchemas";
