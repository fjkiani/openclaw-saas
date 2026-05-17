/**
 * legalPlaybook.ts — 10 core scenarios for the legal workforce.
 *
 * Runs against POST /api/v1/legal/matter (internal function call, not HTTP).
 * Asserts: routing correctness, required field presence, content quality, governance behavior.
 *
 * Content quality assertions (not just field presence):
 *   - At least one recommended action must be specific and non-generic
 *   - Risk/compliance flags must reference detected clause text or a named rule
 *   - Empty arrays only allowed when scenario explicitly expects_empty_arrays
 *   - Governance must act correctly (escalate when expected, pass when expected)
 *
 * Expand to 20 scenarios after orchestration path is stable.
 */

import { isGenericAction, extractAllRecommendedActions } from "./governanceEngine.js";

// ── Scenario types ────────────────────────────────────────────────────────────

export type ScenarioPath = "normal" | "full_work" | "escalation" | "error";

export interface PlaybookScenario {
  id: number;
  specialist: string;
  path: ScenarioPath;
  description: string;
  input_text: string;
  expects_routing: string;           // expected matter_type from intake
  expects_escalation: boolean;       // should governance escalate?
  expects_escalation_reason?: string; // substring that must appear in escalation_reasons
  expects_redaction?: boolean;       // should clause text be redacted?
  expects_impact_tier?: string;      // expected impact_tier
  required_fields: string[];         // fields that must be present in specialist_output
  expects_empty_arrays?: string[];   // fields where empty array is acceptable
  expects_error?: boolean;           // scenario expects a non-200 response
  full_work: boolean;                // apply content quality assertions
}

export interface ScenarioResult {
  scenario_id: number;
  specialist: string;
  path: ScenarioPath;
  passed: boolean;
  routing_correct: boolean;
  required_fields_present: boolean;
  missing_fields: string[];
  content_quality_passed: boolean;
  has_specific_action: boolean;
  flags_have_evidence: boolean;
  no_unexpected_empty_arrays: boolean;
  governance_correct: boolean;
  escalation_correct: boolean;
  redaction_correct: boolean;
  impact_tier_correct: boolean;
  impact_tier_actual: string | null;
  latency_ms: number;
  failure_reasons: string[];
  matter_id: string | null;
}

export interface PlaybookReceipt {
  run_id: string;
  run_date: string;
  scenarios_total: number;
  scenarios_passed: number;
  scenarios_failed: number;
  routing_accuracy: number;
  required_fields_present_rate: number;
  content_quality_pass_rate: number;
  governance_acted_correctly_rate: number;
  error_handling_pass_rate: number;
  avg_latency_ms: number;
  results: ScenarioResult[];
}

// ── 10 core scenarios ─────────────────────────────────────────────────────────

