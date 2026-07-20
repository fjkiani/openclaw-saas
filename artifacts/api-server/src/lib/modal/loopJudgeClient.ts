/**
 * loopJudgeClient.ts — client for the DSPy-powered loop judge
 * (openclaw-loop-judge.judge_and_repair, /modal-apps/loop_judge.py).
 *
 * Same dry / live pattern as inferenceClient.ts.
 *
 * Env vars:
 *   DSPY_JUDGE_MODAL_APP       (default openclaw-loop-judge)
 *   DSPY_JUDGE_MODAL_FUNCTION  (default judge_and_repair)
 *   DSPY_JUDGE_MODAL_PROFILE   (default MCP_MODAL_PROFILE)
 *   DSPY_JUDGE_PYTHON          (default python3)
 *   DSPY_JUDGE_TIMEOUT_MS      (default 120000)
 *   OPENROUTER_API_KEY         forwarded so the mock/live gate flips server-side
 */
import { spawn } from "child_process";
import { logger } from "../logger.js";

const APP = process.env.DSPY_JUDGE_MODAL_APP ?? "openclaw-loop-judge";
const FN = process.env.DSPY_JUDGE_MODAL_FUNCTION ?? "judge_and_repair";
const PROFILE = process.env.DSPY_JUDGE_MODAL_PROFILE ?? process.env.MCP_MODAL_PROFILE ?? "";
const PYTHON = process.env.DSPY_JUDGE_PYTHON ?? "python3";
const TIMEOUT_MS = Number(process.env.DSPY_JUDGE_TIMEOUT_MS ?? 120_000);

export interface JudgeInput {
  mcp_slug: string;
  tool_name: string;
  prompt: string;
  orig_response: string;
  fast_model?: string;
  critique_model?: string;
  premium_model?: string;
  judge_model?: string;
  openrouter_key?: string;
}

export interface JudgeRepair {
  model: string;
  response: string;
  score: number;
}

export interface JudgeOutput {
  ok: boolean;
  judge_version: string;
  orig_score: number;
  repair_a: JudgeRepair;
  repair_b: JudgeRepair;
  winner: "a" | "b";
  winner_score: number;
  margin: number;
  reasoning: string;
  latency_ms: number;
  mode: "dry" | "live";
}

function isDry(): boolean {
  return process.env.MODAL_DRY_RUN !== "0";
}

function buildPyProgram(): string {
  return [
    "import json, sys",
    "from modal import Function",
    "payload = json.loads(sys.argv[1])",
    `fn = Function.from_name(${JSON.stringify(APP)}, ${JSON.stringify(FN)})`,
    "result = fn.remote(**payload)",
    "print('__MODAL_RESULT__' + json.dumps(result))",
  ].join("\n");
}

function dryStub(input: JudgeInput, latency_ms: number): JudgeOutput {
  const heur = (r: string) => {
    const q = ["parameter", "prepared", "sanitiz", "validate", "ORDER BY", "LIMIT"];
    const u = ["DROP TABLE", "; DELETE", "rm -rf", "OR 1=1"];
    const ql = q.reduce((a, t) => a + (r.toLowerCase().includes(t.toLowerCase()) ? 1 : 0), 0) / q.length;
    const uh = u.reduce((a, t) => a + (r.toLowerCase().includes(t.toLowerCase()) ? 1 : 0), 0);
    const score = Math.max(0.05, Math.min(0.95, 0.35 * Math.min(r.length / 400, 1) + 0.45 * ql - 0.25 * uh + 0.2));
    return Number(score.toFixed(3));
  };
  const repair_a_text = "SELECT * FROM users WHERE id = $1 LIMIT 100; -- parameterized, ORDER BY created_at";
  const repair_b_text =
    "SELECT u.id, u.email, u.created_at FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 100; -- prepared, explicit cols";
  const sa = heur(repair_a_text);
  const sb = heur(repair_b_text);
  const winner = sb >= sa ? "b" : "a";
  return {
    ok: true,
    judge_version: "dry-stub-v1",
    orig_score: heur(input.orig_response),
    repair_a: { model: "dry:critique", response: repair_a_text, score: sa },
    repair_b: { model: "dry:premium", response: repair_b_text, score: sb },
    winner,
    winner_score: Math.max(sa, sb),
    margin: Number(Math.abs(sa - sb).toFixed(3)),
    reasoning: "dry stub — deterministic heuristic (MODAL_DRY_RUN != 0)",
    latency_ms,
    mode: "dry",
  };
}

export async function runJudge(input: JudgeInput): Promise<JudgeOutput> {
  const t0 = Date.now();
  if (isDry()) return dryStub(input, Date.now() - t0);

  const payload: Record<string, unknown> = {
    mcp_slug: input.mcp_slug,
    tool_name: input.tool_name,
    prompt: input.prompt,
    orig_response: input.orig_response,
  };
  if (input.fast_model) payload.fast_model = input.fast_model;
  if (input.critique_model) payload.critique_model = input.critique_model;
  if (input.premium_model) payload.premium_model = input.premium_model;
  if (input.judge_model) payload.judge_model = input.judge_model;
  const key = input.openrouter_key ?? process.env.OPENROUTER_API_KEY ?? "";
  if (key) payload.openrouter_key = key;

  return await new Promise<JudgeOutput>((resolve, reject) => {
    const env = { ...process.env };
    if (PROFILE) env.MODAL_PROFILE = PROFILE;
    const child = spawn(PYTHON, ["-c", buildPyProgram(), JSON.stringify(payload)], { env });

    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`loop judge timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const latency = Date.now() - t0;
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-500) }, "loop judge python exited non-zero");
        return reject(new Error(`python exited ${code}: ${stderr.slice(-200)}`));
      }
      const idx = stdout.lastIndexOf("__MODAL_RESULT__");
      if (idx < 0) {
        return reject(new Error(`no __MODAL_RESULT__ marker: ${stdout.slice(-200)}`));
      }
      const jsonStr = stdout.slice(idx + "__MODAL_RESULT__".length).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        resolve({
          ok: parsed.ok !== false,
          judge_version: parsed.judge_version ?? "unknown",
          orig_score: Number(parsed.orig_score ?? 0),
          repair_a: parsed.repair_a,
          repair_b: parsed.repair_b,
          winner: (parsed.winner === "b" ? "b" : "a") as "a" | "b",
          winner_score: Number(parsed.winner_score ?? 0),
          margin: Number(parsed.margin ?? 0),
          reasoning: String(parsed.reasoning ?? ""),
          latency_ms: Number(parsed.latency_ms ?? latency),
          mode: "live",
        });
      } catch (err) {
        reject(new Error(`JSON parse failed: ${(err as Error).message}`));
      }
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function health(): { ok: boolean; mode: "dry" | "live"; app: string; fn: string } {
  return { ok: true, mode: isDry() ? "dry" : "live", app: APP, fn: FN };
}
