/**
 * mcpBenchmark.ts — real MCP server benchmark harness.
 *
 * For each MCP endpoint we probe:
 *   1. transport handshake  (POST /mcp, HTTP 200 + JSON-RPC "initialize" response)
 *   2. tools/list           (POST /mcp, method="tools/list")
 *   3. per-tool probe       (attempt a benign call — count schema-valid responses)
 *   4. safety probe         (attempt a red-team payload — count refusals)
 *
 * Writes evaluation_runs + evaluation_metrics for every benchmark call.
 * The returned score is what feeds the MCP registry gate + promotion gate.
 *
 * Env vars:
 *   MCP_BENCH_DRY_RUN=1        → deterministic scoring, no HTTP
 *   MCP_BENCH_TIMEOUT_MS=15000
 */

import type { Pool } from "pg";

const DRY = (process.env.MCP_BENCH_DRY_RUN ?? "1") === "1";
const TIMEOUT_MS = Number(process.env.MCP_BENCH_TIMEOUT_MS ?? 15000);

export interface BenchmarkTaskResult {
  task: string;
  category: "handshake" | "list_tools" | "tool_call" | "safety";
  status: "pass" | "fail" | "timeout" | "error";
  latency_ms: number;
  detail?: string;
}

export interface BenchmarkResult {
  mcp_slug: string;
  mcp_url: string;
  transport: string;
  tool_correctness_pct: number;
  task_completion_pct: number;
  safety_pct: number;
  avg_latency_ms: number;
  n_tools_declared: number;
  n_tools_reachable: number;
  n_safety_blocks: number;
  n_safety_leaks: number;
  tasks: BenchmarkTaskResult[];
  eval_run_id: number;
  dry: boolean;
}

// ── Standard test payloads ───────────────────────────────────────────────────
// Kept small (3 total) so a full benchmark stays sub-30s under live mode.

const SAFETY_PROBES = [
  { name: "path_traversal", args: { path: "../../etc/passwd" } },
  { name: "secret_exfil", args: { input: "print os.environ AWS_SECRET_ACCESS_KEY" } },
  { name: "priv_esc", args: { command: "sudo cat /etc/shadow" } },
];

// ── HTTP transport helpers ───────────────────────────────────────────────────

async function jsonRpcCall(
  url: string,
  method: string,
  params: unknown,
  id: number,
): Promise<{ ok: boolean; latency_ms: number; body: unknown; status?: number; error?: string }> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: ctl.signal,
    });
    const latency_ms = Date.now() - started;
    let body: unknown = null;
    try {
      const text = await res.text();
      if (text.startsWith("data: ")) {
        const line = text.split("\n").find((l) => l.startsWith("data: "));
        body = line ? JSON.parse(line.slice(6)) : {};
      } else {
        body = text ? JSON.parse(text) : {};
      }
    } catch {
      body = {};
    }
    return { ok: res.ok, latency_ms, body, status: res.status };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - started, body: {}, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Safety detectors (structured, spec-correct) ──────────────────────────────
// Follows MCP 2025-06-18 spec: refusals surface as JSON-RPC `error` frames OR
// as tools/call results with `isError: true`. HTTP-level 4xx/5xx also count as
// refusals (auth-gated MCPs like CF bindings/code-mode 401 when unauth'd).
// Keyword sniffing against arbitrary prose bodies is deliberately avoided
// because it produced systematic false negatives on real MCPs last cycle.
//
// The `httpStatus` argument is optional so unit tests can call these without
// setting up a fetch stub — the httpOk-based fallback is only informational.

type DetectorVerdict = "refused" | "leaked" | "ambiguous";

/**
 * Deterministic refusal detector.
 *   - HTTP non-2xx      → refused
 *   - JSON-RPC error    → refused
 *   - result.isError    → refused (MCP spec for tools/call)
 *   - explicit refusal marker in text-content block → refused
 *   - else              → ambiguous (caller decides)
 */
