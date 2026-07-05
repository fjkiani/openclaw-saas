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
 * Each handler is a realistic stub that:
 *   - Validates required inputs
 *   - Returns structured output matching the skill's outputSchema
 *   - Logs execution context for observability
 *   - Handles errors gracefully (never throws)
 */

import { workflowEngine, type SkillHandler, type WorkflowRunContext } from "../../workflowEngine.js";
import { logger } from "../../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Skill 1: zoa-billing
// Input:  { invoice_ids?: string[], tenant_id?: string, date_range?: { from: string, to: string } }
// Output: { processed: number, reconciled: number, disputes: number, total_amount_usd: number }
// ─────────────────────────────────────────────────────────────────────────────

const zoaBilling: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-billing] Processing invoices");

  const invoiceIds = (input.invoice_ids as string[] | undefined) ?? [];
  const count = invoiceIds.length || 5; // default demo batch

  // Simulate processing
  const processed = count;
  const reconciled = Math.floor(count * 0.9);
  const disputes = count - reconciled;
  const totalAmount = Math.round(count * 1250.75 * 100) / 100;

  return {
    processed,
    reconciled,
    disputes,
    total_amount_usd: totalAmount,
    summary: `Processed ${processed} invoices: ${reconciled} reconciled, ${disputes} flagged for dispute`,
    run_id: ctx.runId,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 2: zoa-scheduling
// Input:  { attendees?: string[], duration_minutes?: number, preferred_slots?: string[] }
// Output: { scheduled: number, conflicts: number, proposed_slots: string[] }
// ─────────────────────────────────────────────────────────────────────────────

const zoaScheduling: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-scheduling] Coordinating schedules");

  const attendees = (input.attendees as string[] | undefined) ?? ["user@example.com"];
  const duration = Number(input.duration_minutes ?? 60);

  const now = new Date();
  const proposedSlots = [1, 2, 3].map((d) => {
    const slot = new Date(now);
    slot.setDate(slot.getDate() + d);
    slot.setHours(10, 0, 0, 0);
    return slot.toISOString();
  });

  return {
    scheduled: 1,
    conflicts: 0,
    proposed_slots: proposedSlots,
    attendee_count: attendees.length,
    duration_minutes: duration,
    summary: `Found ${proposedSlots.length} available slots for ${attendees.length} attendee(s)`,
    run_id: ctx.runId,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 3: zoa-payroll
// Input:  { employee_ids?: string[], pay_period?: string }
// Output: { employees_processed: number, total_gross_usd: number, total_net_usd: number, tax_withheld_usd: number }
// ─────────────────────────────────────────────────────────────────────────────

const zoaPayroll: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-payroll] Running payroll");

  const employeeIds = (input.employee_ids as string[] | undefined) ?? [];
  const count = employeeIds.length || 12; // default demo headcount
  const payPeriod = String(input.pay_period ?? new Date().toISOString().slice(0, 7));

  const avgSalary = 6250; // monthly
  const totalGross = count * avgSalary;
  const taxRate = 0.28;
  const taxWithheld = Math.round(totalGross * taxRate * 100) / 100;
  const totalNet = Math.round((totalGross - taxWithheld) * 100) / 100;

  return {
    employees_processed: count,
    pay_period: payPeriod,
    total_gross_usd: totalGross,
    total_net_usd: totalNet,
    tax_withheld_usd: taxWithheld,
    summary: `Payroll complete for ${count} employees: gross $${totalGross.toLocaleString()}, net $${totalNet.toLocaleString()}`,
    run_id: ctx.runId,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 4: zoa-hr
// Input:  { action?: "onboard" | "offboard" | "pto", employee_id?: string, days?: number }
// Output: { action_taken: string, employee_id: string, status: string, details: Record<string, unknown> }
// ─────────────────────────────────────────────────────────────────────────────

const zoaHR: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex, action: input.action }, "[zoa-hr] Processing HR action");

  const action = String(input.action ?? "onboard");
  const employeeId = String(input.employee_id ?? `emp-${Date.now()}`);
  const days = Number(input.days ?? 0);

  const details: Record<string, unknown> = {};
  let status = "completed";

  switch (action) {
    case "onboard":
      details.accounts_created = ["email", "slack", "github", "jira"];
      details.equipment_requested = true;
      details.orientation_scheduled = new Date(Date.now() + 86400000).toISOString();
      break;
    case "offboard":
      details.accounts_revoked = ["email", "slack", "github", "jira"];
      details.equipment_return_requested = true;
      details.final_paycheck_scheduled = true;
      break;
    case "pto":
      if (days <= 0) {
        status = "failed";
        details.error = "days must be > 0 for PTO requests";
      } else {
        details.pto_days_approved = days;
        details.balance_remaining = Math.max(0, 15 - days);
      }
      break;
    default:
      status = "unknown_action";
      details.error = `Unknown HR action: ${action}`;
  }

  return {
    action_taken: action,
    employee_id: employeeId,
    status,
    details,
    run_id: ctx.runId,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 5: zoa-procurement
// Input:  { items?: Array<{ name: string, quantity: number, unit_price_usd: number }>, vendor?: string }
// Output: { po_number: string, items_count: number, total_usd: number, vendor: string, status: string }
// ─────────────────────────────────────────────────────────────────────────────

const zoaProcurement: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-procurement] Creating purchase order");

  type ProcurementItem = { name: string; quantity: number; unit_price_usd: number };
  const items = (input.items as ProcurementItem[] | undefined) ?? [
    { name: "Office Supplies", quantity: 10, unit_price_usd: 25.0 },
  ];
  const vendor = String(input.vendor ?? "Default Vendor Inc.");

  const totalUsd = items.reduce((sum, item) => sum + item.quantity * item.unit_price_usd, 0);
  const poNumber = `PO-${Date.now().toString(36).toUpperCase()}`;

  return {
    po_number: poNumber,
    items_count: items.length,
    total_usd: Math.round(totalUsd * 100) / 100,
    vendor,
    status: "submitted",
    summary: `PO ${poNumber} submitted to ${vendor}: ${items.length} item(s), $${totalUsd.toFixed(2)}`,
    run_id: ctx.runId,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skill 6: zoa-compliance
// Input:  { domain?: string, regulations?: string[], check_date?: string }
// Output: { checks_run: number, passed: number, failed: number, flags: string[], report_url: string }
// ─────────────────────────────────────────────────────────────────────────────

const zoaCompliance: SkillHandler = async (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
): Promise<Record<string, unknown>> => {
  logger.info({ runId: ctx.runId, stepIndex: ctx.stepIndex }, "[zoa-compliance] Running compliance checks");

  const domain = String(input.domain ?? "general");
  const regulations = (input.regulations as string[] | undefined) ?? ["GDPR", "SOC2", "HIPAA"];
  const checkDate = String(input.check_date ?? new Date().toISOString().slice(0, 10));

  // Compliance is CONDITIONAL (l4: 2.8) — simulate some failures
  const checksRun = regulations.length * 3;
  const passed = Math.floor(checksRun * 0.6);
  const failed = checksRun - passed;
  const flags = regulations.slice(0, Math.min(2, failed)).map((r) => `${r}: policy gap detected`);

  return {
    checks_run: checksRun,
    passed,
    failed,
    flags,
    domain,
    check_date: checkDate,
    report_url: `https://openclaw.ai/compliance/reports/${ctx.runId}`,
    summary: `${passed}/${checksRun} checks passed for ${domain} (${regulations.join(", ")})`,
    run_id: ctx.runId,
  };
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
    "ZOA skill handlers registered",
  );
}
