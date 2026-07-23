/**
 * planner.ts — hybrid goal->plan planner for the agentic task executor.
 *
 * Two backends, transparent to callers:
 *   1. LLM planner  — when OPENROUTER_API_KEY is set, ask a free-tier model to
 *      emit a JSON plan, validated + repaired via archon's extractJson. Any
 *      malformed/invalid output falls back to (2).
 *   2. mockPlanner  — deterministic keyword->DAG rules. Fully runnable with NO
 *      external dependency. Always emits a valid, non-empty, non-no-op plan.
 *
 * The mock path is the default and the safety net: the platform is provable
 * end-to-end with no API key and no GPU. The LLM path is a transparent quality
 * upgrade when a key is present.
 */
import { callOpenRouter, extractJson } from "../archon/openrouter.js";
import { archonConfig } from "../archon/config.js";
import { logger } from "../logger.js";
import {
  ACTION_TYPES,
  MUTATING_ACTIONS,
  isActionType,
  type ActionType,
  type PlanContext,
  type PlanResult,
  type PlanStep,
} from "./contract.js";
import { agentConfig } from "./config.js";

// ── Deterministic mock planner ────────────────────────────────────────────────
// Keyword -> ordered DAG. Every branch is a valid, real, non-no-op workflow.

function step(
  action_type: ActionType,
  args: Record<string, unknown>,
  rationale: string
): PlanStep {
  return {
    action_type,
    args,
    rationale,
    requires_approval: MUTATING_ACTIONS.has(action_type),
  };
}

function scopeArgs(ctx: PlanContext): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (ctx.mcp_slug) a.mcp_slug = ctx.mcp_slug;
  if (ctx.tool_name) a.tool_name = ctx.tool_name;
  return a;
}

export function mockPlanner(ctx: PlanContext): PlanResult {
  const g = ctx.goal.toLowerCase();
  const scope = scopeArgs(ctx);
  const has = (...words: string[]) => words.some((w) => g.includes(w));

  let steps: PlanStep[];
  let notes: string;

  if (has("rollback", "revert", "undo", "roll back")) {
    steps = [
      step("inspect_bucket", scope, "Confirm the bucket's current promoted policy before rolling back."),
      step("rollback_policy", scope, "Revert the most recent promotion gate for this bucket/tool."),
    ];
    notes = "rollback flow";
  } else if (has("train", "adapter", "fine-tune", "finetune", "lora")) {
    steps = [
      step("inspect_bucket", scope, "Check the bucket's current health and preference-pair volume before training."),
      step("train_adapter", scope, "Dispatch a training run to produce a candidate adapter from accumulated pairs."),
      step("run_regression", scope, "Verify the candidate adapter does not regress the suite before it is trusted."),
    ];
    notes = "train + verify flow";
  } else if (has("regression", "test", "suite", "verify", "check")) {
    steps = [
      step("inspect_bucket", scope, "Identify which tools have an active regression suite."),
      step("run_regression", scope, "Execute the regression suite and report pass/fail per case."),
    ];
    notes = "regression flow";
  } else if (has("fix", "broken", "green", "repair", "improve", "heal", "failing", "red")) {
    steps = [
      step("inspect_bucket", scope, "Assess the bucket: which tools are unhealthy and why."),
      step("run_loop", scope, "Run judge-then-repair to generate improved candidate responses."),
      step("judge_batch", scope, "Score the accumulated preference pairs to quantify the improvement."),
      step("run_regression", scope, "Confirm the repair did not break existing behavior."),
      step("promote_policy", scope, "Promote the winning policy if it clears the quality gate."),
    ];
    notes = "diagnose -> repair -> verify -> promote flow";
  } else if (has("promote", "ship", "release")) {
    steps = [
      step("inspect_bucket", scope, "Confirm the candidate meets promotion criteria."),
      step("run_regression", scope, "Regression-gate before promotion."),
      step("promote_policy", scope, "Promote the policy through the quality gate."),
    ];
    notes = "gated promotion flow";
  } else {
    // Fallback: always a safe, real, informative read. Never a no-op.
    steps = [
      step("inspect_bucket", scope, "Inspect current fleet/bucket state to ground any next action."),
    ];
    notes = "default inspection";
  }

  // Enforce max-steps cap.
  if (steps.length > agentConfig.maxSteps) steps = steps.slice(0, agentConfig.maxSteps);

  // On a re-plan after a failure, drop the failed action type once so we don't
  // immediately repeat it; keep at least inspect_bucket.
  if (ctx.priorFailure) {
    const filtered = steps.filter((s) => s.action_type !== ctx.priorFailure!.action_type);
    steps = filtered.length ? filtered : [step("inspect_bucket", scope, "Re-inspect after prior failure.")];
    notes += ` (re-plan; dropped ${ctx.priorFailure.action_type})`;
  }

  return { steps, planner: "mock", notes };
}

