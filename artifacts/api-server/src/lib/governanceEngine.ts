/**
 * governanceEngine.ts — Governance evaluation for OpenClaw domain workforces.
 *
 * This module evaluates specialist output against a governance policy and
 * CHANGES BEHAVIOR based on the result. It is not an annotation layer.
 *
 * Behavior changes:
 *   - Privilege detection → redacts clause text in response (original not returned)
 *   - CA non-compete → escalates with §16600 citation
 *   - Low confidence → escalates
 *   - Missing required fields → escalates
 *   - Generic recommended actions only → escalates
 *
 * Impact tiering:
 *   action_triggering  — escalation_required = true, or blocking_issues present
 *   decision_support   — recommended_actions present and specific
 *   informational      — classification only, no recommended actions
 *
 * Usage:
 *   const decision = evaluateGovernance({ domain, specialist, output, rawText, confidence, policy });
 *   // decision.redacted_output is what you return to the caller
 *   // decision.audit_event is what you log to model_usage_events
 */

import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ImpactTier = "informational" | "decision_support" | "action_triggering";
export type GovernanceAction = "pass" | "escalate" | "block";

export interface EscalationRule {
  trigger: string;
  action: "escalate" | "block";
  reason: string;
}

export interface RedactionRule {
  trigger: string;
  field: string;
  replacement: string;
}

export interface GovernancePolicy {
  confidence_threshold: number;
  privilege_detection: boolean;
  escalation_rules: EscalationRule[];
  redaction_rules: RedactionRule[];
  audit_required: boolean;
  default_impact_tier: ImpactTier;
}

export interface AuditEvent {
  matter_id: string;
  domain: string;
  specialist: string;
  governance_action: GovernanceAction;
  escalation_triggered: boolean;
  escalation_reasons: string[];
  redacted_fields: string[];
  impact_tier: ImpactTier;
  logged_at: string;
}

export interface GovernanceDecision {
  action: GovernanceAction;
  escalation_required: boolean;
  escalation_reasons: string[];
  redacted_fields: string[];
  impact_tier: ImpactTier;
  redacted_output: Record<string, unknown>;  // the output with redactions applied
  audit_event: AuditEvent;
}

export interface GovernanceInput {
  matter_id: string;
  domain: string;
  specialist: string;
  output: Record<string, unknown>;
  raw_text: string;
  confidence: number | null;
  policy: GovernancePolicy;
}

// ── Privilege keyword detection ───────────────────────────────────────────────

const PRIVILEGE_PATTERNS = [
  /attorney[- ]client/i,
  /privileged\s+and\s+confidential/i,
  /work\s+product/i,
  /attorney[- ]work[- ]product/i,
  /legal\s+privilege/i,
  /privileged\s+communication/i,
];

export function detectPrivilege(text: string): boolean {
  return PRIVILEGE_PATTERNS.some((p) => p.test(text));
}

// ── CA non-compete detection ──────────────────────────────────────────────────

const CA_NONCOMPETE_PATTERNS = [
  /non[- ]compete/i,
  /non[- ]solicitation/i,
  /noncompete/i,
  /nonsolicitation/i,
  /not\s+to\s+compete/i,
  /agree[sd]?\s+not\s+to\s+compete/i,
  /shall\s+not\s+compete/i,
  /not\s+to\s+solicit/i,
  /agree[sd]?\s+not\s+to\s+solicit/i,
  /shall\s+not\s+solicit/i,
  /covenant\s+not\s+to\s+compete/i,
  /restrictive\s+covenant/i,
];
const CA_JURISDICTION_PATTERNS = [/california/i, /\bCA\b/, /cal\./i];

export function detectCANonCompete(text: string, jurisdiction?: string): boolean {
  const hasNonCompete = CA_NONCOMPETE_PATTERNS.some((p) => p.test(text));
  const hasCAJurisdiction =
    CA_JURISDICTION_PATTERNS.some((p) => p.test(text)) ||
    (jurisdiction ? CA_JURISDICTION_PATTERNS.some((p) => p.test(jurisdiction)) : false);
  return hasNonCompete && hasCAJurisdiction;
}

// ── Generic action detection ──────────────────────────────────────────────────

const GENERIC_ACTION_PATTERNS = [
  /^(review|consult|seek|consider)\s+(with\s+)?(counsel|attorney|lawyer|legal\s+counsel)\.?$/i,
  /^seek\s+legal\s+advice\.?$/i,
  /^consult\s+an?\s+attorney\.?$/i,
  /^review\s+with\s+counsel\.?$/i,
  /^obtain\s+legal\s+advice\.?$/i,
];

export function isGenericAction(action: string): boolean {
  const trimmed = action.trim();
  return GENERIC_ACTION_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length < 30;
}

