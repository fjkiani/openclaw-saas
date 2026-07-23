/**
 * contract.ts — shared types for the generic agentic task executor.
 *
 * The platform's own agent: a user (or Autopilot) supplies a free-text goal;
 * the planner emits a DAG of platform actions; the executor runs them step by
 * step against REAL existing endpoints (loop / regression / promote / train /
 * inspect) via the tool-action registry, with approval gates + self-correction.
 *
 * This file is the single source of truth for the planner<->executor<->routes
 * interface. Both the deterministic mockPlanner and the LLM planner MUST emit
 * a PlanStep[] that validates against ACTION_TYPES + the per-action arg shape.
 */

// ── Action registry keys ──────────────────────────────────────────────────────
// Every action maps 1:1 to an existing platform capability (see actions.ts).
export const ACTION_TYPES = [
  "inspect_bucket",   // GET fleet (read-only, always safe)
  "run_loop",         // POST /v1/loop/run  (judge-then-repair)
  "judge_batch",      // score recent preference pairs (read/annotate)
  "run_regression",   // POST regression suite for slug/tool
  "train_adapter",    // POST /v1/mcps/training/dispatch  (mutating)
  "promote_policy",   // POST /v1/loop/promote            (mutating, gated)
  "rollback_policy",  // rollback a promotion gate        (mutating)
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

// Actions that mutate platform state -> must pause for approval in Console mode.
export const MUTATING_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "train_adapter",
  "promote_policy",
  "rollback_policy",
]);

export function isActionType(x: unknown): x is ActionType {
  return typeof x === "string" && (ACTION_TYPES as readonly string[]).includes(x);
}

// ── Plan / step shapes ─────────────────────────────────────────────────────────
export type StepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "skipped";

export type RunStatus =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentMode = "console" | "autopilot";

/** A single planned action. The planner emits these; the executor runs them. */
export interface PlanStep {
  action_type: ActionType;
  args: Record<string, unknown>;
  rationale: string;
  requires_approval: boolean;
}

/** Persisted step (plan step + execution state). Mirrors zie_agent_steps. */
export interface AgentStep extends PlanStep {
  idx: number;
  status: StepStatus;
  approved: boolean | null;
  approved_by: string | null;
  result: unknown | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** Persisted run. Mirrors zie_agent_runs. */
export interface AgentRun {
  id: string;
  goal: string;
  mode: AgentMode;
  mcp_slug: string | null;
  tool_name: string | null;
  status: RunStatus;
  plan: PlanStep[];
  current_step: number;
  replans: number;
  planner: string | null;   // "mock" | "llm:<model>"
  summary: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  steps?: AgentStep[];       // hydrated on detail reads
}

/** What the planner returns before persistence. */
export interface PlanResult {
  steps: PlanStep[];
  planner: string;           // provenance: "mock" | "llm:<model>"
  notes?: string;
}

// ── Planner input context ───────────────────────────────────────────────────────
export interface PlanContext {
  goal: string;
  mode: AgentMode;
  mcp_slug?: string | null;
  tool_name?: string | null;
  /** Optional prior-run failure feedback for a re-plan (self-correction). */
  priorFailure?: { action_type: ActionType; error: string } | null;
}

// ── Action execution result envelope ─────────────────────────────────────────────
export interface ActionResult {
  ok: boolean;
  summary: string;                 // one-line human-readable outcome
  data?: unknown;                  // raw endpoint round-trip (proves real dispatch)
  error?: string;
}

// ── Config knobs (env-driven; see config.ts) ──────────────────────────────────────
export interface AgentConfig {
  executorEnabled: boolean;
  autopilotEnabled: boolean;
  autopilotPollMs: number;
  maxSteps: number;
  maxReplans: number;
  baseUrl: string;                 // self-referential API base for action dispatch
  adminToken: string;
}