export const CORE_SCENARIOS: PlaybookScenario[] = [
  // ── Scenario 1: Contract — Normal ──────────────────────────────────────────
  {
    id: 1,
    specialist: "contract",
    path: "normal",
    description: "Standard contract with governing law and termination clauses. Routes correctly, all required fields present, governance passes.",
    input_text: `This Agreement shall be governed by the laws of the State of New York. Either party may terminate this Agreement upon thirty (30) days written notice. The limitation of liability clause caps damages at the total fees paid in the preceding twelve months.`,
    expects_routing: "contract",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["risk_flags", "blocking_issues", "next_steps", "overall_risk"],
    full_work: false,
  },

  // ── Scenario 2: Contract — Full Work ──────────────────────────────────────
  {
    id: 2,
    specialist: "contract",
    path: "full_work",
    description: "High-risk contract with IP assignment and indemnification. risk_flags must reference detected clauses, next_steps must be specific.",
    input_text: `SOFTWARE LICENSE AGREEMENT. Licensor grants Licensee a non-exclusive, non-transferable license to use the Software for internal business purposes only. Licensee shall not sublicense, sell, or distribute the Software. All modifications and derivative works created by Licensee shall be automatically assigned to Licensor upon creation. Licensor's total liability shall not exceed fees paid in the preceding 12 months. This Agreement shall be governed by the laws of the State of Delaware.`,
    expects_routing: "contract",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["risk_flags", "blocking_issues", "next_steps", "overall_risk"],
    full_work: true,
  },

  // ── Scenario 3: Contract — Privilege Escalation ───────────────────────────
  {
    id: 3,
    specialist: "contract",
    path: "escalation",
    description: "Contract text contains attorney-client privilege marker. Clause text must be redacted, escalation required.",
    input_text: `PRIVILEGED AND CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION. This draft agreement has been prepared by outside counsel for review. The limitation of liability clause in Section 8 caps damages at $500,000. Either party may terminate upon 60 days notice.`,
    expects_routing: "contract",
    expects_escalation: true,
    expects_escalation_reason: "privilege_detected",
    expects_redaction: true,
    expects_impact_tier: "action_triggering",
    required_fields: ["risk_flags", "blocking_issues", "next_steps", "overall_risk"],
    full_work: false,
  },

  // ── Scenario 4: Employment — Normal ───────────────────────────────────────
  {
    id: 4,
    specialist: "employment",
    path: "normal",
    description: "Standard employment agreement with at-will clause. Routes correctly, compliance_flags present, ca_noncompete_void populated.",
    input_text: `This is an at-will employment agreement. Employee's employment may be terminated by either party at any time, with or without cause. Employee will receive two weeks severance upon termination without cause. Employee agrees to maintain confidentiality of Company trade secrets during and after employment.`,
    expects_routing: "employment",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["compliance_flags", "ca_noncompete_void", "escalation_required", "next_steps"],
    full_work: false,
  },

  // ── Scenario 5: Employment — CA Non-Compete Escalation ────────────────────
  {
    id: 5,
    specialist: "employment",
    path: "escalation",
    description: "Employment agreement with non-compete clause in California. Must escalate with §16600 citation.",
    input_text: `This Employment Agreement is governed by the laws of the State of California. Employee agrees not to compete with Company for a period of two (2) years following termination of employment within the State of California. Employee further agrees not to solicit Company's customers or employees for one (1) year post-termination.`,
    expects_routing: "employment",
    expects_escalation: true,
    expects_escalation_reason: "§16600",
    expects_impact_tier: "action_triggering",
    required_fields: ["compliance_flags", "ca_noncompete_void", "escalation_required", "next_steps"],
    full_work: false,
  },

  // ── Scenario 6: Employment — Full Work ────────────────────────────────────
  {
    id: 6,
    specialist: "employment",
    path: "full_work",
    description: "Complex employment agreement with multiple compliance issues. compliance_flags must reference detected rules, next_steps must be specific.",
    input_text: `This Employment Agreement covers a position in New York. Employee is classified as exempt from overtime under the FLSA administrative exemption. Employee will work remotely but must be available during core hours 9am-3pm EST. The agreement includes a mandatory arbitration clause for all employment disputes, waiving the right to jury trial. Employee is entitled to 10 days PTO in year one, increasing to 15 days after two years. The non-disparagement clause prohibits Employee from making any public statements about Company following termination.`,
    expects_routing: "employment",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["compliance_flags", "ca_noncompete_void", "escalation_required", "next_steps"],
    full_work: true,
  },

  // ── Scenario 7: Litigation — Normal ───────────────────────────────────────
  {
    id: 7,
    specialist: "litigation",
    path: "normal",
    description: "Breach of contract dispute. key_claims extracted from input text, recommended_next_steps specific.",
    input_text: `Plaintiff alleges that Defendant breached the Software License Agreement dated January 15, 2024 by failing to deliver the contracted software modules by the agreed deadline of March 31, 2024. Plaintiff seeks damages of $250,000 representing lost revenue and cover costs. The agreement was governed by New York law with disputes to be resolved in New York courts. Plaintiff filed suit on April 15, 2024.`,
    expects_routing: "litigation",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["key_claims", "jurisdiction", "recommended_next_steps", "statute_of_limitations_risk"],
    full_work: true,
  },

  // ── Scenario 8: IP — Full Work ────────────────────────────────────────────
  {
    id: 8,
    specialist: "ip",
    path: "full_work",
    description: "IP assignment clause with ownership risk. recommended_actions must reference specific IP issue detected.",
    input_text: `Contractor hereby assigns to Client all intellectual property rights in the deliverables created under this Agreement, including all copyrights, patents, and trade secrets. However, Contractor retains ownership of pre-existing tools, frameworks, and methodologies used in creating the deliverables. Client acknowledges that the deliverables may incorporate Contractor's proprietary background IP. No license to Contractor's background IP is granted beyond what is necessary to use the deliverables.`,
    expects_routing: "ip",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["ip_type", "ownership_risk", "recommended_actions", "key_restrictions"],
    full_work: true,
  },

  // ── Scenario 9: Corporate — Full Work ─────────────────────────────────────
  {
    id: 9,
    specialist: "corporate",
    path: "full_work",
    description: "Board approval and compliance obligations. compliance_gaps must reference specific obligations, next_steps specific.",
    input_text: `The Board of Directors hereby approves the acquisition of XYZ Corp for a total consideration of $5 million, subject to shareholder approval at the next annual meeting. The transaction requires filing under Hart-Scott-Rodino if the threshold is met. The Board delegates authority to the CEO to negotiate final terms within a 10% variance of the approved consideration. All directors with a material interest in XYZ Corp must recuse themselves from the vote. The acquisition must close within 90 days of this resolution.`,
    expects_routing: "corporate",
    expects_escalation: false,
    expects_impact_tier: "decision_support",
    required_fields: ["governance_clauses", "board_approval_required", "compliance_gaps", "next_steps"],
    full_work: true,
  },

  // ── Scenario 10: Error Path ────────────────────────────────────────────────
  {
    id: 10,
    specialist: "any",
    path: "error",
    description: "Input text too short (<20 chars). Must return 400 with error field. Governance block still present in error response.",
    input_text: "short",
    expects_routing: "any",
    expects_escalation: false,
    required_fields: [],
    full_work: false,
    expects_error: true,
  },
];

