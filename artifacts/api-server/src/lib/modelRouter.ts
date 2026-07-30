/**
 * modelRouter.ts
 *
 * Semantic Law Counsel v1 — Provider-agnostic model router with schema-aware retry.
 *
 * Retry/fallback loop per chain entry:
 *   1. key_missing  → skip entry
 *   2. timeout      → skip entry
 *   3. 429          → skip entry (rate-limited)
 *   4. !response.ok → skip entry (http_error)
 *   5. refusal      → skip entry immediately (no repair — refusals don't improve)
 *   6. empty / partial_json → repair retry (same model, JSON-strict suffix)
 *   7. unusable     → skip entry
 *   8. schema error → repair retry (same model, schema-correction suffix with Zod issues)
 *   9. success      → return result
 *
 * Backward compatibility: legal.ts keeps its own callModelWithFallback — untouched.
 */

import { ZodError } from "zod";
import {
  classifyModelResponse,
  detectUnusableOutput,
} from "./semanticClauseSchema.js";
import { resolveApiKey } from "./resolveApiKey.js";

// Lazy logger import to avoid circular dependency at module load time.
let _logger: { warn?: (obj: unknown, msg: string) => void; info?: (obj: unknown, msg: string) => void } | null = null;
async function getLogger() {
  if (!_logger) {
    try {
      const mod = await import("./logger.js");
      _logger = mod.logger;
    } catch {
      _logger = { warn: () => {}, info: () => {} };
    }
  }
  return _logger;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderId = "groq" | "openrouter" | "local";

export interface ModelRouteConfig {
  id: string;
  provider: ProviderId;
  apiKeyEnv: string;
  /** Required for "local" provider. Ignored for groq/openrouter. */
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  tags?: string[];
}

export interface ModelInvocationInput {
  systemPrompt: string;
  userContent: string;
  /** Used as X-Title for OpenRouter attribution. */
  title: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AttemptRecord {
  model_id: string;
  provider: ProviderId;
  status:
    | "success"
    | "rate_limited"
    | "parse_error"
    | "schema_error"
    | "http_error"
    | "key_missing"
    | "timeout"
    | "refusal"
    | "unusable";
  latency_ms: number;
  error?: string;
  /** true only when a repair fetch was actually attempted (not just considered) */
  repair_attempted: boolean;
}

export interface ModelInvocationResult<T = unknown> {
  parsed: T;
  raw: string;
  model_used: string;
  provider_used: ProviderId;
  fallback_used: boolean;
  fallback_count: number;
  latency_ms: number;
  attempt_log: AttemptRecord[];
  /** Stable ID for this chain config — passed through from InvokeOptions. */
  route_chain_id: string;
}

export class RouterExhaustedError extends Error {
  constructor(public readonly attempt_log: AttemptRecord[]) {
    super(`All ${attempt_log.length} model entries exhausted`);
    this.name = "RouterExhaustedError";
  }
}

export interface InvokeOptions<T> {
  /** Throws on invalid (e.g. ZodError) — triggers schema-correction repair retry. */
  validator?: (parsed: unknown) => T;
  /** Passed through to result.route_chain_id. */
  routeChainId?: string;
  /**
   * Used by detectUnusableOutput. Defaults to "standard", which applies legal-clause field checks
   * (rationale_summary / recommended_action). Non-clause callers must pass "generic" and supply a
   * `validator`, otherwise every valid response is discarded as unusable.
   */
  schemaType?: "standard" | "premium" | "seo" | "generic";
}

// ── Provider config resolution ────────────────────────────────────────────────

const OPENROUTER_REFERER =
  process.env.OPENROUTER_REFERER ?? "https://openclaw-api-k30t.onrender.com";

function resolveProviderConfig(entry: ModelRouteConfig): {
  endpoint: string;
  apiKey: string;
  modelId: string;
} {
  const apiKey = resolveApiKey(entry.apiKeyEnv);
  switch (entry.provider) {
    case "groq":
      return {
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        apiKey,
        modelId: entry.id,
      };
    case "openrouter":
      return {
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        modelId: entry.id,
      };
    case "local":
      return {
        endpoint: entry.baseUrl ?? "http://localhost:11434/v1/chat/completions",
        apiKey,
        modelId: entry.id,
      };
  }
}

// ── Repair suffixes ───────────────────────────────────────────────────────────

const JSON_REPAIR_SUFFIX =
  "\n\nCRITICAL: Respond with valid JSON only. No prose, no markdown, no explanation. Start with { and end with }.";

function schemaRepairSuffix(issues: ZodError["issues"]): string {
  const summary = JSON.stringify(issues.slice(0, 5));
  return (
    `\n\nCORRECTION REQUIRED. Your previous response failed schema validation.\n` +
    `Issues: ${summary}\n` +
    `Respond with valid JSON only. Fix all listed issues. Start with { and end with }.`
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function invokeWithFallback<T = unknown>(
  input: ModelInvocationInput,
  chain: ModelRouteConfig[],
  opts: InvokeOptions<T> = {},
): Promise<ModelInvocationResult<T>> {
  const { validator, routeChainId = "unknown", schemaType = "standard" } = opts;
  const attempt_log: AttemptRecord[] = [];
  let fallback_count = 0;
  const t_total = Date.now();

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const t_entry = Date.now();
    const { endpoint, apiKey, modelId } = resolveProviderConfig(entry);

    // ── 1. Key missing ────────────────────────────────────────────────────────
    if (!apiKey) {
      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: "key_missing",
        latency_ms: Date.now() - t_entry,
        error: `env var '${entry.apiKeyEnv}' not set`,
        repair_attempted: false,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    const makeRequest = async (sysPrompt: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      // OpenRouter attribution headers — required for app attribution and analytics,
      // consistent with all other OpenRouter calls in this codebase.
      if (entry.provider === "openrouter") {
        headers["HTTP-Referer"] = OPENROUTER_REFERER;
        headers["X-Title"] = input.title;
      }
      return fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: input.userContent },
          ],
          temperature: input.temperature ?? 0,
          max_tokens: input.maxTokens ?? entry.maxTokens ?? 1200,
        }),
        signal: AbortSignal.timeout(entry.timeoutMs ?? 25_000),
      });
    };

    let repairAttempted = false;
    let response: Response;
    try {
      response = await makeRequest(input.systemPrompt);
    } catch (err: unknown) {
      const isTimeout =
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError");
      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: isTimeout ? "timeout" : "http_error",
        latency_ms: Date.now() - t_entry,
        error: err instanceof Error ? err.message : String(err),
        repair_attempted: false,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    // ── 3. Rate-limited (with one retry-after-delay) ──────────────────────────
    if (response.status === 429) {
      // Capture the upstream explanation. A 429 can mean requests-per-minute, tokens-per-minute,
      // tokens-per-day, or "add credits", and those need opposite responses: pace slower, wait for
      // the daily reset, or change accounts. Recording only the status forces an operator to guess.
      const limitBody = await response.text().catch(() => "");

      // Retry once after a short delay for transient rate limits (TPM/RPM).
      // Parse "try again in Xs" from Groq, or use Retry-After header, or default 10s.
      // Only retry if we haven't already retried this entry.
      if (!repairAttempted) {
        const retryAfterMatch = limitBody.match(/try again in ([\d.]+)s/i);
        const retryAfterHeader = response.headers.get("Retry-After");
        const waitSec = retryAfterMatch
          ? Math.ceil(parseFloat(retryAfterMatch[1]))
          : retryAfterHeader
            ? parseInt(retryAfterHeader, 10)
            : 10;
        const cappedWait = Math.min(waitSec, 15); // cap at 15s to avoid long hangs
        const lg = await getLogger();
        lg?.warn?.(
          { model_id: entry.id, provider: entry.provider, wait_s: cappedWait },
          "modelRouter: 429 rate-limited, retrying after delay",
        );
        await new Promise((r) => setTimeout(r, cappedWait * 1000));
        repairAttempted = true;
        try {
          response = await makeRequest(input.systemPrompt);
          if (response.ok) {
            // Retry succeeded — fall through to normal processing below
            const retryData = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const retryRaw = retryData.choices?.[0]?.message?.content ?? "";
            const retryClass = classifyModelResponse(retryRaw);
            if (retryClass.kind === "valid_json") {
              const retryParsed = (retryClass as { kind: "valid_json"; parsed: unknown }).parsed;
              const retryUnusable = detectUnusableOutput(retryParsed, schemaType);
              if (retryUnusable === null) {
                let retryValidated: T;
                if (validator) {
                  try {
                    retryValidated = validator(retryParsed);
                  } catch {
                    // schema failed on retry — log and fall through to skip
                    attempt_log.push({
                      model_id: entry.id,
                      provider: entry.provider,
                      status: "schema_error",
                      latency_ms: Date.now() - t_entry,
                      error: "schema validation failed after 429 retry",
                      repair_attempted: true,
                    });
                    if (i < chain.length - 1) { fallback_count++; continue; }
                    throw new RouterExhaustedError(attempt_log);
                  }
                } else {
                  retryValidated = retryParsed as T;
                }
                attempt_log.push({
                  model_id: entry.id,
                  provider: entry.provider,
                  status: "success",
                  latency_ms: Date.now() - t_entry,
                  repair_attempted: true,
                });
                return {
                  parsed: retryValidated,
                  raw: retryRaw,
                  model_used: entry.id,
                  provider_used: entry.provider,
                  fallback_used: fallback_count > 0,
                  fallback_count,
                  latency_ms: Date.now() - t_total,
                  attempt_log,
                  route_chain_id: routeChainId,
                };
              }
            }
          }
          // Retry also got 429 or failed — record and skip
        } catch (retryErr: unknown) {
          // retry fetch failed — record and skip
        }
      }

      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: "rate_limited",
        latency_ms: Date.now() - t_entry,
        error: limitBody.slice(0, 400) || undefined,
        repair_attempted: repairAttempted,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    // ── 4. HTTP error ─────────────────────────────────────────────────────────
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: "http_error",
        latency_ms: Date.now() - t_entry,
        error: `${response.status}: ${body.slice(0, 200)}`,
        repair_attempted: false,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";

    // ── 5. Classify response ──────────────────────────────────────────────────
    let classification = classifyModelResponse(raw);

    // ── 6. Refusal — no repair ────────────────────────────────────────────────
    if (classification.kind === "refusal") {
      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: "refusal",
        latency_ms: Date.now() - t_entry,
        repair_attempted: false,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    // ── 7. Empty / partial JSON — repair attempt ──────────────────────────────
    if (classification.kind === "empty" || classification.kind === "partial_json") {
      repairAttempted = true;
      try {
        const repairResp = await makeRequest(input.systemPrompt + JSON_REPAIR_SUFFIX);
        if (repairResp.ok) {
          const repairData = (await repairResp.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const repairRaw = repairData.choices?.[0]?.message?.content ?? "";
          classification = classifyModelResponse(repairRaw);
        }
      } catch {
        // repair fetch failed — fall through to parse_error
      }
      if (classification.kind !== "valid_json") {
        attempt_log.push({
          model_id: entry.id,
          provider: entry.provider,
          status: "parse_error",
          latency_ms: Date.now() - t_entry,
          error: "JSON parse failed after repair attempt",
          repair_attempted: true,
        });
        if (i < chain.length - 1) { fallback_count++; continue; }
        throw new RouterExhaustedError(attempt_log);
      }
    }

    // classification.kind === "valid_json" at this point
    const parsed = (classification as { kind: "valid_json"; parsed: unknown }).parsed;

    // ── 8. Unusable output ────────────────────────────────────────────────────
    const unusableReason = detectUnusableOutput(parsed, schemaType);
    if (unusableReason !== null) {
      attempt_log.push({
        model_id: entry.id,
        provider: entry.provider,
        status: "unusable",
        latency_ms: Date.now() - t_entry,
        error: unusableReason,
        repair_attempted: repairAttempted,
      });
      if (i < chain.length - 1) { fallback_count++; continue; }
      throw new RouterExhaustedError(attempt_log);
    }

    // ── 9. Schema validation ──────────────────────────────────────────────────
    let validated: T;
    if (validator) {
      try {
        validated = validator(parsed);
      } catch (validationErr: unknown) {
        // Schema validation failure — repair retry with Zod issues
        const zodErr = validationErr instanceof ZodError ? validationErr : null;
        const suffix = zodErr
          ? schemaRepairSuffix(zodErr.issues)
          : JSON_REPAIR_SUFFIX;

        let schemaRepairSucceeded = false;
        try {
          const repairResp = await makeRequest(input.systemPrompt + suffix);
          if (repairResp.ok) {
            const repairData = (await repairResp.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const repairRaw = repairData.choices?.[0]?.message?.content ?? "";
            const repairClass = classifyModelResponse(repairRaw);
            if (repairClass.kind === "valid_json") {
              try {
                validated = validator(repairClass.parsed);
                schemaRepairSucceeded = true;
                // Update raw to repair raw for result
                attempt_log.push({
                  model_id: entry.id,
                  provider: entry.provider,
                  status: "success",
                  latency_ms: Date.now() - t_entry,
                  repair_attempted: true,
                });
                return {
                  parsed: validated,
                  raw: repairRaw,
                  model_used: entry.id,
                  provider_used: entry.provider,
                  fallback_used: fallback_count > 0,
                  fallback_count,
                  latency_ms: Date.now() - t_total,
                  attempt_log,
                  route_chain_id: routeChainId,
                };
              } catch {
                // repair also failed schema validation
              }
            }
          }
        } catch {
          // repair fetch failed
        }

        if (!schemaRepairSucceeded) {
          attempt_log.push({
            model_id: entry.id,
            provider: entry.provider,
            status: "schema_error",
            latency_ms: Date.now() - t_entry,
            error:
              zodErr
                ? `Zod: ${zodErr.issues.slice(0, 3).map((i) => i.message).join("; ")}`
                : "schema validation failed",
            repair_attempted: true,
          });
          if (i < chain.length - 1) { fallback_count++; continue; }
          throw new RouterExhaustedError(attempt_log);
        }
        // schemaRepairSucceeded path already returned above
        throw new RouterExhaustedError(attempt_log); // unreachable but satisfies TS
      }
    } else {
      validated = parsed as T;
    }

    // ── 10. Success ───────────────────────────────────────────────────────────
    attempt_log.push({
      model_id: entry.id,
      provider: entry.provider,
      status: "success",
      latency_ms: Date.now() - t_entry,
      repair_attempted: repairAttempted,
    });

    return {
      parsed: validated,
      raw,
      model_used: entry.id,
      provider_used: entry.provider,
      fallback_used: fallback_count > 0,
      fallback_count,
      latency_ms: Date.now() - t_total,
      attempt_log,
      route_chain_id: routeChainId,
    };
  }

  throw new RouterExhaustedError(attempt_log);
}