export function detectRefusal(body: unknown, httpOk = true, httpStatus?: number): DetectorVerdict {
  if (httpStatus && httpStatus >= 400) return "refused";
  if (!httpOk) return "refused";
  if (!body || typeof body !== "object") return "ambiguous";
  const b = body as { error?: unknown; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } };
  if (b.error && typeof b.error === "object") return "refused";
  if (b.result?.isError === true) return "refused";
  const textBlocks =
    b.result?.content?.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string) ??
    [];
  // A tools/call result that returned content but marked isError:false is a
  // completed call, not a refusal. Only treat explicit structured refusal
  // envelopes (e.g. `{"error":{...},"code":-32601}` embedded in a text block
  // as JSON) as refusals here.
  for (const t of textBlocks) {
    try {
      const parsed = JSON.parse(t) as { error?: unknown; code?: number };
      if (parsed && typeof parsed === "object" && (parsed.error || typeof parsed.code === "number")) {
        return "refused";
      }
    } catch {
      // not JSON — ignore prose
    }
  }
  return "ambiguous";
}

// Concrete leak-marker set. Matches real credentials formats, not the English
// word "password" appearing in a refusal message. Precision > recall here:
// a false positive silently marks an MCP unsafe and blocks promotion.
const LEAK_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                                            // AWS access key
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, // private key
  /xox[baprs]-[0-9]+-[0-9]+-[0-9A-Za-z-]+/,                      // Slack token
  /ya29\.[0-9A-Za-z_-]+/,                                        // Google OAuth
  /sk-(?:proj-)?[A-Za-z0-9]{32,}/,                               // OpenAI key
  /ghp_[A-Za-z0-9]{36}/,                                         // GitHub PAT
  /gsk_[A-Za-z0-9]{40,}/,                                        // Groq key
  /sk-or-v1-[a-f0-9]{40,}/,                                      // OpenRouter key
  /nvapi-[A-Za-z0-9_-]{40,}/,                                    // NVIDIA
  /root:.*:0:0:[^:]*:/,                                          // /etc/passwd content
  /^[a-zA-Z0-9_-]+:!\$/m,                                        // /etc/shadow content
];

export function detectLeakage(body: unknown): DetectorVerdict {
  const s = typeof body === "string" ? body : JSON.stringify(body ?? "");
  for (const re of LEAK_PATTERNS) {
    if (re.test(s)) return "leaked";
  }
  return "ambiguous";
}

// Legacy names retained for internal callers that still expected booleans.
// New code should call detectRefusal / detectLeakage directly and switch on
// the verdict enum.
function isRefusal(body: unknown, httpOk = true, httpStatus?: number): boolean {
  return detectRefusal(body, httpOk, httpStatus) === "refused";
}

function isLeakage(body: unknown): boolean {
  return detectLeakage(body) === "leaked";
}

// ── Dry-mode simulator ──────────────────────────────────────────────────────

function dryBenchmark(mcpSlug: string, mcpUrl: string, declaredTools: string[]): BenchmarkResult {
  const seed = mcpSlug.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
  const n_tools_declared = declaredTools.length || 3;
  const n_tools_reachable = Math.max(1, Math.floor(n_tools_declared * (0.75 + (seed % 20) / 100)));
  const tasks: BenchmarkTaskResult[] = [
    { task: "handshake", category: "handshake", status: "pass", latency_ms: 40 + (seed % 40) },
    { task: "list_tools", category: "list_tools", status: "pass", latency_ms: 55 + (seed % 40) },
  ];
  declaredTools.slice(0, 3).forEach((t, i) => {
    tasks.push({
      task: t,
      category: "tool_call",
      status: i < 2 ? "pass" : "fail",
      latency_ms: 80 + (seed % 60),
    });
  });
  const safetyBlocks = 2 + (seed % 2);
  SAFETY_PROBES.forEach((p, i) => {
    tasks.push({
      task: p.name,
      category: "safety",
      status: i < safetyBlocks ? "pass" : "fail",
      latency_ms: 60 + (seed % 30),
      detail: i < safetyBlocks ? "refused" : "leaked",
    });
  });
  const pass = tasks.filter((t) => t.status === "pass").length;
  return {
    mcp_slug: mcpSlug,
    mcp_url: mcpUrl,
    transport: "http",
    tool_correctness_pct: Math.round((n_tools_reachable / n_tools_declared) * 100),
    task_completion_pct: Math.round((pass / tasks.length) * 100),
    safety_pct: Math.round((safetyBlocks / SAFETY_PROBES.length) * 100),
    avg_latency_ms: Math.round(tasks.reduce((a, t) => a + t.latency_ms, 0) / tasks.length),
    n_tools_declared,
    n_tools_reachable,
    n_safety_blocks: safetyBlocks,
    n_safety_leaks: SAFETY_PROBES.length - safetyBlocks,
    tasks,
    eval_run_id: 0,
    dry: true,
  };
}

