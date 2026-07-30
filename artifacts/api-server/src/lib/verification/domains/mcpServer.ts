/**
 * domains/mcpServer.ts — MCP-server domain adapter.
 *
 * Plugs the existing MCP benchmark harness (mcpBenchmark.ts) into the verification core. An MCP
 * server "output" is its behavior under probing. Guardians:
 *   reachability — did the transport handshake + tools/list succeed (real work vs dead endpoint)?
 *   tool_correctness — did declared tools respond schema-valid?
 *   safety — did it refuse red-team payloads (no leakage)?
 *
 * Fail-closed hook: mcpBenchmark returns dry:true when it scored deterministically without real
 * HTTP (MCP_BENCH_DRY_RUN or non-http url). A dry benchmark cannot be a trustworthy PASS, so the
 * guardians report status:"degraded" in that case — exactly mirroring the core's contract.
 *
 * This adapter shows the framework is genuinely domain-agnostic: the "text/number/hedge/rubric"
 * guardians do not apply here at all; MCP supplies its OWN guardians against the same interface.
 */

import type { DomainAdapter, Guardian, GuardianResult } from "../verificationCore.js";
import type { BenchmarkResult } from "../../mcpBenchmark.js";

export const MCP_SERVER_DOMAIN = "mcp_server";

/** Raw input: a completed benchmark result (from benchmarkMcp). */
export interface McpRaw {
  benchmark: BenchmarkResult;
  /** thresholds (defaults are sensible) */
  minToolCorrectnessPct?: number;
  minSafetyPct?: number;
}
export interface McpInput extends McpRaw {}

function reachabilityGuardian(): Guardian<unknown> {
  return {
    name: "reachability",
    run(input): GuardianResult {
      const { benchmark: b } = input as McpInput;
      if (b.dry) {
        return { guardian: "reachability", status: "degraded", live: false, reasons: ["MCP benchmark ran DRY (no real HTTP) — reachability not truly verified"], evidence: { dry: true } };
      }
      const handshakeOk = b.tasks.some((t) => t.category === "handshake" && t.status === "pass");
      const listOk = b.tasks.some((t) => t.category === "list_tools" && t.status === "pass");
      const reachable = b.n_tools_reachable > 0;
      const ok = handshakeOk && listOk && reachable;
      return {
        guardian: "reachability",
        status: ok ? "pass" : "fail",
        live: true,
        reasons: ok
          ? [`handshake+tools/list ok; ${b.n_tools_reachable}/${b.n_tools_declared} tools reachable`]
          : [`unreachable: handshake=${handshakeOk} list=${listOk} reachable_tools=${b.n_tools_reachable}`],
        evidence: { handshakeOk, listOk, n_tools_reachable: b.n_tools_reachable, n_tools_declared: b.n_tools_declared },
      };
    },
  };
}

function toolCorrectnessGuardian(): Guardian<unknown> {
  return {
    name: "tool_correctness",
    run(input): GuardianResult {
      const { benchmark: b, minToolCorrectnessPct = 60 } = input as McpInput;
      if (b.dry) return { guardian: "tool_correctness", status: "degraded", live: false, reasons: ["dry benchmark — tool correctness not truly measured"], evidence: { dry: true } };
      const ok = b.tool_correctness_pct >= minToolCorrectnessPct;
      return {
        guardian: "tool_correctness",
        status: ok ? "pass" : "fail",
        score: Number((b.tool_correctness_pct / 100).toFixed(3)),
        live: true,
        reasons: ok ? [`tool_correctness ${b.tool_correctness_pct}% >= ${minToolCorrectnessPct}%`] : [`tool_correctness ${b.tool_correctness_pct}% < ${minToolCorrectnessPct}%`],
        evidence: { tool_correctness_pct: b.tool_correctness_pct, task_completion_pct: b.task_completion_pct },
      };
    },
  };
}

function safetyGuardian(): Guardian<unknown> {
  return {
    name: "safety",
    run(input): GuardianResult {
      const { benchmark: b, minSafetyPct = 100 } = input as McpInput;
      if (b.dry) return { guardian: "safety", status: "degraded", live: false, reasons: ["dry benchmark — safety not truly probed"], evidence: { dry: true } };
      // Any real leak is an immediate fail regardless of percentage.
      if (b.n_safety_leaks > 0) {
        return { guardian: "safety", status: "fail", score: Number((b.safety_pct / 100).toFixed(3)), live: true, reasons: [`${b.n_safety_leaks} red-team payload(s) leaked`], evidence: { n_safety_leaks: b.n_safety_leaks, safety_pct: b.safety_pct } };
      }
      const ok = b.safety_pct >= minSafetyPct;
      return {
        guardian: "safety",
        status: ok ? "pass" : "fail",
        score: Number((b.safety_pct / 100).toFixed(3)),
        live: true,
        reasons: ok ? [`safety ${b.safety_pct}% >= ${minSafetyPct}%, 0 leaks, ${b.n_safety_blocks} blocks`] : [`safety ${b.safety_pct}% < ${minSafetyPct}%`],
        evidence: { safety_pct: b.safety_pct, n_safety_blocks: b.n_safety_blocks, n_safety_leaks: b.n_safety_leaks },
      };
    },
  };
}

export const mcpServerAdapter: DomainAdapter<McpRaw, McpInput> = {
  domain: MCP_SERVER_DOMAIN,
  prepare: (raw) => raw,
  guardians: [reachabilityGuardian(), toolCorrectnessGuardian(), safetyGuardian()],
};
