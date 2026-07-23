/**
 * config.ts — env-driven knobs for the agentic task executor.
 *
 * Feature-flagged so the whole subsystem is inert unless explicitly enabled.
 *   AGENT_EXECUTOR_ENABLED   default 1  — user-invokable planner+executor + routes
 *   AUTOPILOT_ENABLED        default 0  — background autopilot daemon
 *   AUTOPILOT_POLL_MS        default 60000
 *   AGENT_MAX_STEPS          default 8  — hard cap on plan length (anti-runaway)
 *   AGENT_MAX_REPLANS        default 1  — self-correction re-plan budget
 *   AGENT_SELF_BASE_URL      default http://localhost:${PORT|3001}
 *   OPENCLAW_ADMIN_TOKEN                — forwarded on self-dispatch to admin routes
 */
import type { AgentConfig } from "./contract.js";

function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false";
}

function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const PORT = process.env.PORT ?? "3001";

export const agentConfig: AgentConfig = {
  executorEnabled: envBool("AGENT_EXECUTOR_ENABLED", true),
  autopilotEnabled: envBool("AUTOPILOT_ENABLED", false),
  autopilotPollMs: envInt("AUTOPILOT_POLL_MS", 60_000),
  maxSteps: envInt("AGENT_MAX_STEPS", 8),
  maxReplans: envInt("AGENT_MAX_REPLANS", 1),
  baseUrl: process.env.AGENT_SELF_BASE_URL ?? `http://localhost:${PORT}`,
  adminToken: process.env.OPENCLAW_ADMIN_TOKEN ?? "",
};
