/**
 * executor.ts — generic agentic task executor.
 *
 * Generalizes the archon skill-forge pipeline (one hardwired task) into a
 * goal-driven, multi-step, self-correcting loop over the tool-action registry:
 *
 *   plan(goal) -> [steps]
 *   for each step:
 *     if requires_approval && mode=console -> pause at 'awaiting_approval'
 *       (Autopilot auto-approves ONLY promote_policy within the existing gate)
 *     run the action (real endpoint round-trip)
 *     on failure -> self-correct: re-plan ONCE (AGENT_MAX_REPLANS), else fail
 *   terminal: completed | failed | cancelled | awaiting_approval
 *
 * Fire-and-forget, exactly like archon: routes call start() and return a
 * run_id; the client polls. The executor never throws to the caller — every
 * terminal state is persisted. It never hangs: bounded steps + bounded replans.
 */
import { logger } from "../logger.js";
import { agentConfig } from "./config.js";
import { plan as makePlan } from "./planner.js";
import { runAction, autoApprovable } from "./actions.js";
import {
  createRun,
  savePlan,
  updateRun,
  updateStep,
  getRun,
} from "./agentRunStore.js";
import type { AgentMode, AgentRun, PlanStep } from "./contract.js";

// Active in-process runs so approve() can resume the loop after a pause.
const _resumers = new Map<string, () => void>();

// ── public entry: start a run (fire-and-forget) ────────────────────────────────
export async function startRun(input: {
  goal: string;
  mode?: AgentMode;
  mcp_slug?: string | null;
  tool_name?: string | null;
  created_by?: string | null;
}): Promise<AgentRun> {
  const mode: AgentMode = input.mode === "autopilot" ? "autopilot" : "console";
  const run = await createRun({ ...input, mode });
  // Kick off async; do not await.
  void driveRun(run.id).catch((err) => {
    logger.error({ err, runId: run.id }, "[agent.executor] driveRun crashed");
    void updateRun(run.id, { status: "failed", error: String(err), completed: true });
  });
  return run;
}

// ── the loop ───────────────────────────────────────────────────────────────────
async function driveRun(runId: string): Promise<void> {
  let run = await getRun(runId);
  if (!run) return;

  // 1) plan
  const planRes = await makePlan({
    goal: run.goal,
    mode: run.mode,
    mcp_slug: run.mcp_slug,
    tool_name: run.tool_name,
  });
  await savePlan(runId, planRes.steps, planRes.planner);
  logger.info(
    { runId, planner: planRes.planner, steps: planRes.steps.length },
    "[agent.executor] planned"
  );

  await runSteps(runId, 0);
}

// Runs steps starting at `from`. Pauses at approval gates; resumes via approve().
async function runSteps(runId: string, from: number): Promise<void> {
  let run = await getRun(runId);
  if (!run || !run.steps) return;
  if (run.status === "cancelled") return;

  const stepCount = run.steps.length;
  for (let i = from; i < stepCount; i++) {
    run = await getRun(runId);
    if (!run || !run.steps) return;
    if (run.status === "cancelled") return;
    const stepDef = run.steps[i];
    if (!stepDef) continue;
    if (stepDef.status === "done" || stepDef.status === "skipped") continue;

    await updateRun(runId, { current_step: i });

    // ── approval gate ──
    if (stepDef.requires_approval) {
      const auto =
        run.mode === "autopilot" &&
        (await autoApprovable(stepDef.action_type, stepDef.args, run.mcp_slug, run.tool_name));
      if (!auto && stepDef.approved !== true) {
        if (stepDef.approved === false) {
          // rejected earlier -> skip
          await updateStep(runId, i, { status: "skipped", ended: true });
          continue;
        }
        // pause: wait for approve() to flip approved and resume
        await updateStep(runId, i, { status: "awaiting_approval" });
        await updateRun(runId, { status: "awaiting_approval" });
        logger.info({ runId, idx: i, action: stepDef.action_type }, "[agent.executor] awaiting approval");
        await waitForApproval(runId);
        // re-evaluate this same step after resume
        run = await getRun(runId);
        if (!run || !run.steps) return;
        if (run.status === "cancelled") return;
        const refreshed = run.steps[i];
        if (refreshed?.approved === false) {
          await updateStep(runId, i, { status: "skipped", ended: true });
          continue;
        }
        await updateRun(runId, { status: "running" });
      } else if (auto) {
        await updateStep(runId, i, { status: "running", approved: true, approved_by: "autopilot" });
      }
    }

    // ── execute the action (real endpoint round-trip) ──
    await updateStep(runId, i, { status: "running", started: true });
    let ok = false;
    let errMsg: string | null = null;
    try {
      const res = await runAction(stepDef.action_type, {
        ...stepDef.args,
        mcp_slug: (stepDef.args.mcp_slug as string) ?? run.mcp_slug ?? undefined,
        tool_name: (stepDef.args.tool_name as string) ?? run.tool_name ?? undefined,
      });
      ok = res.ok;
      errMsg = res.ok ? null : res.error ?? "action failed";
      await updateStep(runId, i, {
        status: res.ok ? "done" : "failed",
        result: { summary: res.summary, data: res.data ?? null, ok: res.ok, error: res.error ?? null },
        error: errMsg,
        ended: true,
      });
    } catch (err) {
      errMsg = String(err);
      await updateStep(runId, i, { status: "failed", error: errMsg, ended: true });
    }

    // ── self-correction: re-plan once on failure ──
    if (!ok) {
      run = (await getRun(runId))!;
      if (run.replans < agentConfig.maxReplans) {
        logger.info({ runId, idx: i, replans: run.replans }, "[agent.executor] step failed -> re-plan");
        const planRes = await makePlan({
          goal: run.goal,
          mode: run.mode,
          mcp_slug: run.mcp_slug,
          tool_name: run.tool_name,
          priorFailure: { action_type: stepDef.action_type, error: errMsg ?? "unknown" },
        });
        await updateRun(runId, { replans: run.replans + 1 });
        await savePlan(runId, planRes.steps, `${planRes.planner}+replan`);
        // fresh plan -> run from the start of the new step list
        return runSteps(runId, 0);
      }
      // out of re-plan budget -> terminal failure, gracefully (never hang)
      await finalize(runId, "failed", `Stopped after step ${i} (${stepDef.action_type}) failed: ${errMsg}`);
      return;
    }
  }

  // all steps done
  await finalize(runId, "completed", await summarize(runId));
}