// ── Content quality assertions ────────────────────────────────────────────────

function assertContentQuality(
  scenario: PlaybookScenario,
  specialistOutput: Record<string, unknown>,
): {
  passed: boolean;
  has_specific_action: boolean;
  flags_have_evidence: boolean;
  no_unexpected_empty_arrays: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // 1. At least one specific recommended action
  const allActions = extractAllRecommendedActions(specialistOutput);
  const hasSpecificAction = allActions.length > 0 && allActions.some((a) => !isGenericAction(a));
  if (!hasSpecificAction && allActions.length > 0) {
    reasons.push("all recommended actions are generic — no specific action found");
  }
  if (allActions.length === 0) {
    reasons.push("no recommended actions found in output");
  }

  // 2. Flags reference detected text or named rule
  const allFlags: Array<Record<string, unknown>> = [];
  for (const key of ["risk_flags", "compliance_flags", "governance_clauses"]) {
    const val = specialistOutput[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "object" && item !== null) {
          allFlags.push(item as Record<string, unknown>);
        }
      }
    }
  }
  const flagsHaveEvidence =
    allFlags.length === 0 ||
    allFlags.every((f) => {
      return (
        typeof f["clause_text"] === "string" ||
        typeof f["rule"] === "string" ||
        typeof f["detected_text"] === "string" ||
        typeof f["text"] === "string" ||
        typeof f["notes"] === "string"
      );
    });
  if (!flagsHaveEvidence) {
    reasons.push("some flags lack reference to detected clause text or named rule");
  }

  // 3. No unexpected empty arrays
  const unexpectedEmpty: string[] = [];
  for (const field of scenario.required_fields) {
    const val = specialistOutput[field];
    if (Array.isArray(val) && val.length === 0) {
      if (!scenario.expects_empty_arrays?.includes(field)) {
        unexpectedEmpty.push(field);
      }
    }
  }
  if (unexpectedEmpty.length > 0) {
    reasons.push(`unexpected empty arrays: ${unexpectedEmpty.join(", ")}`);
  }

  const passed = hasSpecificAction && flagsHaveEvidence && unexpectedEmpty.length === 0;

  return {
    passed,
    has_specific_action: hasSpecificAction,
    flags_have_evidence: flagsHaveEvidence,
    no_unexpected_empty_arrays: unexpectedEmpty.length === 0,
    reasons,
  };
}

