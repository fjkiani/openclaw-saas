import type { DocClass, ReviewThreshold } from "./draftReceiptEngine";

// ═════════════════════════════════════════════════════════════════════════════
// GROUP A: Structural validation schemas
// ─────────────────────────────────────────────────────────────────────────────
// These schemas validate intake shape and required fields only.
// They do NOT encode review policy, escalation thresholds, or risk levels.
// A structural schema change (adding/removing a field) must not affect Group B.
// ═════════════════════════════════════════════════════════════════════════════

// JSON Schema draft-07 type alias (no external dependency required)
type JSONSchema = Record<string, unknown>;

const PARTY_SCHEMA: JSONSchema = {
  type: "object",
  required: ["name", "role"],
  properties: {
    name: { type: "string", minLength: 1 },
    role: { type: "string", minLength: 1 },
    entity_type: { type: "string" },
  },
  additionalProperties: false,
};

const PARTIES_SCHEMA: JSONSchema = {
  type: "array",
  minItems: 2,
  items: PARTY_SCHEMA,
};

export const CO_FOUNDER_INTAKE_SCHEMA: JSONSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CoFounderIntake",
  type: "object",
  required: ["doc_class", "jurisdiction", "parties"],
  properties: {
    doc_class: { type: "string", const: "co_founder_agreement" },
    jurisdiction: { type: "string", minLength: 1 },
    parties: PARTIES_SCHEMA,
    effective_date: { type: "string" },
    equity: {
      type: "object",
      properties: {
        split: {
          type: "object",
          additionalProperties: { type: "number", minimum: 0, maximum: 100 },
        },
        vesting_years: { type: "number", minimum: 1, maximum: 10 },
        cliff_months: { type: "number", minimum: 0 },
        acceleration: { type: "string", enum: ["single", "double", "none"] },
      },
      additionalProperties: false,
    },
    ip: {
      type: "object",
      properties: {
        prior_inventions: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["broad", "work_product_only"] },
      },
      additionalProperties: false,
    },
    user_instruction: { type: "string", maxLength: 500 },
    allow_model_clause_rewrite: { type: "boolean" },
  },
  additionalProperties: false,
};

export const CONTRACTOR_IP_INTAKE_SCHEMA: JSONSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ContractorIPIntake",
  type: "object",
  required: ["doc_class", "jurisdiction", "parties", "ip"],
  properties: {
    doc_class: { type: "string", const: "contractor_ip_assignment" },
    jurisdiction: { type: "string", minLength: 1 },
    parties: PARTIES_SCHEMA,
    effective_date: { type: "string" },
    ip: {
      type: "object",
      required: ["scope"],
      properties: {
        prior_inventions: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["broad", "work_product_only"] },
      },
      additionalProperties: false,
    },
    user_instruction: { type: "string", maxLength: 500 },
    allow_model_clause_rewrite: { type: "boolean" },
  },
  additionalProperties: false,
};

export const ADVISOR_INTAKE_SCHEMA: JSONSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AdvisorIntake",
  type: "object",
  required: ["doc_class", "jurisdiction", "parties"],
  properties: {
    doc_class: { type: "string", const: "advisor_agreement" },
    jurisdiction: { type: "string", minLength: 1 },
    parties: PARTIES_SCHEMA,
    effective_date: { type: "string" },
    equity: {
      type: "object",
      properties: {
        vesting_years: { type: "number", minimum: 1, maximum: 10 },
        cliff_months: { type: "number", minimum: 0 },
        acceleration: { type: "string", enum: ["single", "double", "none"] },
      },
      additionalProperties: false,
    },
    advisory: {
      type: "object",
      properties: {
        equity_pct: { type: "number", minimum: 0, maximum: 100 },
        services_description: { type: "string", minLength: 1 },
        cash_fee: { type: "number", minimum: 0 },
      },
      additionalProperties: false,
    },
    user_instruction: { type: "string", maxLength: 500 },
    allow_model_clause_rewrite: { type: "boolean" },
  },
  additionalProperties: false,
};

export const INTAKE_SCHEMAS: Record<DocClass, JSONSchema> = {
  co_founder_agreement: CO_FOUNDER_INTAKE_SCHEMA,
  contractor_ip_assignment: CONTRACTOR_IP_INTAKE_SCHEMA,
  advisor_agreement: ADVISOR_INTAKE_SCHEMA,
};

// ═════════════════════════════════════════════════════════════════════════════
// GROUP B: Escalation / review policy metadata
// ─────────────────────────────────────────────────────────────────────────────
// These objects encode review policy: what review threshold applies when a
// field is absent, and whether the draft should be blocked.
// They are NOT structural validation — they do not describe field types or shapes.
// A policy change (e.g. escalating a threshold) must not require touching Group A.
// ═════════════════════════════════════════════════════════════════════════════

export interface EscalationTrigger {
  /** Dot-path into DraftIntake, e.g. "ip.prior_inventions" */
  field: string;
  /** Which doc classes this trigger applies to */
  doc_classes: DocClass[];
  /** Plain-language consequence of the field being absent */
  risk_if_absent: string;
  /** Review threshold that applies when this field is absent */
  review_threshold: ReviewThreshold;
  /** true = draft should not proceed without this field */
  blocking: boolean;
}

export const ESCALATION_TRIGGERS: EscalationTrigger[] = [
  {
    field: "equity.split",
    doc_classes: ["co_founder_agreement"],
    risk_if_absent:
      "Equity allocation is undefined — the agreement is incomplete and unexecutable.",
    review_threshold: "blocked",
    blocking: true,
  },
  {
    field: "advisory.services_description",
    doc_classes: ["advisor_agreement"],
    risk_if_absent:
      "Advisory services section has no defined scope — the agreement has no enforceable obligation.",
    review_threshold: "counsel_review_required",
    blocking: true,
  },
  {
    field: "ip.prior_inventions",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment"],
    risk_if_absent:
      "Broad IP assignment may inadvertently capture pre-existing work. Prior inventions carve-out (Schedule A) is blank.",
    review_threshold: "counsel_review_required",
    blocking: false,
  },
  {
    field: "equity.vesting_years",
    doc_classes: ["co_founder_agreement", "advisor_agreement"],
    risk_if_absent:
      "Default 4-year vesting with 1-year cliff applied — may not reflect negotiated terms.",
    review_threshold: "business_review_required",
    blocking: false,
  },
  {
    field: "advisory.equity_pct",
    doc_classes: ["advisor_agreement"],
    risk_if_absent:
      "Equity compensation section contains a placeholder — the agreement is not executable without a defined percentage.",
    review_threshold: "business_review_required",
    blocking: false,
  },
  {
    field: "parties[*].entity_type",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement"],
    risk_if_absent:
      "Entity type affects liability, tax treatment, and signature block. Unspecified entity type may produce an incorrect agreement structure.",
    review_threshold: "business_review_required",
    blocking: false,
  },
];

// ── Helper: look up escalation trigger by field and doc_class ─────────────────
export function getEscalationTrigger(
  field: string,
  doc_class: DocClass,
): EscalationTrigger | undefined {
  return ESCALATION_TRIGGERS.find(
    (t) => t.field === field && t.doc_classes.includes(doc_class),
  );
}
