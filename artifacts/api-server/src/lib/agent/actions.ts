/**
 * actions.ts — the agent's "hands": a registry mapping each action_type to a
 * real platform capability, dispatched over HTTP against THIS server's own
 * routes. Using real HTTP round-trips (not internal function calls) means an
 * agent step's result is byte-for-byte what the corresponding endpoint returns
 * — so "the agent did X" is provably identical to a human hitting that route.
 *
 * Every action returns an ActionResult { ok, summary, data, error }. `data` is
 * the raw endpoint payload (the proof of real dispatch). Nothing here is mocked
 * at the action layer; when the underlying judge/train uses a dry stub that is
 * the endpoint's own behavior (MODAL_DRY_RUN), not a shortcut taken here.
 */
import { logger } from "../logger.js";
import { agentConfig } from "./config.js";
import type { ActionResult, ActionType } from "./contract.js";

// ── HTTP helper (self-dispatch) ────────────────────────────────────────────────
async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const url = `${agentConfig.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-openclaw-admin-token": agentConfig.adminToken,
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function reqScope(args: Record<string, unknown>): { slug?: string; tool?: string } {
  return {
    slug: (args.mcp_slug as string) || undefined,
    tool: (args.tool_name as string) || undefined,
  };
}

// ── action implementations ─────────────────────────────────────────────────────

async function inspectBucket(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  const { status, json } = await call("GET", "/api/v1/workflow/fleet");
  if (status !== 200 || !json?.rows) {
    return { ok: false, summary: "fleet unreachable", error: `status ${status}` };
  }
  let rows = json.rows as Array<Record<string, any>>;
  if (slug) rows = rows.filter((r) => r.mcp_slug === slug);
  if (tool) rows = rows.filter((r) => r.tool_name === tool);
  // summarize health from stage statuses
  const summarizeRow = (r: Record<string, any>) => {
    const stages = r.stages ?? {};
    const statuses = Object.values(stages).map((s: any) => s?.status).filter(Boolean);
    const red = statuses.filter((s) => s === "red").length;
    const grey = statuses.filter((s) => s === "grey").length;
    const green = statuses.filter((s) => s === "green").length;
    return { mcp_slug: r.mcp_slug, tool_name: r.tool_name, green, grey, red };
  };
  const summary = rows.map(summarizeRow);
  const scope = slug ? `${slug}${tool ? `/${tool}` : ""}` : "all buckets";
  return {
    ok: true,
    summary: `Inspected ${rows.length} bucket(s) for ${scope}.`,
    data: { count: rows.length, buckets: summary },
  };
}

async function runLoop(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  if (!slug || !tool) {
    return { ok: false, summary: "run_loop needs mcp_slug + tool_name", error: "missing scope" };
  }
  const prompt =
    (args.prompt as string) ||
    "Return a concise, correct answer for the primary use case of this tool.";
  const { status, json } = await call("POST", "/api/v1/loop/run", {
    mcp_slug: slug,
    tool_name: tool,
    prompt,
  });
  if (status !== 200 || !json?.ok) {
    return { ok: false, summary: "loop run failed", error: json?.error ?? `status ${status}`, data: json };
  }
  const j = json.judge ?? {};
  return {
    ok: true,
    summary: `Loop run ${json.loop_run_id}: winner=${j.winner ?? "?"} margin=${(j.margin ?? 0).toFixed?.(3) ?? j.margin} (${json.total_latency_ms}ms).`,
    data: json,
  };
}

async function judgeBatch(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  if (!slug || !tool) {
    return { ok: false, summary: "judge_batch needs mcp_slug + tool_name", error: "missing scope" };
  }
  const { status, json } = await call("GET", `/api/v1/loop/runs/${slug}/${tool}?limit=25`);
  if (status !== 200 || !json?.ok) {
    return { ok: false, summary: "could not read loop runs", error: `status ${status}`, data: json };
  }
  const runs = (json.runs ?? []) as Array<Record<string, any>>;
  const n = runs.length;
  const wins = { a: 0, b: 0, orig: 0, tie: 0 } as Record<string, number>;
  let marginSum = 0;
  for (const r of runs) {
    const w = String(r.winner ?? "tie");
    wins[w] = (wins[w] ?? 0) + 1;
    marginSum += Number(r.judge_margin ?? 0);
  }
  const meanMargin = n ? marginSum / n : 0;
  return {
    ok: true,
    summary: `Scored ${n} recent pair(s): wins A=${wins.a ?? 0} B=${wins.b ?? 0} orig=${wins.orig ?? 0}, mean margin ${meanMargin.toFixed(3)}.`,
    data: { n, wins, mean_margin: meanMargin },
  };
}

async function runRegression(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  if (!slug || !tool) {
    return { ok: false, summary: "run_regression needs mcp_slug + tool_name", error: "missing scope" };
  }
  const body: Record<string, unknown> = {};
  if (args.adapter_id) body.adapter_id = args.adapter_id;
  const { status, json } = await call("POST", `/api/v1/workflow/regression/${slug}/${tool}`, body);
  if (status !== 200 || !json?.ok) {
    return { ok: false, summary: "regression failed", error: json?.error ?? `status ${status}`, data: json };
  }
  return {
    ok: true,
    summary: `Regression ${slug}/${tool}: ${json.passed}/${json.total} passed (rate ${json.pass_rate}), gate_ok=${json.gate_ok}.`,
    data: json,
  };
}

async function trainAdapter(args: Record<string, unknown>): Promise<ActionResult> {
  // Trains via the threshold-check dispatcher (the platform's real training
  // entrypoint). Under MODAL_DRY_RUN this exercises the dispatch path with a
  // deterministic stub; with a live Modal workspace it dispatches a real job.
  const { status, json } = await call("POST", "/api/v1/mcps/training/check-thresholds", {});
  if (status !== 200) {
    return { ok: false, summary: "training dispatch failed", error: `status ${status}`, data: json };
  }
  const results = (json?.results ?? []) as Array<Record<string, any>>;
  const dispatched = results.filter((r) => r.dispatched).length;
  const { slug, tool } = reqScope(args);
  const scope = slug ? `${slug}${tool ? `/${tool}` : ""}` : "fleet";
  return {
    ok: true,
    summary:
      dispatched > 0
        ? `Dispatched ${dispatched} training job(s) for ${scope}.`
        : `Threshold check ran for ${scope}: no tools currently eligible for training (need more verified pairs).`,
    data: { dispatched, total: results.length, results },
  };
}

async function promotePolicy(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  // Need a loop_run_id: prefer explicit arg, else most recent loop run for bucket.
  let loopRunId = args.loop_run_id as string | number | undefined;
  if (!loopRunId && slug && tool) {
    const recent = await call("GET", `/api/v1/loop/runs/${slug}/${tool}?limit=1`);
    loopRunId = recent.json?.runs?.[0]?.id;
  }
  if (!loopRunId) {
    return {
      ok: false,
      summary: "no loop run to promote",
      error: "promote_policy requires a prior run_loop (no loop_run_id found for bucket)",
    };
  }
  const { status, json } = await call("POST", "/api/v1/loop/promote", {
    loop_run_id: loopRunId,
    promoted_by: (args.approved_by as string) ?? "agent",
  });
  if (status !== 200 || !json?.ok) {
    return { ok: false, summary: "promotion failed", error: json?.error ?? `status ${status}`, data: json };
  }
  return {
    ok: true,
    summary: `Promoted loop run ${loopRunId} (gate ${json.promotion_gate_id}, model ${json.chosen_model ?? "?"}).`,
    data: json,
  };
}

async function rollbackPolicy(args: Record<string, unknown>): Promise<ActionResult> {
  const { slug, tool } = reqScope(args);
  // Need a gate_id: prefer explicit arg, else the bucket's rollbackable gate.
  let gateId = args.gate_id as string | number | undefined;
  if (!gateId && slug && tool) {
    const drill = await call("GET", `/api/v1/workflow/mcp/${slug}/${tool}`);
    gateId = drill.json?.rollback_gate_id ?? undefined;
  }
  if (!gateId) {
    return {
      ok: false,
      summary: "no promotion to roll back",
      error: "rollback_policy found no rollbackable gate for this bucket",
    };
  }
  const { status, json } = await call("POST", `/api/v1/judge/rollback/${gateId}`, {});
  if (status !== 200 || json?.ok === false) {
    return { ok: false, summary: "rollback failed", error: json?.error ?? `status ${status}`, data: json };
  }
  return { ok: true, summary: `Rolled back promotion gate ${gateId}.`, data: json };
}

// ── registry ─────────────────────────────────────────────────────────────────
type ActionFn = (args: Record<string, unknown>) => Promise<ActionResult>;

const REGISTRY: Record<ActionType, { describe: string; run: ActionFn; mutating: boolean }> = {
  inspect_bucket: {
    describe: "Read fleet/bucket health (read-only).",
    run: inspectBucket,
    mutating: false,
  },
  run_loop: {
    describe: "Run judge-then-repair on a tool to produce improved candidates.",
    run: runLoop,
    mutating: false,
  },
  judge_batch: {
    describe: "Summarize recent preference-pair judgments for a bucket.",
    run: judgeBatch,
    mutating: false,
  },
  run_regression: {
    describe: "Run the regression suite for a bucket/tool.",
    run: runRegression,
    mutating: false,
  },
  train_adapter: {
    describe: "Dispatch a training job for eligible tools (mutating).",
    run: trainAdapter,
    mutating: true,
  },
  promote_policy: {
    describe: "Promote a winning policy through the quality gate (mutating).",
    run: promotePolicy,
    mutating: true,
  },
  rollback_policy: {
    describe: "Revert a promotion gate (mutating).",
    run: rollbackPolicy,
    mutating: true,
  },
};

export async function runAction(
  actionType: ActionType,
  args: Record<string, unknown>
): Promise<ActionResult> {
  const entry = REGISTRY[actionType];
  if (!entry) return { ok: false, summary: "unknown action", error: `no action '${actionType}'` };
  try {
    return await entry.run(args);
  } catch (err) {
    logger.error({ err, actionType }, "[agent.actions] action threw");
    return { ok: false, summary: "action errored", error: String(err) };
  }
}

/** Catalog for GET /v1/agent/actions. */
export function actionCatalog(): Array<{ action_type: ActionType; describe: string; mutating: boolean }> {
  return (Object.keys(REGISTRY) as ActionType[]).map((k) => ({
    action_type: k,
    describe: REGISTRY[k].describe,
    mutating: REGISTRY[k].mutating,
  }));
}

/**
 * Autopilot may auto-approve ONLY promote_policy, and ONLY when the bucket's
 * candidate clears the SAME numeric quality gate the platform's auto-promote
 * path enforces (margin >= min_margin AND agreeing pairs >= min_pairs_agree AND
 * winner confidence >= min_confidence). Everything else (train, rollback) always
 * requires a human even in autopilot.
 *
 * IMPORTANT: the manual `POST /loop/promote` endpoint does NOT re-check the
 * numeric gate (it trusts the human approver), so for the unattended autopilot
 * path THIS function is the gate. We evaluate it over HTTP against the same
 * loop-runs + settings the auto-promote block reads, so autopilot's bar is
 * provably identical to the platform's own auto-promote bar. Fails closed.
 */
export async function autoApprovable(
  actionType: ActionType,
  args: Record<string, unknown>,
  mcpSlug: string | null,
  toolName: string | null
): Promise<boolean> {
  if (actionType !== "promote_policy") return false;
  const slug = (args.mcp_slug as string) || mcpSlug;
  const tool = (args.tool_name as string) || toolName;
  if (!slug || !tool) return false;
  try {
    // Candidate = most recent loop run for the bucket (what promote_policy will
    // promote). Pull enough history to count agreeing pairs for the winner.
    const runsRes = await call("GET", `/api/v1/loop/runs/${slug}/${tool}?limit=100`);
    const runs: Array<Record<string, any>> = runsRes.json?.runs ?? [];
    if (runs.length === 0) return false;
    const cand = runs[0];
    const winner = cand.winner as string | undefined;
    if (winner !== "a" && winner !== "b") return false;
    const margin = Number(cand.judge_margin);
    const winnerModel = winner === "b" ? cand.repair_b_model : cand.repair_a_model;
    const winnerScore = Number(winner === "b" ? cand.repair_b_score : cand.repair_a_score);
    if (!winnerModel || !Number.isFinite(margin) || !Number.isFinite(winnerScore)) return false;

    // Gate thresholds — same source the auto-promote path uses.
    const setRes = await call("GET", `/api/v1/loop/settings/${slug}/${tool}`);
    const s = setRes.json?.settings ?? {};
    const minMargin = Number(s.min_margin ?? 0.6);
    const minPairs = Number(s.min_pairs_agree ?? 25);
    const minConf = Number(s.min_confidence ?? 0.7);

    // Agreeing pairs: loop runs whose winner is the same model as our candidate.
    const agree = runs.filter(
      (r) =>
        (r.winner === "a" && r.repair_a_model === winnerModel) ||
        (r.winner === "b" && r.repair_b_model === winnerModel),
    ).length;

    const pass = margin >= minMargin && agree >= minPairs && winnerScore >= minConf;
    logger.info(
      { slug, tool, margin, minMargin, agree, minPairs, winnerScore, minConf, pass },
      "autopilot gate pre-check",
    );
    return pass;
  } catch (err) {
    logger.warn({ err: String(err), slug, tool }, "autopilot gate pre-check failed — fail closed");
    return false;
  }
}
