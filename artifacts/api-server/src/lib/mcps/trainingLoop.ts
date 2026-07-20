/**
 * trainingLoop.ts — MCP-scoped preference-pair collection + fine-tune trigger.
 *
 * Mirrors ZIE double-dip modalDispatch, but keyed on MCP tool invocations
 * rather than legal/manuscript task types. The goal: turn every governance
 * decision an operator makes over an MCP call into a preference pair that
 * later fine-tunes the router policy (which MCP to trust for a given task).
 *
 * Loop shape
 * ----------
 *   1. Operator invokes MCP tool via router
 *   2. Router logs invocation to mcp_training_records (below)
 *   3. Governance layer (or operator) marks the invocation SAFE / UNSAFE /
 *      DEFER — this is the reward signal
 *   4. Every N verified pairs per (mcp_slug, tool_name), a training job is
 *      dispatched (Modal LoRA or DRY_RUN stub)
 *   5. On completion, mcp_router_policies is updated so subsequent
 *      invocations prefer the higher-trust MCP for the same task
 *
 * The training corpus is *governance-labelled MCP invocations* — a dataset
 * neither Anthropic nor OpenAI has, because it requires a neutral registry
 * across multiple MCPs. This is the moat this loop earns.
 *
 * Storage: mcp_training_records + mcp_router_policies (schema below).
 * When DB is unavailable (DRY_RUN, ephemeral test), records go to an
 * in-memory buffer that flushes to disk at /tmp/mcp-training-records.jsonl.
 */
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import { ingest as mlopsIngest, type McpInvocationRecord } from "../cloudflare/mlopsClient.js";

// ─── Thresholds ────────────────────────────────────────────────────────────

export const VERIFIED_PAIR_THRESHOLD = 25; // per (mcp_slug, tool_name)
export const MIN_SFT_PAIRS = 100;
export const MIN_DPO_PAIRS = 25;

// ─── Types ─────────────────────────────────────────────────────────────────

export type MCPPairLabel = "safe" | "unsafe" | "defer";

export interface McpInvocation {
  mcp_slug: string;
  tool_name: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  invoked_at: string; // ISO
  operator_id?: string;
  tenant_id?: number;
  latency_ms?: number;
}

export interface McpPreferencePair {
  id?: string;
  mcp_slug: string;
  tool_name: string;
  invocation: McpInvocation;
  label: MCPPairLabel;
  reason?: string;
  labelled_at: string;
  labelled_by?: string;
  used_for_training: boolean;
}

export interface MCPRouterPolicy {
  task_hint: string;
  preferred_mcp_slug: string;
  preferred_tool_name: string;
  candidate_mcp_slugs: string[];
  updated_at: string;
  based_on_pairs: number;
}

// ─── In-memory / disk-backed store (DRY_RUN safe) ──────────────────────────

const BUFFER: McpPreferencePair[] = [];
const BUFFER_PATH = process.env.MCP_TRAINING_BUFFER_PATH ??
  "/tmp/mcp-training-records.jsonl";

function persist(pair: McpPreferencePair): void {
  BUFFER.push(pair);
  try {
    fs.mkdirSync(path.dirname(BUFFER_PATH), { recursive: true });
    fs.appendFileSync(BUFFER_PATH, JSON.stringify(pair) + "\n", "utf-8");
  } catch (err) {
    logger.warn({ err, BUFFER_PATH }, "[mcp.training] disk persist failed — buffer only");
  }
}

export function recordInvocation(invocation: McpInvocation): McpPreferencePair {
  // Initial record is unlabelled — label attaches later via labelPair().
  const pair: McpPreferencePair = {
    id: cryptoUuid(),
    mcp_slug: invocation.mcp_slug,
    tool_name: invocation.tool_name,
    invocation,
    label: "defer",
    labelled_at: invocation.invoked_at,
    used_for_training: false,
  };
  persist(pair);
  // Fire-and-forget MLOps ingest (dry mirror by default; no throw on failure).
  const record: McpInvocationRecord = {
    mcp_slug: invocation.mcp_slug,
    tool_name: invocation.tool_name,
    ts: invocation.invoked_at,
    latency_ms: invocation.latency_ms ?? 0,
    success: invocation.error === undefined,
    label: null,
    tenant_id: invocation.tenant_id ?? null,
  };
  void mlopsIngest(record).catch((err) =>
    logger.warn({ err: String(err) }, "[mcp.training] mlops ingest failed (non-fatal)"),
  );
  return pair;
}