// ── LLM planner (optional upgrade) ────────────────────────────────────────────

const PLANNER_SYSTEM = `You are the planning module of an autonomous ops agent for an LLM-routing platform.
Given a free-text GOAL and optional bucket scope, output a short ordered plan of ACTIONS the platform can execute.

Allowed action_type values (use ONLY these):
- inspect_bucket   : read fleet/bucket health (safe, read-only)
- run_loop         : run judge-then-repair to improve a tool's responses
- judge_batch      : score accumulated preference pairs
- run_regression   : run the regression suite for a bucket/tool
- train_adapter    : dispatch a training job (MUTATING)
- promote_policy   : promote a winning policy through the quality gate (MUTATING)
- rollback_policy  : revert a promotion (MUTATING)

Rules:
- Output STRICT JSON only: {"steps":[{"action_type","args":{},"rationale":"","requires_approval":bool}]}
- args may include mcp_slug and tool_name when relevant.
- Set requires_approval=true for every MUTATING action (train_adapter, promote_policy, rollback_policy).
- Prefer starting with inspect_bucket. Keep plans concise and non-redundant.
- Never invent action types. Never output prose outside the JSON.`;

function coercePlan(parsed: unknown): PlanStep[] | null {
  const obj = parsed as { steps?: unknown };
  const rawSteps = Array.isArray(obj?.steps) ? obj.steps : Array.isArray(parsed) ? parsed : null;
  if (!rawSteps) return null;
  const out: PlanStep[] = [];
  for (const r of rawSteps as Array<Record<string, unknown>>) {
    const at = r?.action_type;
    if (!isActionType(at)) continue;
    const requires_approval =
      typeof r.requires_approval === "boolean"
        ? r.requires_approval || MUTATING_ACTIONS.has(at)
        : MUTATING_ACTIONS.has(at);
    out.push({
      action_type: at,
      args: (r.args && typeof r.args === "object" ? r.args : {}) as Record<string, unknown>,
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      requires_approval,
    });
  }
  return out.length ? out : null;
}

export async function plan(ctx: PlanContext): Promise<PlanResult> {
  const key = archonConfig.openrouterApiKey;
  // No key, or an obvious placeholder -> deterministic mock path.
  if (!key || key.includes("placeholder")) {
    return mockPlanner(ctx);
  }

  try {
    const userMsg = JSON.stringify({
      goal: ctx.goal,
      mcp_slug: ctx.mcp_slug ?? null,
      tool_name: ctx.tool_name ?? null,
      prior_failure: ctx.priorFailure ?? null,
      allowed_action_types: ACTION_TYPES,
    });
    const raw = await callOpenRouter(
      archonConfig.reasoningModel,
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: userMsg },
      ],
      0.2,
      archonConfig.reasoningModelFallbacks
    );
    const parsed = extractJson(raw);
    const steps = coercePlan(parsed);
    if (!steps) {
      logger.warn("[agent.planner] LLM plan invalid, falling back to mock");
      return mockPlanner(ctx);
    }
    const capped = steps.slice(0, agentConfig.maxSteps);
    return { steps: capped, planner: `llm:${archonConfig.reasoningModel}`, notes: "llm plan" };
  } catch (err) {
    logger.warn({ err }, "[agent.planner] LLM planner threw, falling back to mock");
    return mockPlanner(ctx);
  }
}
