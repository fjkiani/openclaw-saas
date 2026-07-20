/**
 * inferenceClient.ts — client for the Modal-hosted MCP inference service
 * (openclaw-mcp-inference.serve, deployed from /workspace/openclaw-modal-judge/mcp_inference.py).
 *
 * Modes:
 *   DRY  (default, MODAL_DRY_RUN != "0") — returns a deterministic mock so
 *        the FE keeps working when Modal is unreachable.
 *   LIVE (MODAL_DRY_RUN=0) — spawns a python one-liner that uses
 *        `modal.Function.from_name(APP, FN).remote(...)` to invoke the
 *        deployed function directly. This is the correct way to call a
 *        deployed Modal function from a non-Modal host — `modal run` is
 *        for local scripts, not deployed apps.
 *
 * The Modal function returns:
 *   {ok, completion, adapter_used, latency_ms, cold_start,
 *    mcp_slug, tool_name}
 *
 * Env vars:
 *   MCP_INFERENCE_MODAL_APP      (default openclaw-mcp-inference)
 *   MCP_INFERENCE_MODAL_FUNCTION (default serve)
 *   MCP_INFERENCE_MODAL_PROFILE  (default $MCP_MODAL_PROFILE — sets
 *                                 MODAL_PROFILE env var for the python
 *                                 subprocess so it picks the right token
 *                                 out of ~/.modal.toml)
 *   MCP_INFERENCE_PYTHON         (default python3, must have `modal` pip pkg)
 *   MCP_INFERENCE_TIMEOUT_MS     (default 60000; cold start ~10s)
 */
import { spawn } from "child_process";
import { logger } from "../logger.js";

const APP = process.env.MCP_INFERENCE_MODAL_APP ?? "openclaw-mcp-inference";
const FN = process.env.MCP_INFERENCE_MODAL_FUNCTION ?? "serve";
const PROFILE = process.env.MCP_INFERENCE_MODAL_PROFILE ?? process.env.MCP_MODAL_PROFILE ?? "";
const PYTHON = process.env.MCP_INFERENCE_PYTHON ?? "python3";
const TIMEOUT_MS = Number(process.env.MCP_INFERENCE_TIMEOUT_MS ?? 60_000);

export interface InferenceInput {
  mcp_slug: string;
  tool_name: string;
  prompt: string;
  adapter_id?: string;
  max_new_tokens?: number;
}
export interface InferenceOutput {
  completion: string;
  adapter_used: string;
  latency_ms: number;
  cold_start: boolean;
  mode: "dry" | "live";
}

function isDry(): boolean {
  return process.env.MODAL_DRY_RUN !== "0";
}

/**
 * Build a small Python program that:
 *   1. Reads a JSON payload from argv[1].
 *   2. Looks up the deployed function.
 *   3. Calls .remote(**payload).
 *   4. Prints one JSON blob to stdout (prefixed with __MODAL_RESULT__).
 * The prefix is a unique marker so we can strip any deprecation warnings
 * or profile banners Modal prints on the same stream.
 */
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

export async function runInference(input: InferenceInput): Promise<InferenceOutput> {
  const t0 = Date.now();
  if (isDry()) {
    return {
      completion: `[dry] would serve ${input.mcp_slug}::${input.tool_name} with prompt=${input.prompt.slice(0, 40)}…`,
      adapter_used: input.adapter_id ?? `${input.mcp_slug}__${input.tool_name}`,
      latency_ms: Date.now() - t0,
      cold_start: false,
      mode: "dry",
    };
  }

  const payload: Record<string, unknown> = {
    mcp_slug: input.mcp_slug,
    tool_name: input.tool_name,
    prompt: input.prompt,
  };
  if (input.adapter_id) payload.adapter_id = input.adapter_id;
  if (input.max_new_tokens) payload.max_new_tokens = input.max_new_tokens;

  return await new Promise<InferenceOutput>((resolve, reject) => {
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
      reject(new Error(`modal inference timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const latency = Date.now() - t0;
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-500) }, "modal inference python exited non-zero");
        return reject(new Error(`python exited ${code}: ${stderr.slice(-200)}`));
      }
      const idx = stdout.lastIndexOf("__MODAL_RESULT__");
      if (idx < 0) {
        return reject(new Error(`no __MODAL_RESULT__ marker in stdout: ${stdout.slice(-200)}`));
      }
      const jsonStr = stdout.slice(idx + "__MODAL_RESULT__".length).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        resolve({
          completion: parsed.completion,
          adapter_used: parsed.adapter_used ?? `${input.mcp_slug}__${input.tool_name}`,
          latency_ms: parsed.latency_ms ?? latency,
          cold_start: Boolean(parsed.cold_start),
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