export function labelPair(
  id: string,
  label: MCPPairLabel,
  reason?: string,
  labelled_by?: string,
): McpPreferencePair | undefined {
  const found = BUFFER.find((p) => p.id === id);
  if (!found) return undefined;
  found.label = label;
  found.reason = reason;
  found.labelled_by = labelled_by;
  found.labelled_at = new Date().toISOString();
  // Refresh MLOps aggregate — write a labelled sibling record so the CF/mirror
  // aggregate reflects the operator's decision.
  const record: McpInvocationRecord = {
    mcp_slug: found.mcp_slug,
    tool_name: found.tool_name,
    ts: found.labelled_at,
    latency_ms: found.invocation.latency_ms ?? 0,
    success: found.invocation.error === undefined,
    label,
    tenant_id: found.invocation.tenant_id ?? null,
  };
  void mlopsIngest(record).catch((err) =>
    logger.warn({ err: String(err) }, "[mcp.training] mlops label-ingest failed (non-fatal)"),
  );
  return found;
}

/**
 * Bulk import a batch of pre-labelled preference pairs into the in-memory
 * training buffer. Used by the boot-seed loader
 * (MCP_TRAINING_LOAD_SEED=1) to hydrate the buffer from a synthesised JSONL
 * corpus so the first Modal LoRA trigger fires without waiting for live
 * operator labels. Rows must already conform to the `McpPreferencePair`
 * shape or be a minimal projection thereof (mcp_slug, tool_name, label,
 * invocation, labelled_at, used_for_training defaults false). Returns the
 * number of pairs pushed to the buffer.
 *
 * This is intentionally additive: it does not clear the buffer, does not
 * dedupe, and does not touch the mirror JSONL file. The loader is expected
 * to invoke this exactly once at startup after `_resetForTests()` or on a
 * fresh process.
 */
export function bulkImportPairs(rows: Partial<McpPreferencePair>[]): number {
  let n = 0;
  for (const row of rows) {
    if (!row.mcp_slug || !row.tool_name || !row.label) continue;
    const pair: McpPreferencePair = {
      id: row.id ?? cryptoUuid(),
      mcp_slug: row.mcp_slug,
      tool_name: row.tool_name,
      invocation: row.invocation ?? {
        mcp_slug: row.mcp_slug,
        tool_name: row.tool_name,
        input: {},
        invoked_at: row.labelled_at ?? new Date().toISOString(),
      },
      label: row.label as MCPPairLabel,
      reason: row.reason,
      labelled_at: row.labelled_at ?? new Date().toISOString(),
      labelled_by: row.labelled_by ?? "seed-loader",
      used_for_training: row.used_for_training ?? false,
    };
    BUFFER.push(pair);
    n += 1;
  }
  return n;
}

/**
 * Mark every (labelled, unused) pair for a (slug, tool) as used_for_training.
 * Called by the Modal-complete webhook after a fine-tune job promotes a
 * router policy. Returns the number of pairs marked so the webhook can echo it.
 */
export function markPairsUsedForTraining(mcp_slug: string, tool_name: string): number {
  let n = 0;
  for (const p of BUFFER) {
    if (
      p.mcp_slug === mcp_slug &&
      p.tool_name === tool_name &&
      p.label !== "defer" &&
      !p.used_for_training
    ) {
      p.used_for_training = true;
      n += 1;
    }
  }
  return n;
}

// ─── Training trigger ──────────────────────────────────────────────────────

export interface TriggerCheck {
  mcp_slug: string;
  tool_name: string;
  verified_pairs: number;
  fires: boolean;
  reason: string;
}

