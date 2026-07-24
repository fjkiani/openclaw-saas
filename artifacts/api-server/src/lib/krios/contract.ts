/**
 * contract.ts — shared types for Krios, the factory orchestrator.
 *
 * Krios is a thin conductor that composes the platform's EXISTING engines
 * (agent executor `startRun`, Modal/Forge `checkThresholdsAndDispatch`) into one
 * autonomous, continuously-visible production line. It does not re-implement any
 * engine. Its only new persistence is `zie_krios_events` — an append-only feed of
 * factory state transitions that powers the SSE stream + Control Room log + the
 * Factory Floor animation. Every event is DERIVED from a real run/dispatch; Krios
 * never fabricates activity.
 *
 * This file is the single source of truth for the conductor<->store<->routes<->FE
 * interface.
 */

// ── Event kinds (append-only factory feed) ────────────────────────────────────
// One row per factory state transition. `kind` is the discriminator the FE keys
// on to advance tokens / update KPIs / colour the log.
export const KRIOS_EVENT_KINDS = [
  "tick",              // conductor completed a scan pass (heartbeat w/ queue depth)
  "queued",            // an actionable work-item was enqueued this pass
  "launched",          // a real agent run / training dispatch was started
  "step_done",         // an executor step transitioned to done (mirrors a real step)
  "awaiting_approval", // a gated (mutating) step paused for the numeric gate
  "promoted",          // a promote_policy step cleared the gate + shipped
  "trained",           // a training dispatch fired (Modal, dry-stub under MODAL_DRY_RUN)
  "certified",         // an MCP Trust Certificate was issued for a promoted item
  "completed",         // a Krios-launched run reached terminal success
  "failed",            // a Krios-launched run/dispatch failed (graceful, never hangs)
  "skipped",           // an item was skipped (green / deduped / capacity)
] as const;

export type KriosEventKind = (typeof KRIOS_EVENT_KINDS)[number];

// ── Factory stages (the lanes on the Floor) ───────────────────────────────────
// Ordered production line. Each executor ActionType maps onto exactly one stage
// (see STAGE_FOR_ACTION below) so a live run's current step lights the right lane.
export const KRIOS_STAGES = [
  "inspect",   // inspect_bucket
  "loop",      // run_loop
  "judge",     // judge_batch
  "regress",   // run_regression
  "promote",   // promote_policy / rollback_policy
  "train",     // train_adapter (+ standalone training dispatch)
  "certify",   // issue a signed MCP Trust Certificate for the promoted item
  "deploy",    // terminal: a promoted/trained item is "on the floor" / shipped
] as const;

export type KriosStage = (typeof KRIOS_STAGES)[number];

/** Map an agent ActionType (string) onto a factory stage. */
export function stageForAction(action_type: string): KriosStage {
  switch (action_type) {
    case "inspect_bucket":
      return "inspect";
    case "run_loop":
      return "loop";
    case "judge_batch":
      return "judge";
    case "run_regression":
      return "regress";
    case "promote_policy":
    case "rollback_policy":
      return "promote";
    case "train_adapter":
      return "train";
    case "certify_mcp":
      return "certify";
    default:
      return "inspect";
  }
}

// ── Persisted event row (mirrors zie_krios_events) ─────────────────────────────
export interface KriosEvent {
  id: number;                       // BIGSERIAL cursor (monotonic; SSE `since`)
  ts: string;                       // ISO timestamp
  kind: KriosEventKind;
  mcp_slug: string | null;
  tool_name: string | null;
  run_id: string | null;            // agent run this event belongs to (nullable)
  stage: KriosStage | null;
  detail: Record<string, unknown>;  // free-form payload (goal, step idx, margin, …)
}

/** What the conductor/store append (id + ts filled by the DB). */
export interface KriosEventInput {
  kind: KriosEventKind;
  mcp_slug?: string | null;
  tool_name?: string | null;
  run_id?: string | null;
  stage?: KriosStage | null;
  detail?: Record<string, unknown>;
}

// ── Derived factory snapshot (GET /v1/krios/state) ─────────────────────────────
/** A single in-flight (non-terminal) Krios-launched run, projected for the UI. */
export interface KriosInflight {
  run_id: string;
  goal: string;
  mcp_slug: string | null;
  tool_name: string | null;
  status: string;                   // RunStatus from the agent executor
  stage: KriosStage;                // stage of the current step
  current_step: number;
  total_steps: number;
  created_at: string;
}

/** One queued-but-not-yet-launched work item (projected from the last tick). */
export interface KriosQueueItem {
  mcp_slug: string;
  tool_name: string | null;
  kind: "repair" | "train";
  reason: string;
}

export interface KriosKpis {
  in_flight: number;
  queue_depth: number;
  runs_per_min: number;             // launches over the trailing window
  promotions_today: number;
  failures_today: number;
  pass_rate: number;                // completed / (completed+failed) over window, 0..1
}

/** Full one-shot snapshot the FE hydrates from + the polling fallback source. */
export interface KriosState {
  enabled: boolean;                 // conductor running right now
  config: KriosPublicConfig;        // knobs (so the UI can show bounds)
  stage_counts: Record<KriosStage, number>;  // in-flight runs per lane
  in_flight: KriosInflight[];
  queue: KriosQueueItem[];
  kpis: KriosKpis;
  last_tick_ts: string | null;
  cursor: number;                   // max event id (FE stream `since` starting point)
}

// ── Config (env-driven; see config.ts) ─────────────────────────────────────────
export interface KriosConfig {
  enabled: boolean;                 // KRIOS_ENABLED (default false)
  pollMs: number;                   // KRIOS_POLL_MS (default 5000, min 2000)
  maxInflight: number;              // KRIOS_MAX_INFLIGHT (default 3)
  maxPerTick: number;               // KRIOS_MAX_PER_TICK (default 2)
  dedupMin: number;                 // KRIOS_DEDUP_MIN (default 5) reuse of autopilot idea
  baseUrl: string;                  // self API base for fleet reads
  adminToken: string;               // guards mutating routes
}

/** The subset of config safe to expose to the browser (no secrets). */
export type KriosPublicConfig = Pick<
  KriosConfig,
  "pollMs" | "maxInflight" | "maxPerTick" | "dedupMin"
>;