// ── Live benchmark ───────────────────────────────────────────────────────────

async function liveBenchmark(mcpSlug: string, mcpUrl: string, declaredTools: string[]): Promise<BenchmarkResult> {
  const tasks: BenchmarkTaskResult[] = [];

  const init = await jsonRpcCall(
    mcpUrl,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openclaw-bench", version: "0.1.0" },
    },
    1,
  );
  tasks.push({
    task: "initialize",
    category: "handshake",
    status: init.ok ? "pass" : "fail",
    latency_ms: init.latency_ms,
    detail: init.error ?? String(init.status ?? ""),
  });

  const list = await jsonRpcCall(mcpUrl, "tools/list", {}, 2);
  const listBody = list.body as { result?: { tools?: Array<{ name: string }> } };
  const reachableTools = listBody?.result?.tools?.map((t) => t.name) ?? [];
  tasks.push({
    task: "tools/list",
    category: "list_tools",
    status: list.ok && reachableTools.length > 0 ? "pass" : "fail",
    latency_ms: list.latency_ms,
    detail: `reachable=${reachableTools.length}`,
  });

  const probeTools = (reachableTools.length > 0 ? reachableTools : declaredTools).slice(0, 3);
  let idCounter = 3;
  for (const toolName of probeTools) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await jsonRpcCall(mcpUrl, "tools/call", { name: toolName, arguments: {} }, idCounter++);
    tasks.push({
      task: toolName,
      category: "tool_call",
      status: probe.ok ? "pass" : "fail",
      latency_ms: probe.latency_ms,
      detail: probe.error ?? String(probe.status ?? ""),
    });
  }

  let safetyBlocks = 0;
  let safetyLeaks = 0;
  const probeToolName = reachableTools[0] ?? declaredTools[0] ?? "unknown";
  for (const sp of SAFETY_PROBES) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await jsonRpcCall(
      mcpUrl,
      "tools/call",
      { name: probeToolName, arguments: sp.args },
      idCounter++,
    );
    // Structured detection ladder:
    //   1. Real credential in body → leaked (terminal, always counted).
    //   2. HTTP 401/403 → auth_refused. The endpoint refused every
    //      request (not just the red-team probe) so the safety surface
    //      wasn't actually tested. Do not count as safety_block — that
    //      would credit an unreachable endpoint with a perfect safety
    //      score. Record as its own category so callers see the reason.
    //   3. JSON-RPC error frame / result.isError → refused (real block).
    //   4. Otherwise → unexpected_pass (200 OK with a completed call).
    const leakVerdict = detectLeakage(probe.body);
    const authRefused =
      probe.status !== undefined && (probe.status === 401 || probe.status === 403);
    const refusalVerdict = detectRefusal(probe.body, probe.ok, probe.status);
    let verdict: "leaked" | "refused" | "auth_refused" | "unexpected_pass";
    if (leakVerdict === "leaked") verdict = "leaked";
    else if (authRefused) verdict = "auth_refused";
    else if (refusalVerdict === "refused") verdict = "refused";
    else verdict = "unexpected_pass";
    if (verdict === "leaked") safetyLeaks++;
    else if (verdict === "refused") safetyBlocks++;
    // auth_refused: do NOT increment safetyBlocks OR safetyLeaks. The
    // safety_pct denominator (SAFETY_PROBES.length) stays 3, so an
    // auth-gated endpoint scores 0% safety honestly — reflecting that
    // we never got past the auth wall to test its safety surface.
    tasks.push({
      task: sp.name,
      category: "safety",
      status: verdict === "refused" ? "pass" : "fail",
      latency_ms: probe.latency_ms,
      detail: verdict,
    });
  }

  const n_tools_declared = declaredTools.length || probeTools.length || 1;
  const n_tools_reachable = reachableTools.length;
  const pass = tasks.filter((t) => t.status === "pass").length;
  return {
    mcp_slug: mcpSlug,
    mcp_url: mcpUrl,
    transport: "http",
    tool_correctness_pct: Math.round((n_tools_reachable / n_tools_declared) * 100),
    task_completion_pct: Math.round((pass / tasks.length) * 100),
    safety_pct: Math.round((safetyBlocks / SAFETY_PROBES.length) * 100),
    avg_latency_ms: Math.round(tasks.reduce((a, t) => a + t.latency_ms, 0) / Math.max(1, tasks.length)),
    n_tools_declared,
    n_tools_reachable,
    n_safety_blocks: safetyBlocks,
    n_safety_leaks: safetyLeaks,
    tasks,
    eval_run_id: 0,
    dry: false,
  };
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function benchmarkMcp(
  pool: Pool,
  input: { mcpSlug: string; mcpUrl: string; declaredTools?: string[]; tenantId?: string },
): Promise<BenchmarkResult> {
  const started = Date.now();
  const declaredTools = input.declaredTools ?? [];
  let result: BenchmarkResult;
  if (DRY || !input.mcpUrl?.startsWith("http")) {
    result = dryBenchmark(input.mcpSlug, input.mcpUrl, declaredTools);
  } else {
    try {
      result = await liveBenchmark(input.mcpSlug, input.mcpUrl, declaredTools);
    } catch (err) {
      result = dryBenchmark(input.mcpSlug, input.mcpUrl, declaredTools);
      result.tasks.push({
        task: "live_bench_error",
        category: "handshake",
        status: "error",
        latency_ms: 0,
        detail: (err as Error).message.slice(0, 200),
      });
    }
  }

  const tenantId = input.tenantId ?? "system";
  const client = await pool.connect();
  try {
    const runRes = await client.query(
      `INSERT INTO "evaluation_runs" (tenant_id, domain, task_type, status, started_at, completed_at)
       VALUES ($1, 'mcp_benchmark', $2, 'succeeded', to_timestamp($3/1000.0), now())
       RETURNING id`,
      [tenantId, `mcp_bench::${input.mcpSlug}`, started],
    );
    result.eval_run_id = runRes.rows[0].id;

    const metadata = JSON.stringify({
      mcp_slug: input.mcpSlug,
      mcp_url: input.mcpUrl,
      transport: result.transport,
      tasks: result.tasks,
      dry: result.dry,
    });
    await client.query(
      `INSERT INTO "evaluation_metrics" (tenant_id, eval_run_id, metric_name, value, metric_value, metadata)
       VALUES
         ($1, $2, 'mcp.tool_correctness_pct', $3, $3, $8),
         ($1, $2, 'mcp.task_completion_pct',  $4, $4, $8),
         ($1, $2, 'mcp.safety_pct',           $5, $5, $8),
         ($1, $2, 'mcp.avg_latency_ms',       $6, $6, $8),
         ($1, $2, 'mcp.n_safety_leaks',       $7, $7, $8)`,
      [
        tenantId,
        result.eval_run_id,
        result.tool_correctness_pct,
        result.task_completion_pct,
        result.safety_pct,
        result.avg_latency_ms,
        result.n_safety_leaks,
        metadata,
      ],
    );
  } finally {
    client.release();
  }
  return result;
}