// ── Scenario runner ───────────────────────────────────────────────────────────

/**
 * Run a single scenario against the matter handler function.
 * matterFn is the internal handler — not an HTTP call.
 */
export async function runScenario(
  scenario: PlaybookScenario,
  matterFn: (text: string) => Promise<{
    matter_id?: string;
    intake?: { matter_type?: string };
    specialist_output?: Record<string, unknown>;
    governance_decision?: {
      escalation_required?: boolean;
      escalation_reasons?: string[];
      redacted_fields?: string[];
      impact_tier?: string;
    };
    error?: string;
    status?: number;
  }>,
): Promise<ScenarioResult> {
  const t0 = Date.now();
  const failureReasons: string[] = [];

  try {
    const result = await matterFn(scenario.input_text);
    const latencyMs = Date.now() - t0;

    // Error path scenarios
    if (scenario.expects_error) {
      const isError = !!result.error || (result.status !== undefined && result.status >= 400);
      return {
        scenario_id: scenario.id,
        specialist: scenario.specialist,
        path: scenario.path,
        passed: isError,
        routing_correct: true,
        required_fields_present: true,
        missing_fields: [],
        content_quality_passed: true,
        has_specific_action: true,
        flags_have_evidence: true,
        no_unexpected_empty_arrays: true,
        governance_correct: true,
        escalation_correct: true,
        redaction_correct: true,
        impact_tier_correct: true,
        impact_tier_actual: null,
        latency_ms: latencyMs,
        failure_reasons: isError ? [] : ["expected error response but got success"],
        matter_id: result.matter_id ?? null,
      };
    }

    const specialistOutput = result.specialist_output ?? {};
    const governance = result.governance_decision ?? {};
    const intake = result.intake ?? {};

    // 1. Routing correctness
    const routingCorrect =
      scenario.expects_routing === "any" || intake.matter_type === scenario.expects_routing;
    if (!routingCorrect) {
      failureReasons.push(`routing: expected ${scenario.expects_routing}, got ${intake.matter_type}`);
    }

    // 2. Required fields present
    const missingFields = scenario.required_fields.filter((f) => !(f in specialistOutput));
    if (missingFields.length > 0) {
      failureReasons.push(`missing fields: ${missingFields.join(", ")}`);
    }

    // 3. Content quality (only on full_work scenarios)
    let contentQualityPassed = true;
    let hasSpecificAction = true;
    let flagsHaveEvidence = true;
    let noUnexpectedEmptyArrays = true;

    if (scenario.full_work && missingFields.length === 0) {
      const cq = assertContentQuality(scenario, specialistOutput);
      contentQualityPassed = cq.passed;
      hasSpecificAction = cq.has_specific_action;
      flagsHaveEvidence = cq.flags_have_evidence;
      noUnexpectedEmptyArrays = cq.no_unexpected_empty_arrays;
      if (!cq.passed) {
        failureReasons.push(...cq.reasons.map((r) => `content_quality: ${r}`));
      }
    }

    // 4. Governance: escalation correct
    const escalationCorrect =
      governance.escalation_required === scenario.expects_escalation;
    if (!escalationCorrect) {
      failureReasons.push(
        `escalation: expected ${scenario.expects_escalation}, got ${governance.escalation_required}`,
      );
    }

    // 5. Escalation reason contains expected substring
    let escalationReasonCorrect = true;
    if (scenario.expects_escalation && scenario.expects_escalation_reason) {
      const reasons = governance.escalation_reasons ?? [];
      escalationReasonCorrect = reasons.some((r) =>
        r.toLowerCase().includes(scenario.expects_escalation_reason!.toLowerCase()),
      );
      if (!escalationReasonCorrect) {
        failureReasons.push(
          `escalation_reason: expected to contain "${scenario.expects_escalation_reason}", got: ${JSON.stringify(reasons)}`,
        );
      }
    }

    // 6. Redaction correct
    let redactionCorrect = true;
    if (scenario.expects_redaction) {
      const redactedFields = governance.redacted_fields ?? [];
      redactionCorrect = redactedFields.length > 0;
      if (!redactionCorrect) {
        failureReasons.push("redaction: expected redacted_fields to be non-empty");
      }
    }

    // 7. Impact tier correct
    let impactTierCorrect = true;
    const impactTierActual = governance.impact_tier ?? null;
    if (scenario.expects_impact_tier) {
      impactTierCorrect = impactTierActual === scenario.expects_impact_tier;
      if (!impactTierCorrect) {
        failureReasons.push(
          `impact_tier: expected ${scenario.expects_impact_tier}, got ${impactTierActual}`,
        );
      }
    }

    const governanceCorrect = escalationCorrect && escalationReasonCorrect && redactionCorrect && impactTierCorrect;
    const passed =
      routingCorrect &&
      missingFields.length === 0 &&
      contentQualityPassed &&
      governanceCorrect;

    return {
      scenario_id: scenario.id,
      specialist: scenario.specialist,
      path: scenario.path,
      passed,
      routing_correct: routingCorrect,
      required_fields_present: missingFields.length === 0,
      missing_fields: missingFields,
      content_quality_passed: contentQualityPassed,
      has_specific_action: hasSpecificAction,
      flags_have_evidence: flagsHaveEvidence,
      no_unexpected_empty_arrays: noUnexpectedEmptyArrays,
      governance_correct: governanceCorrect,
      escalation_correct: escalationCorrect,
      redaction_correct: redactionCorrect,
      impact_tier_correct: impactTierCorrect,
      impact_tier_actual: impactTierActual,
      latency_ms: latencyMs,
      failure_reasons: failureReasons,
      matter_id: result.matter_id ?? null,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      scenario_id: scenario.id,
      specialist: scenario.specialist,
      path: scenario.path,
      passed: false,
      routing_correct: false,
      required_fields_present: false,
      missing_fields: [],
      content_quality_passed: false,
      has_specific_action: false,
      flags_have_evidence: false,
      no_unexpected_empty_arrays: false,
      governance_correct: false,
      escalation_correct: false,
      redaction_correct: false,
      impact_tier_correct: false,
      impact_tier_actual: null,
      latency_ms: latencyMs,
      failure_reasons: [`unhandled_exception: ${msg}`],
      matter_id: null,
    };
  }
}