/**
 * Extract all recommended action strings from a specialist output object.
 * Looks for: recommended_action (string), recommended_actions (array),
 * next_steps (array), and nested recommended_action inside flags arrays.
 */
export function extractAllRecommendedActions(output: Record<string, unknown>): string[] {
  const actions: string[] = [];

  // Top-level recommended_actions / next_steps
  for (const key of ["recommended_actions", "next_steps", "recommended_next_steps"]) {
    const val = output[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") actions.push(item);
        else if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (typeof obj.recommended_action === "string") actions.push(obj.recommended_action);
          if (typeof obj.action === "string") actions.push(obj.action);
        }
      }
    }
  }

  // Nested inside flags arrays
  for (const key of ["risk_flags", "compliance_flags", "governance_clauses", "key_restrictions"]) {
    const val = output[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (typeof obj.recommended_action === "string") actions.push(obj.recommended_action);
        }
      }
    }
  }

  return actions;
}

// ── Redaction ─────────────────────────────────────────────────────────────────

/**
 * Apply redaction rules to output. Returns a deep copy with redacted fields replaced.
 * Redaction applies to string fields and string values inside arrays of objects.
 */
export function applyRedactions(
  output: Record<string, unknown>,
  redactedFields: string[],
  replacement: string,
): Record<string, unknown> {
  if (redactedFields.length === 0) return output;

  const redacted = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;

  function redactValue(obj: Record<string, unknown>): void {
    for (const field of redactedFields) {
      if (field in obj) {
        if (typeof obj[field] === "string") {
          obj[field] = replacement;
        }
      }
    }
    // Recurse into arrays of objects
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "object" && item !== null) {
            redactValue(item as Record<string, unknown>);
          }
        }
      }
    }
  }

  redactValue(redacted);
  return redacted;
}

// ── Impact tier assignment ────────────────────────────────────────────────────

export function assignImpactTier(
  output: Record<string, unknown>,
  escalationRequired: boolean,
  policy: GovernancePolicy,
): ImpactTier {
  // action_triggering: escalation required, or blocking_issues present
  if (escalationRequired) return "action_triggering";
  const blockingIssues = output["blocking_issues"];
  if (Array.isArray(blockingIssues) && blockingIssues.length > 0) return "action_triggering";

  // decision_support: recommended actions present and at least one is specific
  const actions = extractAllRecommendedActions(output);
  if (actions.length > 0 && actions.some((a) => !isGenericAction(a))) return "decision_support";

  // informational: classification only
  return "informational";
}

// ── Main evaluation function ──────────────────────────────────────────────────