/** Count verified (non-defer, unused) pairs per (mcp_slug, tool_name). */
export function verifiedPairCounts(): TriggerCheck[] {
  const counts = new Map<string, { safe: number; unsafe: number }>();
  for (const p of BUFFER) {
    if (p.label === "defer") continue;
    if (p.used_for_training) continue; // already fed to a training job
    const key = `${p.mcp_slug}::${p.tool_name}`;
    const bucket = counts.get(key) ?? { safe: 0, unsafe: 0 };
    if (p.label === "safe") bucket.safe += 1;
    if (p.label === "unsafe") bucket.unsafe += 1;
    counts.set(key, bucket);
  }
  const out: TriggerCheck[] = [];
  for (const [key, bucket] of counts) {
    const [mcp_slug, tool_name] = key.split("::");
    const verified = bucket.safe + bucket.unsafe;
    const fires =
      verified >= VERIFIED_PAIR_THRESHOLD &&
      bucket.safe >= MIN_DPO_PAIRS &&
      bucket.unsafe >= MIN_DPO_PAIRS;
    out.push({
      mcp_slug,
      tool_name,
      verified_pairs: verified,
      fires,
      reason: fires
        ? `threshold met — safe=${bucket.safe} unsafe=${bucket.unsafe}`
        : `waiting — safe=${bucket.safe} unsafe=${bucket.unsafe} threshold=${VERIFIED_PAIR_THRESHOLD}`,
    });
  }
  return out;
}

export interface DispatchResult {
  mcp_slug: string;
  tool_name: string;
  dispatched: boolean;
  jobId?: string;
  functionCallId?: string;
  pairs_used?: number;
  dryRun: boolean;
  reason?: string;
}

/**
 * Check thresholds across the whole buffer and dispatch fine-tune jobs for
 * every (mcp_slug, tool_name) that meets the trigger. In DRY_RUN mode this
 * returns stubbed functionCallIds and does not contact Modal.
 */