// ── Playbook runner ───────────────────────────────────────────────────────────

export async function runPlaybook(
  matterFn: Parameters<typeof runScenario>[1],
  scenarios: PlaybookScenario[] = CORE_SCENARIOS,
): Promise<PlaybookReceipt> {
  const runId = Math.random().toString(36).slice(2, 10);
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, matterFn);
    results.push(result);
  }

  const n = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = n - passed;

  const routingCorrectCount = results.filter((r) => !r.path.includes("error") && r.routing_correct).length;
  const routingTotal = results.filter((r) => !r.path.includes("error")).length;

  const fieldsCorrectCount = results.filter((r) => r.required_fields_present).length;
  const fullWorkCount = results.filter((r) => CORE_SCENARIOS.find((s) => s.id === r.scenario_id)?.full_work).length;
  const contentQualityPassCount = results.filter(
    (r) => CORE_SCENARIOS.find((s) => s.id === r.scenario_id)?.full_work && r.content_quality_passed,
  ).length;

  const governanceCorrectCount = results.filter((r) => r.governance_correct).length;
  const errorScenarios = results.filter((r) => CORE_SCENARIOS.find((s) => s.id === r.scenario_id)?.expects_error);
  const errorPassCount = errorScenarios.filter((r) => r.passed).length;

  const avgLatency = results.reduce((s, r) => s + r.latency_ms, 0) / n;

  return {
    run_id: runId,
    run_date: new Date().toISOString(),
    scenarios_total: n,
    scenarios_passed: passed,
    scenarios_failed: failed,
    routing_accuracy: routingTotal > 0 ? routingCorrectCount / routingTotal : 1,
    required_fields_present_rate: fieldsCorrectCount / n,
    content_quality_pass_rate: fullWorkCount > 0 ? contentQualityPassCount / fullWorkCount : 1,
    governance_acted_correctly_rate: governanceCorrectCount / n,
    error_handling_pass_rate: errorScenarios.length > 0 ? errorPassCount / errorScenarios.length : 1,
    avg_latency_ms: Math.round(avgLatency),
    results,
  };
}