export function evaluateGovernance(input: GovernanceInput): GovernanceDecision {
  const { matter_id, domain, specialist, output, raw_text, confidence, policy } = input;

  const escalationReasons: string[] = [];
  const redactedFields: string[] = [];
  let action: GovernanceAction = "pass";

  // 1. Privilege detection → redact + escalate
  if (policy.privilege_detection && detectPrivilege(raw_text)) {
    escalationReasons.push("privilege_detected — attorney-client privilege or work product detected in input");
    // Redact clause_text fields in output
    redactedFields.push("clause_text", "text", "excerpt");
    action = "escalate";
  }

  // 2. CA non-compete detection (employment domain)
  if (specialist === "employment" || domain === "hr") {
    const jurisdiction = typeof output["jurisdiction"] === "string" ? output["jurisdiction"] : undefined;
    if (detectCANonCompete(raw_text, jurisdiction)) {
      escalationReasons.push("CA non-compete — void under CA Bus & Prof Code §16600");
      action = "escalate";
    }
  }

  // 2b. Specialist-reported escalation passthrough
  // If the specialist itself sets escalation_required = true (e.g., employment CA non-compete
  // detected by applyCANoncompeteRule), the governance engine must honor it.
  if (output["escalation_required"] === true && !escalationReasons.some(r => r.includes("CA non-compete"))) {
    const specialistReason = typeof output["ca_noncompete_void"] === "boolean" && output["ca_noncompete_void"] === true
      ? "CA non-compete — void under CA Bus & Prof Code §16600"
      : "specialist_escalation — specialist flagged escalation_required";
    escalationReasons.push(specialistReason);
    action = "escalate";
  }

  // 3. Low confidence gate
  if (confidence !== null && confidence < policy.confidence_threshold) {
    escalationReasons.push(`low_confidence — confidence ${confidence.toFixed(2)} below threshold ${policy.confidence_threshold}`);
    action = "escalate";
  }

  // 4. Generic recommended actions only
  const allActions = extractAllRecommendedActions(output);
  if (allActions.length > 0 && allActions.every((a) => isGenericAction(a))) {
    escalationReasons.push("non_specific_output — all recommended actions are generic");
    action = "escalate";
  }

  // 5. Apply custom escalation rules from policy
  for (const rule of policy.escalation_rules) {
    // Custom rules are evaluated by trigger string matching against known triggers
    // (privilege and CA non-compete already handled above — skip duplicates)
    if (
      rule.trigger === "privilege_keywords_in_text" ||
      rule.trigger === "ca_noncompete_detected" ||
      rule.trigger === "confidence_below_threshold" ||
      rule.trigger === "non_specific_output"
    ) {
      continue; // already handled
    }
    // Domain-specific rules (e.g., warn_act_applicable, discrimination_risk)
    if (rule.trigger === "warn_act_applicable" && output["warn_act_applicable"] === true) {
      escalationReasons.push(rule.reason);
      action = rule.action;
    }
    if (rule.trigger === "discrimination_risk" && output["discrimination_risk"] === true) {
      escalationReasons.push(rule.reason);
      action = rule.action;
    }
  }

  // 6. Co-founder governance rules (specialist === "cofounder")
  if (specialist === "cofounder") {
    const cfTriggered = evaluateCofounderGovernance(raw_text);
    for (const { reason } of cfTriggered) {
      if (!escalationReasons.includes(reason)) {
        escalationReasons.push(reason);
        action = "escalate";
      }
    }
    // Also escalate if specialist output has blocking_issues or critical overall_risk
    if (output["overall_risk"] === "critical") {
      if (!escalationReasons.some(r => r.includes("critical"))) {
        escalationReasons.push("co-founder agreement has critical risk — attorney review required before signing");
        action = "escalate";
      }
    }
    if (Array.isArray(output["blocking_issues"]) && (output["blocking_issues"] as unknown[]).length > 0) {
      if (!escalationReasons.some(r => r.includes("blocking"))) {
        escalationReasons.push(`blocking issues present — ${(output["blocking_issues"] as string[]).length} issue(s) must be resolved before signing`);
        action = "escalate";
      }
    }
  }

  const escalationRequired = action !== "pass";

  // Apply redactions
  const replacement = "[REDACTED — privilege review required]";
  const redactedOutput = applyRedactions(output, redactedFields, replacement);

  // Assign impact tier
  const impactTier = assignImpactTier(output, escalationRequired, policy);

  const auditEvent: AuditEvent = {
    matter_id,
    domain,
    specialist,
    governance_action: action,
    escalation_triggered: escalationRequired,
    escalation_reasons: escalationReasons,
    redacted_fields: redactedFields,
    impact_tier: impactTier,
    logged_at: new Date().toISOString(),
  };

  return {
    action,
    escalation_required: escalationRequired,
    escalation_reasons: escalationReasons,
    redacted_fields: redactedFields,
    impact_tier: impactTier,
    redacted_output: redactedOutput,
    audit_event: auditEvent,
  };
}

// ── Co-founder governance trigger detection ───────────────────────────────────

/**
 * Detect 83(b) window risk: equity/vesting mentioned but no 83(b) reference.
 * The 30-day IRS window is non-waivable — missing = permanent tax disaster.
 */
export function detect83bWindowRisk(text: string): boolean {
  const hasEquityOrVesting = /\b(vest|vesting|equity|restricted stock|rspa|shares|stock grant|founder shares)\b/i.test(text);
  const has83b = /83\s*\(?\s*b\s*\)?|section\s+83/i.test(text);
  return hasEquityOrVesting && !has83b;
}

/**
 * Detect RUO clinical risk: RUO materials mentioned alongside clinical/diagnostic/patient context.
 */
export function detectRuoClinicalRisk(text: string): boolean {
  const hasRuo = /\b(ruo|research use only)\b/i.test(text);
  const hasClinical = /\b(clinical|diagnostic|patient|therapeutic|treatment|diagnosis|fda clearance|510k|pma)\b/i.test(text);
  // Also flag if CMO/medical role present without RUO disclaimer
  const hasCmoRole = /\b(cmo|chief medical|medical officer|physician|doctor)\b/i.test(text);
  const hasRuoDisclaimer = /\b(not.*clinical|not.*diagnostic|research.*only|ruo.*limitation|scope.*limitation)\b/i.test(text);
  return (hasRuo && hasClinical) || (hasCmoRole && !hasRuoDisclaimer);
}

/**
 * Detect equity dilution risk: equity % mentioned without multi-product pool or anti-dilution.
 */
export function detectEquityDilutionRisk(text: string): boolean {
  const hasEquityPct = /\b\d+\s*%\s*(equity|ownership|interest|shares)\b|\b(equity|ownership|interest)\s+of\s+\d+\s*%/i.test(text);
  const hasMultiProduct = /\b(vetonce|longevity|deepcrispr|product entity|subsidiary|spinout|anti.?dilution|dilution protection|pro.?rata)\b/i.test(text);
  return hasEquityPct && !hasMultiProduct;
}

