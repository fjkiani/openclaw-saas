/**
 * conductor.ts — the Krios factory conductor.
 *
 * A daemon that mirrors the Autopilot/Archon lifecycle (module-level timer +
 * re-entrancy guard, env-gated, immediate first tick then interval, clean stop
 * on SIGTERM). It is the ONE loop that unifies the platform's separate factories:
 *
 *   each tick:
 *     1. read the fleet (/api/v1/workflow/fleet) → find actionable (non-green) buckets
 *     2. build a work queue (repair items now; a single fleet-wide train probe),
 *        deduped against in-flight / recently-launched Krios runs
 *     3. launch, respecting KRIOS_MAX_INFLIGHT / KRIOS_MAX_PER_TICK:
 *          repair → startRun({mode:'autopilot', created_by:'krios'})   [agent executor]
 *          train  → checkThresholdsAndDispatch()                        [Forge/Modal]
 *     4. append a zie_krios_events row per transition (tick/queued/launched/
 *        trained/skipped/failed) — the SSE + Control Room + Floor feed.
 *
 * It REUSES the engines as-is; it never re-implements planning, execution, the
 * promotion gate, or training. Gated promotion inside a launched run is governed
 * by the executor's existing autoApprovable numeric gate (mode=autopilot). Krios
 * only decides *when* to launch and guards against stacking / runaway spawning.
 *
 * Inert unless KRIOS_ENABLED=1 (or POST /v1/krios/enable flips it at runtime).
 */
import type { Pool } from "pg";
import { logger } from "../logger.js";
import { startRun } from "../agent/executor.js";
import { listRunsForBucket, listRuns, getRun } from "../agent/agentRunStore.js";
import { checkThresholdsAndDispatch } from "../modalDispatch.js";
import { kriosConfig } from "./config.js";
import { appendEvent, inflightCount, KRIOS_CREATED_BY, progressForRun } from "./store.js";
import { stageForAction } from "./contract.js";
import type { AgentStep } from "../agent/contract.js";
import { getLatestBySlug } from "../mcps/certStore.js";

/**
 * When Krios promotes an MCP/policy, the factory advances the work-item into the
 * `certify` lane and surfaces its Trust Certificate. This is best-effort and
 * MUST NOT block or throw inside the reconciler tick: we look up the LATEST
 * persisted certificate for the promoted slug (issued out-of-band by the
 * /api/v1/certify flow — we never fabricate one here, and we never run a live
 * eval synchronously in the daemon). If a cert exists we emit its real grade/
 * score/cert_id; if none exists we emit an honest `uncertified` marker so the
 * Floor shows the item reached the Certify lane but still needs certification.
 */
