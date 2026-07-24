/**
 * types.ts — shared contracts for the Rigor-Gate anti-slop verification wrapper.
 *
 * The wrapper sits in front of OpenRouter: a client calls a house model
 * ("zeta-rigor-*"), the Executor produces an ExecutorEnvelope, the Guardian
 * panel (Materiality · Numerical · Hedge · Rubric) AND-gates it, and the
 * Orchestrator loops (with model-swap + escalation) until PASS or cap.
 */

// ── Executor envelope — the single unit every guardian inspects ───────────────
export interface RigorArtifact {
  name: string;
  mime: string;
  content: string;
}

export type ClaimKind = "success" | "numeric" | "factual";

export interface RigorClaim {
  text: string;
  kind: ClaimKind;
}

export interface ExecutorEnvelope {
  answer_text: string;
  artifacts: RigorArtifact[];
  /** Aider-style SEARCH/REPLACE blocks (raw strings, one per edit). */
  edit_blocks: string[];
  claims: RigorClaim[];
}

// ── Guardian verdicts ─────────────────────────────────────────────────────────
export type GuardianSeverity = "low" | "medium" | "high" | "critical";

export type GuardianId =
  | "materiality"
  | "numerical"
  | "hedge"
  | "rubric";

export interface GuardianVerdict {
  guardian: GuardianId;
  pass: boolean;
  reason: string;
  evidence: string[];
  severity: GuardianSeverity;
  /** 0..1 normalized sub-score (used to build the aggregate reward). */
  score: number;
  /** "dry" when an LLM-dependent guardian ran without a key (honest, not fabricated). */
  mode?: "live" | "dry" | "deterministic";
  /** Optional structured extras (aislop rule hits, failed SEARCH blocks, etc.). */
  detail?: Record<string, unknown>;
}

export interface PanelResult {
  pass: boolean;
  /** 0..100 aggregate rigor score (mean of guardian sub-scores * 100). */
  score: number;
  verdicts: GuardianVerdict[];
}

// ── Correction payload fed back to the executor on REJECT ─────────────────────
export interface CorrectionPayload {
  failing_guardians: GuardianId[];
  reasons: string[];
  evidence: string[];
  /** For code tasks: the exact SEARCH blocks that did not apply. */
  failed_edit_blocks?: string[];
  /** Human-readable, injected as the executor "hint" on the next attempt. */
  advice: string;
}

// ── Orchestrator run result ───────────────────────────────────────────────────
export type RigorVerdict = "PASS" | "ESCALATED";

export interface RigorAttempt {
  attempt: number;
  house_model: string;
  openrouter_id: string;
  executor_path: "dspy" | "native";
  panel: PanelResult;
  swapped: boolean;
}

export interface RigorRunResult {
  verdict: RigorVerdict;
  run_id: string;
  task_type: string;
  house_model: string;
  prompt_hash: string;
  final_envelope: ExecutorEnvelope;
  /** The first rejected envelope (slop) captured for the DPO pair, if any. */
  slop_envelope: ExecutorEnvelope | null;
  attempts: RigorAttempt[];
  n_attempts: number;
  escalated: boolean;
  rigor_score_before: number;
  rigor_score_after: number;
  model_path: string[];
  executor_path: "dspy" | "native" | "mixed";
  mode: "live" | "dry";
}

// ── Model catalog (house-name → OpenRouter id) ────────────────────────────────
export interface HouseModel {
  house_name: string;
  openrouter_id: string;
  tier: "fast" | "balanced" | "max" | "frontier";
  paid: boolean;
  api_key_env: string;
  description: string;
}