// ── approval plumbing ────────────────────────────────────────────────────────
function waitForApproval(runId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    _resumers.set(runId, resolve);
  });
}

/** Called by the route when a user approves/rejects a step. */
export async function approveStep(
  runId: string,
  stepIdx: number,
  decision: "approve" | "reject",
  approvedBy?: string
): Promise<{ ok: boolean; error?: string }> {
  const run = await getRun(runId);
  if (!run || !run.steps) return { ok: false, error: "run not found" };
  const step = run.steps[stepIdx];
  if (!step) return { ok: false, error: "step not found" };
  if (step.status !== "awaiting_approval") {
    return { ok: false, error: `step ${stepIdx} is '${step.status}', not awaiting_approval` };
  }
  await updateStep(runId, stepIdx, {
    approved: decision === "approve",
    approved_by: approvedBy ?? "user",
  });
  // resume the loop
  const resume = _resumers.get(runId);
  if (resume) {
    _resumers.delete(runId);
    resume();
  } else {
    // No in-process resumer (e.g. after a restart) -> re-drive from this step.
    void runSteps(runId, stepIdx).catch((err) =>
      logger.error({ err, runId }, "[agent.executor] resume drive crashed")
    );
  }
  return { ok: true };
}

export async function cancelRun(runId: string): Promise<{ ok: boolean; error?: string }> {
  const run = await getRun(runId);
  if (!run) return { ok: false, error: "run not found" };
  if (run.status === "completed" || run.status === "failed") {
    return { ok: false, error: `run already ${run.status}` };
  }
  await finalize(runId, "cancelled", "Cancelled by user.");
  const resume = _resumers.get(runId);
  if (resume) {
    _resumers.delete(runId);
    resume();
  }
  return { ok: true };
}

// ── terminal + summary ─────────────────────────────────────────────────────────
async function finalize(
  runId: string,
  status: "completed" | "failed" | "cancelled",
  summary: string
): Promise<void> {
  await updateRun(runId, { status, summary, completed: true });
  logger.info({ runId, status }, "[agent.executor] finalized");
}

async function summarize(runId: string): Promise<string> {
  const run = await getRun(runId);
  if (!run || !run.steps) return "Completed.";
  const done = run.steps.filter((s) => s.status === "done").length;
  const skipped = run.steps.filter((s) => s.status === "skipped").length;
  const parts = run.steps
    .filter((s) => s.status === "done")
    .map((s) => {
      const r = s.result as { summary?: string } | null;
      return `${s.action_type}: ${r?.summary ?? "ok"}`;
    });
  return `Completed ${done}/${run.steps.length} steps${skipped ? ` (${skipped} skipped)` : ""}. ` + parts.join(" | ");
}

// exported for tests / autopilot
export { runSteps as _runSteps };