/**
 * Detect broad IP assignment: "all inventions" or "all works" without carve-out.
 */
export function detectBroadIpAssignment(text: string): boolean {
  const hasBroadAssignment = /\b(all\s+inventions|all\s+works|all\s+intellectual\s+property|all\s+ip|all\s+right.*title.*interest)\b/i.test(text);
  const hasCarveOut = /\b(prior\s+invention|background\s+ip|retained|carve.?out|exhibit\s+[a-z]|schedule\s+[a-z]|except.*prior)\b/i.test(text);
  return hasBroadAssignment && !hasCarveOut;
}

/**
 * Detect unresolved incorporation: S-Corp or non-profit mentioned without resolution.
 */
export function detectIncorporationUnresolved(text: string): boolean {
  const hasSCorp = /\b(s.?corp|subchapter\s+s)\b/i.test(text);
  const hasNonProfit = /\b(non.?profit|nonprofit|501\s*\(?\s*c\s*\)?\s*\(?\s*3\s*\)?)\b/i.test(text);
  const hasResolution = /\b(shall\s+be\s+incorporated|is\s+incorporated|entity\s+type\s+is|resolved\s+as|confirmed\s+as)\b/i.test(text);
  return (hasSCorp || hasNonProfit) && !hasResolution;
}

// ── Default legal governance policy ──────────────────────────────────────────

export const LEGAL_GOVERNANCE_POLICY: GovernancePolicy = {
  confidence_threshold: 0.5,
  privilege_detection: true,
  escalation_rules: [
    { trigger: "privilege_keywords_in_text", action: "escalate", reason: "Privilege detected — counsel review required" },
    { trigger: "ca_noncompete_detected", action: "escalate", reason: "CA non-compete — void under CA Bus & Prof Code §16600" },
    { trigger: "confidence_below_threshold", action: "escalate", reason: "low_confidence" },
    { trigger: "incomplete_output", action: "escalate", reason: "incomplete_output" },
    { trigger: "non_specific_output", action: "escalate", reason: "non_specific_output" },
    // Co-founder governance rules (Pass 2)
    { trigger: "83b_window_risk", action: "escalate", reason: "83(b) election window — 30-day IRS deadline from grant date. Missing from agreement." },
    { trigger: "ruo_clinical_risk", action: "escalate", reason: "RUO materials in clinical context — FDA violation risk. Scope must be explicitly limited." },
    { trigger: "equity_no_dilution_protection", action: "escalate", reason: "Equity dilution undefined across multi-product structure — 30% may not be protected." },
    { trigger: "ip_broad_assignment", action: "escalate", reason: "Broad IP assignment may capture pre-existing CMO medical IP — carve-out required." },
    { trigger: "incorporation_unresolved", action: "escalate", reason: "Entity type unresolved — S-Corp vs. non-profit affects 83(b) validity and equity structure." },
  ],
  redaction_rules: [
    { trigger: "privilege_keywords_in_text", field: "clause_text", replacement: "[REDACTED — privilege review required]" },
  ],
  audit_required: true,
  default_impact_tier: "decision_support",
};

// ── Co-founder governance evaluation (called from evaluateGovernance for cofounder specialist) ──

/**
 * Run co-founder-specific governance checks against raw text.
 * Returns triggered rule IDs and reasons.
 */
export function evaluateCofounderGovernance(rawText: string): Array<{ trigger: string; reason: string }> {
  const triggered: Array<{ trigger: string; reason: string }> = [];

  if (detect83bWindowRisk(rawText)) {
    triggered.push({ trigger: "83b_window_risk", reason: "83(b) election window — 30-day IRS deadline from grant date. Missing from agreement." });
  }
  if (detectRuoClinicalRisk(rawText)) {
    triggered.push({ trigger: "ruo_clinical_risk", reason: "RUO materials in clinical context — FDA violation risk. Scope must be explicitly limited." });
  }
  if (detectEquityDilutionRisk(rawText)) {
    triggered.push({ trigger: "equity_no_dilution_protection", reason: "Equity dilution undefined across multi-product structure — 30% may not be protected." });
  }
  if (detectBroadIpAssignment(rawText)) {
    triggered.push({ trigger: "ip_broad_assignment", reason: "Broad IP assignment may capture pre-existing CMO medical IP — carve-out required." });
  }
  if (detectIncorporationUnresolved(rawText)) {
    triggered.push({ trigger: "incorporation_unresolved", reason: "Entity type unresolved — S-Corp vs. non-profit affects 83(b) validity and equity structure." });
  }

  return triggered;
}