export async function checkAndDispatch(): Promise<DispatchResult[]> {
  const checks = verifiedPairCounts();
  // Honor both the domain-agnostic DRY_RUN flag AND the MCP-specific
  // MODAL_DRY_RUN flag. MODAL_DRY_RUN defaults to on so the training loop
  // never accidentally spawns a real Modal job in a dev sandbox without
  // Modal credentials. To go live: MODAL_DRY_RUN=0 + MODAL_TOKEN_ID + secret.
  const dryRun =
    process.env.DRY_RUN === "1" ||
    process.env.DRY_RUN === "true" ||
    process.env.MODAL_DRY_RUN === undefined ||
    process.env.MODAL_DRY_RUN === "1" ||
    process.env.MODAL_DRY_RUN === "true";
  const out: DispatchResult[] = [];
  for (const c of checks) {
    if (!c.fires) {
      out.push({
        mcp_slug: c.mcp_slug,
        tool_name: c.tool_name,
        dispatched: false,
        dryRun,
        reason: c.reason,
      });
      continue;
    }
    if (dryRun) {
      const fakeId = `dry-${c.mcp_slug}-${c.tool_name}-${Date.now()}`;
      out.push({
        mcp_slug: c.mcp_slug,
        tool_name: c.tool_name,
        dispatched: true,
        jobId: fakeId,
        functionCallId: `stub-${fakeId}`,
        pairs_used: c.verified_pairs,
        dryRun,
        reason: "DRY_RUN stub",
      });
      // Mark used
      for (const p of BUFFER) {
        if (p.mcp_slug === c.mcp_slug && p.tool_name === c.tool_name && p.label !== "defer") {
          p.used_for_training = true;
        }
      }
      logger.info(
        { mcp_slug: c.mcp_slug, tool_name: c.tool_name, functionCallId: fakeId, pairs: c.verified_pairs },
        "[mcp.training] DRY_RUN dispatch stub",
      );
      continue;
    }
    // Live path — spawn Modal LoRA fine-tune job. Kept minimal because the
    // ZIE double-dip path already imports the Modal SDK lazily. Wire when
    // Modal tokens are provisioned in env.
    try {
      const modalMod: any = await import("modal").catch(() => null);
      if (!modalMod || !modalMod.ModalClient) {
        out.push({
          mcp_slug: c.mcp_slug,
          tool_name: c.tool_name,
          dispatched: false,
          dryRun: false,
          reason: "modal SDK not installed — install `modal` in api-server",
        });
        continue;
      }
      // Live: openclaw-mcp-trainer app deployed on Modal (see /workspace/openclaw-modal-judge/mcp_lora.py)
      const appName = process.env.MCP_MODAL_APP ?? "openclaw-mcp-trainer";
      const funcName = process.env.MCP_MODAL_FUNCTION ?? "train";
      const modalClient = new modalMod.ModalClient();
      const fn: any = await modalClient.functions.fromName(appName, funcName);
      // Pass sample pairs from the buffer so the trainer has real data to
      // fine-tune on. verified_pairs is a count; look up actual rows.
      // BUFFER records only carry {invocation.input, label} — the chosen/rejected
      // text pairs live in Postgres.zie_preference_pairs. For the router trainer
      // we synthesize a supervised target from the label ("safe" → allow, "unsafe"
      // → refuse) so the LoRA can learn to gate the call. Enough for tiny router head.
      const bufferPairs = BUFFER
        .filter((p) => p.mcp_slug === c.mcp_slug && p.tool_name === c.tool_name && p.label !== "defer")
        .slice(0, 200)
        .map((p) => ({
          input: JSON.stringify(p.invocation?.input ?? {}),
          chosen: p.label === "unsafe" ? "REFUSE" : "ALLOW",
          rejected: p.label === "unsafe" ? "ALLOW" : "REFUSE",
          label: p.label ?? "safe",
        }));
      // Modal SDK spawn signature: spawn(args?, kwargs?). Pass all named args as kwargs.
      const call = await fn.spawn([], {
        mcp_slug: c.mcp_slug,
        tool_name: c.tool_name,
        pairs: bufferPairs,
        webhook_url: process.env.MODAL_WEBHOOK_URL ?? "",
        webhook_secret: process.env.MCP_TRAINING_WEBHOOK_SECRET ?? "",
      });
      const fcId = String(call?.functionCallId ?? call?.function_call_id ?? call?.object_id ?? "unknown");
      out.push({
        mcp_slug: c.mcp_slug,
        tool_name: c.tool_name,
        dispatched: true,
        jobId: fcId,
        functionCallId: fcId,
        pairs_used: c.verified_pairs,
        dryRun: false,
      });
      logger.info(
        { mcp_slug: c.mcp_slug, tool_name: c.tool_name, call },
        "[mcp.training] Modal LoRA job spawned",
      );
    } catch (err: any) {
      logger.error({ err }, "[mcp.training] dispatch failed");
      out.push({
        mcp_slug: c.mcp_slug,
        tool_name: c.tool_name,
        dispatched: false,
        dryRun: false,
        reason: err?.message ?? String(err),
      });
    }
  }
  return out;
}

// ─── Router policy updater ────────────────────────────────────────────────

const POLICIES = new Map<string, MCPRouterPolicy>();

export function updatePolicy(
  task_hint: string,
  preferred_mcp_slug: string,
  preferred_tool_name: string,
  candidate_mcp_slugs: string[],
  based_on_pairs: number,
): MCPRouterPolicy {
  const p: MCPRouterPolicy = {
    task_hint,
    preferred_mcp_slug,
    preferred_tool_name,
    candidate_mcp_slugs,
    updated_at: new Date().toISOString(),
    based_on_pairs,
  };
  POLICIES.set(task_hint, p);
  return p;
}

export function getPolicy(task_hint: string): MCPRouterPolicy | undefined {
  return POLICIES.get(task_hint);
}

export function listPolicies(): MCPRouterPolicy[] {
  return [...POLICIES.values()];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function cryptoUuid(): string {
  // Small self-contained UUIDv4 — avoid crypto import at module eval
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${hex[Math.floor(Math.random() * 4) + 8]}${s.slice(17, 20)}-${s.slice(20)}`;
}

// Test helpers
export function _resetForTests(): void {
  BUFFER.length = 0;
  POLICIES.clear();
}

export function _dumpBuffer(): McpPreferencePair[] {
  return [...BUFFER];
}

export function health(): { ok: boolean; n_records: number; buffer_path: string } {
  return { ok: true, n_records: BUFFER.length, buffer_path: BUFFER_PATH };
}