export async function emitCertifiedForPromotion(run: {
  id: string;
  mcp_slug?: string | null;
  tool_name?: string | null;
}, stepIdx: number): Promise<void> {
  try {
    const slug = run.mcp_slug ?? null;
    const cert = slug ? await getLatestBySlug(slug) : null;
    const detail: Record<string, unknown> = cert
      ? {
          step_idx: stepIdx,
          certified: true,
          cert_id: cert.cert_id,
          grade: cert.grade,
          trust_score: cert.trust_score,
          eval_mode: cert.eval_mode,
          revoked: cert.revoked_at != null,
        }
      : { step_idx: stepIdx, certified: false, reason: "no_certificate_issued" };
    await appendEvent({
      kind: "certified",
      mcp_slug: slug,
      tool_name: run.tool_name ?? null,
      run_id: run.id,
      stage: "certify",
      detail,
    });
  } catch (err) {
    // Never let certificate lookup break the reconciler tick.
    logger.warn({ err, run_id: run.id }, "krios: emitCertifiedForPromotion failed (non-fatal)");
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// Fix-flow keywords (NOT regression/verify/test/check) so the mock planner emits
// the full diagnose→repair→judge→verify→promote DAG whose terminal promote_policy
// is auto-approved by the executor only when the numeric gate is ready. Same goal
// wording rationale as the Autopilot daemon.
const KRIOS_REPAIR_GOAL =
  "Krios factory: diagnose this broken bucket, repair the failing tool, and get it green by promoting the winner once it clears the gate.";

// How often (in ticks) to run the fleet-wide training threshold probe. The probe
// itself is threshold-gated (usually a no-op), so this just avoids hammering the
// two COUNT queries every single tick.
const TRAIN_PROBE_EVERY_TICKS = 3;

let _timer: NodeJS.Timeout | null = null;
let _running = false;
let _tickNo = 0;
let _base = "http://localhost:3001";

interface FleetRow {
  mcp_slug: string;
  tool_name: string;
  stages?: Record<string, { status?: string } | undefined>;
}

interface WorkItem {
  mcp_slug: string;
  tool_name: string;
  kind: "repair" | "train";
  reason: string;
}

// ── Fleet read ─────────────────────────────────────────────────────────────────
async function readFleet(): Promise<FleetRow[]> {
  try {
    const r = await fetch(`${_base}/api/v1/workflow/fleet`);
    if (!r.ok) return [];
    const j = (await r.json()) as { rows?: FleetRow[] };
    return Array.isArray(j.rows) ? j.rows : [];
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: fleet read failed");
    return [];
  }
}

/** A bucket is actionable when its terminal `route` stage is not green. */
function isActionable(row: FleetRow): boolean {
  const status = row.stages?.route?.status ?? "grey";
  return status !== "green";
}

// ── Dedupe guard (mirror of autopilot's stacking guard) ──────────────────────────
async function hasRecentOrActiveRun(slug: string, tool: string, dedupMin: number): Promise<boolean> {
  try {
    const runs = await listRunsForBucket(slug, tool, 5);
    const cutoff = Date.now() - dedupMin * 60_000;
    for (const run of runs) {
      if (run.created_by !== KRIOS_CREATED_BY) continue;
      if (!TERMINAL.has(run.status)) return true; // active run of any age blocks
      const created = run.created_at ? new Date(run.created_at).getTime() : 0;
      if (created >= cutoff) return true; // recently launched → respect window
    }
    return false;
  } catch (err) {
    logger.warn({ err: String(err), slug, tool }, "krios: dedupe check failed");
    return true; // fail safe: do NOT launch if we cannot tell
  }
}

// ── Launchers (reuse existing engines) ───────────────────────────────────────────
async function launchRepair(item: WorkItem): Promise<void> {
  try {
    const run = await startRun({
      goal: KRIOS_REPAIR_GOAL,
      mode: "autopilot",
      mcp_slug: item.mcp_slug,
      tool_name: item.tool_name,
      created_by: KRIOS_CREATED_BY,
    });
    await appendEvent({
      kind: "launched",
      mcp_slug: item.mcp_slug,
      tool_name: item.tool_name,
      run_id: run.id,
      stage: stageForAction("inspect_bucket"),
      detail: { kind: "repair", goal: KRIOS_REPAIR_GOAL, planner: run.planner, steps: run.plan?.length ?? 0 },
    });
    logger.info({ slug: item.mcp_slug, tool: item.tool_name, run_id: run.id }, "krios: launched repair run");
  } catch (err) {
    await appendEvent({
      kind: "failed",
      mcp_slug: item.mcp_slug,
      tool_name: item.tool_name,
      detail: { kind: "repair", error: String(err) },
    });
    logger.warn({ err: String(err), slug: item.mcp_slug, tool: item.tool_name }, "krios: repair launch failed");
  }
}

async function runTrainingProbe(): Promise<void> {
  try {
    const results = await checkThresholdsAndDispatch();
    const fired = results.filter((r) => r.dispatched);
    for (const r of fired) {
      await appendEvent({
        kind: "trained",
        tool_name: r.task_type,
        stage: "train",
        detail: {
          task_type: r.task_type,
          training_job_id: r.jobId ?? null,
          function_call_id: r.functionCallId ?? null,
          sft: r.sftCount,
          dpo: r.dpoCount,
          dry_run: r.dryRun,
        },
      });
      logger.info({ task_type: r.task_type, job: r.jobId }, "krios: training dispatched");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: training probe failed");
  }
}

// ── Run-progress reconciler ──────────────────────────────────────────────────
// The agent executor advances a run's steps asynchronously; it does not call
// back into Krios. So each tick we diff recent Krios runs against what we have
// already emitted and append the missing transition events (step_done /
// awaiting_approval / promoted / completed / failed). This is what makes the
// Floor animation + Control Room log genuinely event-driven rather than a pure
// snapshot poll. State is a per-run high-water mark of emitted step index +
// whether the terminal event was already emitted.
interface RunProgress {
  emittedSteps: number;    // number of step-level events already emitted (by idx+1)
  terminalDone: boolean;   // completed/failed/cancelled event already emitted
  awaitingIdx: number | null; // step idx we've already emitted awaiting_approval for
}
const _progress = new Map<string, RunProgress>();

function stepEventKind(step: AgentStep): "step_done" | "awaiting_approval" | "promoted" | null {
  if (step.status === "done") {
    return step.action_type === "promote_policy" ? "promoted" : "step_done";
  }
  if (step.status === "awaiting_approval") return "awaiting_approval";
  return null; // pending / running / skipped / failed handled elsewhere
}

async function reconcileRun(runId: string): Promise<void> {
  const run = await getRun(runId, true);
  if (!run) return;
  const steps = run.steps ?? [];
  // First touch this process: rehydrate the high-water mark from the durable
  // event log so a server restart does NOT re-emit events we already persisted
  // for this run (which would spam the Floor + Control Room log on every boot).
  // Falls back to a fresh empty mark if the read fails.
  let prev = _progress.get(runId);
  if (prev === undefined) {
    const durable = await progressForRun(runId);
    prev = durable ?? { emittedSteps: 0, terminalDone: false, awaitingIdx: null };
    _progress.set(runId, prev);
  }

  // Walk steps in order from the high-water mark. Emit each done/promoted step
  // exactly once and advance. For awaiting_approval, emit ONCE per paused step
  // (tracked by awaitingIdx) and stop — do NOT advance past it, so when the step
  // later flips to done/promoted we still emit that transition next tick.
  let emitted = prev.emittedSteps;
  let awaitingIdx = prev.awaitingIdx;
  for (let i = prev.emittedSteps; i < steps.length; i++) {
    const step = steps[i];
    const kind = stepEventKind(step);
    if (!kind) break; // not progressed past here yet

    if (kind === "awaiting_approval") {
      if (awaitingIdx !== i) {
        await appendEvent({
          kind,
          mcp_slug: run.mcp_slug,
          tool_name: run.tool_name,
          run_id: run.id,
          stage: stageForAction(step.action_type),
          detail: { step_idx: step.idx, action_type: step.action_type },
        });
        awaitingIdx = i; // remember so we don't re-emit every tick
      }
      break; // stay parked on this index until it resolves
    }

    // done / promoted — emit once and advance the high-water mark.
    await appendEvent({
      kind,
      mcp_slug: run.mcp_slug,
      tool_name: run.tool_name,
      run_id: run.id,
      stage: stageForAction(step.action_type),
      detail: {
        step_idx: step.idx,
        action_type: step.action_type,
        summary:
          step.result && typeof step.result === "object"
            ? (step.result as { summary?: string }).summary ?? null
            : null,
      },
    });
    emitted = i + 1;
    if (awaitingIdx === i) awaitingIdx = null; // the parked step resolved

    // The moment the factory PROMOTES an item, advance it into the Certify lane
    // and surface its Trust Certificate (best-effort, non-blocking).
    if (kind === "promoted") {
      await emitCertifiedForPromotion(run, step.idx);
    }
  }

  let terminalDone = prev.terminalDone;
  if (!terminalDone && TERMINAL.has(run.status)) {
    await appendEvent({
      kind: run.status === "completed" ? "completed" : "failed",
      mcp_slug: run.mcp_slug,
      tool_name: run.tool_name,
      run_id: run.id,
      stage: run.status === "completed" ? "deploy" : stageForAction(steps[run.current_step]?.action_type ?? "inspect_bucket"),
      detail: { status: run.status, summary: run.summary ?? null, error: run.error ?? null },
    });
    terminalDone = true;
  }

  // Keep the (possibly terminal) high-water mark in memory. We deliberately do
  // NOT delete terminal runs here: deleting would force a re-seed next tick and,
  // combined with the bounded recent-runs scan, could re-emit the terminal event.
  // The map is naturally bounded because the reconciler only scans a fixed recent
  // window; older runs age out of the scan and are never touched again.
  _progress.set(runId, { emittedSteps: emitted, terminalDone, awaitingIdx });
}

/** Reconcile all recent Krios runs (bounded scan). */
async function reconcileRecentRuns(): Promise<void> {
  try {
    const runs = await listRuns(30, "autopilot");
    for (const r of runs) {
      if (r.created_by !== KRIOS_CREATED_BY) continue;
      // reconcileRun seeds its high-water mark from the durable event log on
      // first touch, so terminal runs finished in a prior process are correctly
      // recognised as already-reported and their events are not re-emitted.
      await reconcileRun(r.id);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: reconcile failed");
  }
}

// ── One scan pass ─────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  const cfg = kriosConfig();
  _tickNo += 1;

  // Fleet-wide training probe (threshold-gated; runs every N ticks).
  if (_tickNo % TRAIN_PROBE_EVERY_TICKS === 1) {
    await runTrainingProbe();
  }

  const fleet = await readFleet();
  const actionable = fleet.filter(isActionable);

  // Build a deduped repair queue.
  const queue: WorkItem[] = [];
  for (const row of actionable) {
    const dup = await hasRecentOrActiveRun(row.mcp_slug, row.tool_name, cfg.dedupMin);
    if (dup) continue;
    queue.push({
      mcp_slug: row.mcp_slug,
      tool_name: row.tool_name,
      kind: "repair",
      reason: `route=${row.stages?.route?.status ?? "grey"}`,
    });
  }

  // Capacity: never exceed maxInflight total, and cap new launches per tick.
  const already = await inflightCount();
  const capacity = Math.max(0, cfg.maxInflight - already);
  const budget = Math.min(cfg.maxPerTick, capacity);

  // Heartbeat / tick event first (queue depth + capacity snapshot).
  await appendEvent({
    kind: "tick",
    detail: {
      tick: _tickNo,
      actionable: actionable.length,
      queued: queue.length,
      in_flight: already,
      capacity,
      budget,
      fleet_size: fleet.length,
    },
  });

  // Announce the launches (queued) plus a small SAMPLE of the over-capacity
  // backlog (skipped) — enough for the UI to show a backlog exists without
  // flooding the feed with dozens of skipped rows every tick.
  const SKIPPED_SAMPLE = 5;
  let launched = 0;
  let skippedAnnounced = 0;
  for (const item of queue) {
    const willLaunch = launched < budget;
    if (willLaunch) {
      await appendEvent({
        kind: "queued",
        mcp_slug: item.mcp_slug,
        tool_name: item.tool_name,
        stage: "inspect",
        detail: { kind: item.kind, reason: item.reason },
      });
      await launchRepair(item);
      launched += 1;
    } else if (skippedAnnounced < SKIPPED_SAMPLE) {
      await appendEvent({
        kind: "skipped",
        mcp_slug: item.mcp_slug,
        tool_name: item.tool_name,
        stage: "inspect",
        detail: { kind: item.kind, reason: "over capacity this tick", backlog: queue.length - budget },
      });
      skippedAnnounced += 1;
    }
  }

  // Reconcile progress of in-flight/recent Krios runs → emit step/terminal events
  // that the executor produced since the last tick (drives Floor + log).
  await reconcileRecentRuns();

  if (launched > 0) {
    logger.info({ launched, tick: _tickNo }, "krios: pass complete");
  } else {
    logger.debug({ tick: _tickNo, actionable: actionable.length }, "krios: pass idle");
  }
}

// ── Lifecycle (mirror of startAutopilotDaemon/stopAutopilotDaemon) ────────────────
export function startKriosConductor(_pool: Pool, base_url = "http://localhost:3001"): void {
  const cfg = kriosConfig();
  _base = cfg.baseUrl || base_url;
  if (!cfg.enabled) {
    logger.info({ enabled: false }, "krios conductor disabled (KRIOS_ENABLED != 1)");
    return;
  }
  if (_timer) return;
  logger.info(
    { poll_ms: cfg.pollMs, max_inflight: cfg.maxInflight, max_per_tick: cfg.maxPerTick },
    "krios conductor starting",
  );
  const run = async () => {
    // Re-check the flag every tick so a runtime disable halts new work within one
    // interval even though the timer keeps ticking until stopKriosConductor().
    if (!kriosConfig().enabled) return;
    if (_running) return;
    _running = true;
    try {
      await tick();
    } catch (err) {
      logger.warn({ err: String(err) }, "krios tick failed");
    } finally {
      _running = false;
    }
  };
  void run();
  _timer = setInterval(run, cfg.pollMs);
}

export function stopKriosConductor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Is the conductor timer live right now? (for GET /v1/krios/state). */
export function kriosRunning(): boolean {
  return _timer !== null;
}

/** Force a single pass immediately (POST /v1/krios/kick), regardless of timer. */
export async function kickOnce(base_url = "http://localhost:3001"): Promise<void> {
  const cfg = kriosConfig();
  _base = cfg.baseUrl || base_url;
  if (_running) return;
  _running = true;
  try {
    await tick();
  } finally {
    _running = false;
  }
}
