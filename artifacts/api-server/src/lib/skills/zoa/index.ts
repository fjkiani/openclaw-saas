/**
 * skills/zoa/index.ts — ZOA (Zero-Ops Agent) skill handler registration.
 *
 * Registers 6 skill handlers for ZOA workflow compositions.
 * Called once at startup after workflowEngine.init(pool).
 *
 * Skill IDs (must match workflow_definitions.steps[].skill_id):
 *   zoa-billing      — invoice processing, payment reconciliation
 *   zoa-scheduling   — calendar coordination, resource allocation
 *   zoa-payroll      — payroll calculations, tax withholding
 *   zoa-hr           — onboarding, offboarding, PTO tracking
 *   zoa-procurement  — purchase orders, vendor negotiations
 *   zoa-compliance   — regulatory monitoring, compliance reports
 *
 * NO-FABRICATION POLICY: these handlers never invent numbers. Each requires a
 * real upstream connector (configured via env). If the connector is not
 * configured, the handler returns an honest "not connected" result describing
 * exactly what to configure — the same contract as the Crunchbase connector,
 * which throws instead of returning mock data. There is no simulated fallback.
 *
 * To make a skill live, set its connector env var and implement the upstream
 * call (e.g. Stripe for billing, Gusto for payroll, Google Calendar for
 * scheduling, etc.). Until then the skill reports not-connected truthfully.
 */

import { workflowEngine, type SkillHandler, type WorkflowRunContext } from "../../workflowEngine.js";
import { logger } from "../../logger.js";

interface ConnectorSpec {
  /** Env var that, when set, enables the real upstream integration. */
  envVar: string;
  /** Human-readable name of the upstream system the connector targets. */
  system: string;
  /** Example integration for docs/error messages. */
  example: string;
}

/**
 * Build an honest not-connected result. Returned whenever the upstream
 * connector is not configured. Contains no fabricated metrics — only the
 * validated input echo and what is required to go live.
 */
function notConnected(
  skillId: string,
  spec: ConnectorSpec,
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Record<string, unknown> {
  return {
    status: "not_connected",
    error: `${skillId} is not connected to a real ${spec.system}. Set ${spec.envVar} to enable it (e.g. ${spec.example}). No mock data is provided.`,
    skill: skillId,
    required_connector: spec.envVar,
    system: spec.system,
    received_input: input,
    run_id: ctx.runId,
    simulated: false,
  };
}

/**
 * Guard: return a not-connected result when the connector env var is unset,
 * otherwise null (caller proceeds to the real integration).
 */
function requireConnector(
  skillId: string,
  spec: ConnectorSpec,
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Record<string, unknown> | null {
  if (!process.env[spec.envVar]?.trim()) {
    logger.warn({ runId: ctx.runId, skill: skillId, envVar: spec.envVar }, "[zoa] connector not configured — returning honest not-connected");
    return notConnected(skillId, spec, input, ctx);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 1: zoa-billing — requires a billing connector (e.g. Stripe).
// ─────────────────────────────────────────────────────────────────────────────
const BILLING: ConnectorSpec = { envVar: "ZOA_BILLING_CONNECTOR", system: "billing/invoicing system", example: "Stripe" };

const zoaBilling: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-billing] invoice reconciliation requested");
  const nc = requireConnector("zoa-billing", BILLING, input, ctx);
  if (nc) return nc;
  // Real integration goes here once ZOA_BILLING_CONNECTOR is configured.
  return notConnected("zoa-billing", BILLING, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 2: zoa-scheduling — requires a calendar connector (e.g. Google Calendar).
// ─────────────────────────────────────────────────────────────────────────────
const SCHEDULING: ConnectorSpec = { envVar: "ZOA_SCHEDULING_CONNECTOR", system: "calendar/scheduling system", example: "Google Calendar" };

const zoaScheduling: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-scheduling] schedule coordination requested");
  const nc = requireConnector("zoa-scheduling", SCHEDULING, input, ctx);
  if (nc) return nc;
  return notConnected("zoa-scheduling", SCHEDULING, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 3: zoa-payroll — requires a payroll connector (e.g. Gusto).
// ─────────────────────────────────────────────────────────────────────────────
const PAYROLL: ConnectorSpec = { envVar: "ZOA_PAYROLL_CONNECTOR", system: "payroll system", example: "Gusto" };

const zoaPayroll: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-payroll] payroll run requested");
  const nc = requireConnector("zoa-payroll", PAYROLL, input, ctx);
  if (nc) return nc;
  return notConnected("zoa-payroll", PAYROLL, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 4: zoa-hr — requires an HRIS connector (e.g. Rippling).
// ─────────────────────────────────────────────────────────────────────────────
const HR: ConnectorSpec = { envVar: "ZOA_HR_CONNECTOR", system: "HR information system", example: "Rippling" };

const zoaHR: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex, action: input.action }, "[zoa-hr] HR action requested");
  const nc = requireConnector("zoa-hr", HR, input, ctx);
  if (nc) return nc;
  return notConnected("zoa-hr", HR, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 5: zoa-procurement — requires a procurement connector (e.g. Coupa).
// ─────────────────────────────────────────────────────────────────────────────
const PROCUREMENT: ConnectorSpec = { envVar: "ZOA_PROCUREMENT_CONNECTOR", system: "procurement system", example: "Coupa" };

const zoaProcurement: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-procurement] purchase order requested");
  const nc = requireConnector("zoa-procurement", PROCUREMENT, input, ctx);
  if (nc) return nc;
  return notConnected("zoa-procurement", PROCUREMENT, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 6: zoa-compliance — requires a compliance connector (e.g. Vanta).
// ─────────────────────────────────────────────────────────────────────────────
const COMPLIANCE: ConnectorSpec = { envVar: "ZOA_COMPLIANCE_CONNECTOR", system: "compliance monitoring system", example: "Vanta" };

const zoaCompliance: SkillHandler = async (input, ctx) => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-compliance] compliance check requested");
  const nc = requireConnector("zoa-compliance", COMPLIANCE, input, ctx);
  if (nc) return nc;
  return notConnected("zoa-compliance", COMPLIANCE, input, ctx);
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerZOASkills(): void {
  workflowEngine.registerSkill("zoa-billing", zoaBilling);
  workflowEngine.registerSkill("zoa-scheduling", zoaScheduling);
  workflowEngine.registerSkill("zoa-payroll", zoaPayroll);
  workflowEngine.registerSkill("zoa-hr", zoaHR);
  workflowEngine.registerSkill("zoa-procurement", zoaProcurement);
  workflowEngine.registerSkill("zoa-compliance", zoaCompliance);

  logger.info(
    { skills: ["zoa-billing", "zoa-scheduling", "zoa-payroll", "zoa-hr", "zoa-procurement", "zoa-compliance"] },
    "ZOA skill handlers registered (honest not-connected until a real connector is configured)",
  );
}
