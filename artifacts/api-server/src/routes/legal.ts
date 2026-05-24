/**
 * legal.ts — Legal AI Operating Layer
 *
 * Endpoints:
 *   POST /api/v1/legal/extract-clause        — clause classification (CUAD v2)
 *   GET  /api/v1/legal/extract-clause        — asset info + lineage
 *   POST /api/v1/legal/next-asset-baseline   — termination extraction baseline eval
 *   POST /api/v1/legal/intake                — matter classification + routing
 *   POST /api/v1/legal/contract/analyze      — contract specialist
 *   POST /api/v1/legal/litigation/analyze    — litigation specialist
 *   POST /api/v1/legal/ip/analyze            — IP specialist
 *   POST /api/v1/legal/employment/analyze    — employment specialist
 *   POST /api/v1/legal/corporate/analyze     — corporate specialist
 *   POST /api/v1/legal/matter                — WORKFORCE ENTRY POINT (orchestrated)
 *   POST /api/v1/legal/playbook/run          — 10-scenario playbook runner
 *
 * Model selection (provider-aware with key rotation):
 *   Intake:     OpenRouter gpt-oss-20b → gpt-oss-120b → lfm-2.5-1.2b
 *   Specialist: Groq llama-3.3-70b (GROQ_API_KEY)
 *               → OpenRouter llama-3.3-70b key 1 (OPENROUTER_API_KEY)
 *               → OpenRouter llama-3.3-70b key 2 (OPENROUTER_API_KEY_2)
 *               → OpenRouter gpt-oss-120b key 1
 *               → OpenRouter gpt-oss-20b key 2
 *
 *   Groq has ~30 req/min free tier on llama-3.3-70b — significantly better than
 *   OpenRouter's shared free pool. Two OpenRouter keys provide 2x quota as fallback.
 *   Required env vars: GROQ_API_KEY, OPENROUTER_API_KEY, OPENROUTER_API_KEY_2
 *
 * TRAINING PATH: RAG adaptation (retrieval asset creation — not fine-tune)
 * This path builds a FAISS index from labeled examples. It does NOT modify model weights.
 * Current training = retrieval asset creation only.
 * For LoRA/fine-tune: Phase 3 — requires paid compute tier and weight-update infrastructure.
 */

import { randomUUID } from "crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { runTerminationExtractionBaseline } from "../lib/nextAssetBaseline.js";
import {
  evaluateGovernance,
  LEGAL_GOVERNANCE_POLICY,
  detectPrivilege,
  type GovernanceInput,
} from "../lib/governanceEngine.js";
import { runPlaybook } from "../lib/legalPlaybook.js";
import {
  cofounderRetrieve,
  getCriticalEntries,
  type CofounderClauseType,
} from "../lib/cofounderCorpus.js";
import {
  signReceipt,
  verifyReceiptToken,
  hashText,
  signActionReceipt,
  verifyActionReceiptToken,
  draftLetter,
  generateClausePack,
  verifyDraft,
  generateRevisionPlan,
  verifyRevisionPlan,
  buildActionGovernance,
  buildRevisionGovernance,
  buildIssueResolutionMap,
  extractIssues,
  DRAFT_PROMPT_VERSION,
  VERIFY_PROMPT_VERSION,
  ACTION_POLICY_VERSION,
  CORPUS_VERSION,
  REDLINE_PROMPT_VERSION,
  type MatterReceipt,
  type ActionReceipt,
  type ActionType,
  type ActionInput,
  type RevisionActionInput,
} from "../lib/legalActionEngine.js";
import draftRouter from "./legal.draft.addendum.js";

const router: IRouter = Router();

// ── Clause taxonomy ───────────────────────────────────────────────────────────
const CLAUSE_TYPES = [
  "governing_law",
  "termination",
  "ip_assignment",
  "limitation_of_liability",
  "indemnification",
] as const;

type ClauseType = (typeof CLAUSE_TYPES)[number];

// ── Provider-aware model chains ──────────────────────────────────────────────
//
// Each entry specifies: model id, provider endpoint, which API key env var to use.
// This enables key rotation across providers and across multiple keys for the same provider.
//
// Provider rate limits (free tier):
//   Groq:        ~30 req/min on llama-3.3-70b — best free-tier rate limit for 70B
//   OpenRouter:  shared pool across all free models; two keys = 2x quota
//
// INTAKE chain  — fast 20B model for 5-way routing classification (low stakes)
// SPECIALIST chain — 70B model via Groq first, then OpenRouter key rotation (high stakes)
//
// Rotation order for specialists:
//   1. Groq / llama-3.3-70b        (GROQ_API_KEY)          — best rate limit
//   2. OpenRouter / llama-3.3-70b  (OPENROUTER_API_KEY)    — key 1
//   3. OpenRouter / llama-3.3-70b  (OPENROUTER_API_KEY_2)  — key 2
//   4. OpenRouter / gpt-oss-120b   (OPENROUTER_API_KEY)    — key 1 fallback
//   5. OpenRouter / gpt-oss-20b    (OPENROUTER_API_KEY_2)  — key 2 last resort

type Provider = "groq" | "openrouter";

interface ModelEntry {
  id: string;                  // model id as the provider expects it
  provider: Provider;
  apiKeyEnv: string;           // env var name for the API key
  eval_accuracy: number;
  eval_macro_f1: number;
  eval_latency_s: number;
  use_rag: boolean;
}

// Groq uses its own model id format (no provider prefix)
const GROQ_LLAMA_70B = "llama-3.3-70b-versatile";
// OpenRouter uses provider/model format
const OR_LLAMA_70B   = "meta-llama/llama-3.3-70b-instruct:free";
const OR_GPT_120B    = "openai/gpt-oss-120b:free";
const OR_GPT_20B     = "openai/gpt-oss-20b:free";
const OR_GPT_20B_RAG = "liquid/lfm-2.5-1.2b-instruct:free";

const INTAKE_MODEL_CHAIN: ModelEntry[] = [
  { id: OR_GPT_20B,     provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",   eval_accuracy: 1.0,  eval_macro_f1: 1.0,    eval_latency_s: 3.44, use_rag: false },
  { id: OR_GPT_120B,    provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",   eval_accuracy: 1.0,  eval_macro_f1: 1.0,    eval_latency_s: 3.45, use_rag: false },
  { id: OR_GPT_20B_RAG, provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",   eval_accuracy: 0.9,  eval_macro_f1: 0.8933, eval_latency_s: 0.87, use_rag: true  },
];

const SPECIALIST_MODEL_CHAIN: ModelEntry[] = [
  // 1. Groq — llama-3.3-70b, ~30 req/min free tier, fastest 70B available
  { id: GROQ_LLAMA_70B, provider: "groq",       apiKeyEnv: "GROQ_API_KEY",         eval_accuracy: 1.0,  eval_macro_f1: 1.0,    eval_latency_s: 1.5,  use_rag: false },
  // 2. OpenRouter key 1 — llama-3.3-70b
  { id: OR_LLAMA_70B,   provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",   eval_accuracy: 1.0,  eval_macro_f1: 1.0,    eval_latency_s: 5.0,  use_rag: false },
  // 3. OpenRouter key 2 — llama-3.3-70b (separate quota)
  { id: OR_LLAMA_70B,   provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2", eval_accuracy: 1.0,  eval_macro_f1: 1.0,    eval_latency_s: 5.0,  use_rag: false },
  // 4. OpenRouter key 1 — gpt-oss-120b fallback
  { id: OR_GPT_120B,    provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY",   eval_accuracy: 0.8,  eval_macro_f1: 0.8,    eval_latency_s: 3.45, use_rag: false },
  // 5. OpenRouter key 2 — gpt-oss-20b last resort
  { id: OR_GPT_20B,     provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2", eval_accuracy: 0.7,  eval_macro_f1: 0.7,    eval_latency_s: 3.44, use_rag: false },
];

// Legacy alias — used by extract-clause and other standalone endpoints
const MODEL_CHAIN = INTAKE_MODEL_CHAIN;

// ── Governance policy (legacy — for standalone endpoints) ─────────────────────
const LEGAL_GOVERNANCE = {
  human_review_required: true,
  privilege_warning: "This output is not legal advice. Review by licensed counsel required before relying on this output in any legal workflow.",
  not_legal_advice: true,
  confidence_threshold: 0.70,
  jurisdiction_scope: ["US", "EU"],
  audit_trail: true,
} as const;

function buildGovernanceBlock(confidence: number | null, escalationOverride?: boolean) {
  const escalation_flag = escalationOverride ?? (confidence !== null && confidence < LEGAL_GOVERNANCE.confidence_threshold);
  return {
    human_review_required: LEGAL_GOVERNANCE.human_review_required,
    privilege_warning: LEGAL_GOVERNANCE.privilege_warning,
    not_legal_advice: LEGAL_GOVERNANCE.not_legal_advice,
    escalation_flag,
    escalation_reason: escalation_flag
      ? (confidence !== null && confidence < LEGAL_GOVERNANCE.confidence_threshold
          ? `confidence ${confidence?.toFixed(2)} below threshold ${LEGAL_GOVERNANCE.confidence_threshold}`
          : "escalation triggered by caller")
      : null,
    jurisdiction_scope: LEGAL_GOVERNANCE.jurisdiction_scope,
  };
}

function buildTraceBlock(opts: {
  retrieval_used: boolean;
  retrieval_chunks?: number;
  fallback_used: boolean;
  fallback_reason?: string | null;
  model_used: string;
  provider_model?: string;
  latency_ms: number;
  usage_event_id: string;
}) {
  return {
    retrieval_used: opts.retrieval_used,
    retrieval_chunks: opts.retrieval_chunks ?? 0,
    fallback_used: opts.fallback_used,
    fallback_reason: opts.fallback_reason ?? null,
    model_used: opts.model_used,
    provider_model: opts.provider_model ?? opts.model_used,
    latency_ms: Math.round(opts.latency_ms),
    usage_event_id: opts.usage_event_id,
  };
}

function generateUsageEventId(): string {
  return randomUUID();
}

// ── Keyword retrieval proxy ───────────────────────────────────────────────────
function keywordRetrieve(text: string): string {
  const lower = text.toLowerCase();
  const examples: Array<{ type: ClauseType; snippet: string }> = [];

  if (lower.includes("governed by") || lower.includes("laws of the state") || lower.includes("jurisdiction") || lower.includes("choice of law")) {
    examples.push({ type: "governing_law", snippet: "This Agreement shall be governed by the laws of the State of Delaware, without regard to conflict of law provisions." });
  }
  if (lower.includes("terminat") || lower.includes("notice of termination") || lower.includes("right to terminate")) {
    examples.push({ type: "termination", snippet: "Either party may terminate this Agreement upon 30 days written notice. Upon termination, all licenses granted hereunder shall immediately cease." });
  }
  if (lower.includes("intellectual property") || lower.includes("assigns") || lower.includes("work made for hire") || lower.includes("invention") || lower.includes("patent")) {
    examples.push({ type: "ip_assignment", snippet: "Employee hereby assigns to Company all right, title, and interest in any inventions or works created during the term of employment." });
  }
  if (lower.includes("in no event") || lower.includes("shall not exceed") || lower.includes("limitation of liability") || lower.includes("indirect") || lower.includes("consequential")) {
    examples.push({ type: "limitation_of_liability", snippet: "IN NO EVENT SHALL EITHER PARTY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES." });
  }
  if (lower.includes("indemnif") || lower.includes("hold harmless") || lower.includes("defend") || lower.includes("third-party claim")) {
    examples.push({ type: "indemnification", snippet: "Company shall indemnify, defend, and hold harmless the other party from and against any third-party claims arising from Company's breach of this Agreement." });
  }

  if (examples.length === 0) return "";
  return examples.slice(0, 3).map((e, i) => `Example ${i + 1} (${e.type}): "${e.snippet}"`).join("\n");
}

// ── OpenRouter call with model fallback (clause extraction) ───────────────────
async function callWithFallback(
  text: string,
  requestedUseRag: boolean,
): Promise<{
  clause_type: string;
  confidence: number;
  reasoning: string;
  model_used: string;
  model_eval_accuracy: number;
  model_eval_macro_f1: number;
  rag_used: boolean;
  fallback_count: number;
  model_index: number;
}> {
  const apiKey  = process.env.OPENROUTER_API_KEY  ?? "";
  const apiKey2 = process.env.OPENROUTER_API_KEY_2 ?? "";
  if (!apiKey && !apiKey2) throw new Error("No OpenRouter API key configured");
  // Use key2 as fallback when key1 is exhausted (handled in the loop below via activeKey)

  const EXTRACT_SYSTEM_PROMPT = `You are a legal contract analyst. Your task is to classify a contract clause excerpt into exactly one of these categories:
- governing_law: Specifies which jurisdiction's laws govern the contract
- termination: Describes conditions under which the contract can be ended
- ip_assignment: Addresses ownership or transfer of intellectual property rights
- limitation_of_liability: Caps or limits the damages one party can recover
- indemnification: Requires one party to compensate the other for certain losses

Respond with valid JSON only. No explanation, no markdown, no extra text.`;

  const USER_TEMPLATE = (t: string, context: string) =>
    `Contract clause excerpt:\n"""\n${t}\n"""${context ? `\n\nRelevant examples from similar contracts:\n${context}\n` : ""}\n\nClassify this clause. Respond with JSON: {"clause_type": "<one of the 5 types>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

  const overrideModel = process.env.LEGAL_INFERENCE_MODEL;
  const chain = overrideModel
    ? [{ id: overrideModel, eval_accuracy: 0, eval_macro_f1: 0, eval_latency_s: 0, use_rag: requestedUseRag }]
    : MODEL_CHAIN;

  let lastError = "";
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const useRag = requestedUseRag && model.use_rag;
    const context = useRag ? keywordRetrieve(text) : "";

    // Rotate keys: odd-indexed fallback attempts use key2 for separate quota
    const activeKey = (i % 2 === 0 || !apiKey2) ? (apiKey || apiKey2) : (apiKey2 || apiKey);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${activeKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
        "X-Title": "OpenClaw Legal Clause Extractor v1",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          { role: "user", content: USER_TEMPLATE(text, context) },
        ],
        temperature: 0.0,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) { lastError = `${model.id} rate-limited`; continue; }
      throw new Error(`OpenRouter ${response.status} on ${model.id}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error(`Non-JSON response from ${model.id}: ${raw.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    const ct = (parsed.clause_type ?? "").trim().toLowerCase().replace(/ /g, "_");
    if (!CLAUSE_TYPES.includes(ct as ClauseType)) throw new Error(`Unknown clause_type '${ct}' from ${model.id}`);

    return {
      clause_type: ct,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? "",
      model_used: model.id,
      model_eval_accuracy: model.eval_accuracy,
      model_eval_macro_f1: model.eval_macro_f1,
      rag_used: useRag,
      fallback_count: i,
      model_index: i,
    };
  }
  throw new Error(`All models exhausted. Last error: ${lastError}`);
}

// ── Provider-aware model call with key rotation ──────────────────────────────
//
// Supports two providers:
//   groq       — https://api.groq.com/openai/v1  (OpenAI-compatible, better rate limits)
//   openrouter — https://openrouter.ai/api/v1    (multi-model gateway)
//
// Key rotation: each ModelEntry specifies which env var holds its API key.
// When a key is rate-limited (429), the next entry in the chain may use a different key.
// This gives effective 2x quota on OpenRouter and priority access via Groq.

function getProviderConfig(entry: ModelEntry): { endpoint: string; apiKey: string; modelId: string } {
  const apiKey = process.env[entry.apiKeyEnv] ?? "";
  if (entry.provider === "groq") {
    return {
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      apiKey,
      modelId: entry.id,  // Groq uses plain model names (no provider prefix)
    };
  }
  return {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    modelId: entry.id,
  };
}

async function callModelWithFallback(
  systemPrompt: string,
  userContent: string,
  title: string,
  maxTokens = 800,
  chain: ModelEntry[] = INTAKE_MODEL_CHAIN,
): Promise<{ parsed: any; model_used: string; fallback_used: boolean; latency_ms: number }> {
  const t0 = Date.now();
  let modelUsed = chain[0].id;
  let fallbackUsed = false;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const { endpoint, apiKey, modelId } = getProviderConfig(entry);

    if (!apiKey) {
      // Key env var not set — skip this entry silently
      if (i < chain.length - 1) { fallbackUsed = true; continue; }
      throw new Error(`API key env var '${entry.apiKeyEnv}' not set and no more fallbacks`);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    // OpenRouter-specific headers
    if (entry.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://openclaw-api-k30t.onrender.com";
      headers["X-Title"] = title;
    }

    const makeRequest = async (sysPrompt: string) =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user",   content: userContent },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(25_000),
      });

    try {
      const response = await makeRequest(systemPrompt);

      if (response.status === 429) {
        // Rate-limited — try next entry (may be different key or provider)
        if (i < chain.length - 1) { fallbackUsed = true; continue; }
        throw new Error("All models/keys rate-limited (429)");
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${entry.provider} ${response.status} on ${modelId}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as any;
      const raw  = data.choices?.[0]?.message?.content ?? "";
      modelUsed  = entry.id;  // record which entry succeeded

      // Extract JSON from response
      const match = raw.match(/\{[\s\S]*\}/);
      let parsed: any = null;
      if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }

      // If JSON parse failed, retry once on the same entry with an explicit JSON instruction.
      // Handles models that return prose or markdown-wrapped JSON on first attempt.
      if (parsed === null) {
        const retryResp = await makeRequest(
          systemPrompt + "\n\nCRITICAL: Respond with valid JSON only. No prose, no markdown, no explanation. Start with { and end with }."
        );
        if (retryResp.ok) {
          const retryData = (await retryResp.json()) as any;
          const retryRaw  = retryData.choices?.[0]?.message?.content ?? "";
          const retryMatch = retryRaw.match(/\{[\s\S]*\}/);
          if (retryMatch) { try { parsed = JSON.parse(retryMatch[0]); } catch { parsed = null; } }
        }
        // If still null after retry, fall through to next chain entry
        if (parsed === null && i < chain.length - 1) { fallbackUsed = true; continue; }
      }

      return { parsed, model_used: modelUsed, fallback_used: fallbackUsed, latency_ms: Date.now() - t0 };
    } catch (err: any) {
      if (i === chain.length - 1) throw err;
      fallbackUsed = true;
    }
  }
  throw new Error("All models failed");
}

/** Satisfies ActionInput/RevisionActionInput callModelWithFallback contract. */
const callModelForLegalAction: ActionInput["callModelWithFallback"] = (
  systemPrompt,
  userContent,
  title,
  maxTokens,
  chain,
) =>
  callModelWithFallback(
    systemPrompt,
    userContent,
    title,
    maxTokens,
    chain as ModelEntry[],
  );

// ── CA non-compete post-processing (S6 fix) ───────────────────────────────────
function applyCANoncompeteRule(
  text: string,
  parsed: { ca_noncompete_void?: boolean; escalation_required?: boolean },
): { ca_noncompete_void: boolean; escalation_required: boolean } {
  const hasNonCompete = /non[- ]?compete|non[- ]?solicitation/i.test(text);
  const hasCA = /california|\bCA\b/i.test(text);
  const caDetected = hasNonCompete && hasCA;
  return {
    ca_noncompete_void: caDetected || (parsed.ca_noncompete_void ?? false),
    escalation_required: caDetected || (parsed.escalation_required ?? false),
  };
}

// ── Internal specialist functions (called by /matter) ─────────────────────────

async function intakeClassify(text: string): Promise<{
  matter_type: string;
  confidence: number;
  routing_target: string;
  reasoning: string;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const MATTER_TYPES = ["contract", "litigation", "ip", "employment", "corporate", "cofounder"] as const;
  const ROUTING_MAP: Record<string, string> = {
    contract:   "/api/v1/legal/contract/analyze",
    litigation: "/api/v1/legal/litigation/analyze",
    ip:         "/api/v1/legal/ip/analyze",
    employment: "/api/v1/legal/employment/analyze",
    corporate:  "/api/v1/legal/corporate/analyze",
    cofounder:  "/api/v1/legal/cofounder/analyze",
  };

  // S4 fix: uncertainty calibration instruction added
  const systemPrompt = `You are a legal matter classifier. Classify the input into exactly one of:
- contract: Contract drafting, review, clause analysis, commercial agreements
- litigation: Disputes, lawsuits, court filings, case strategy, legal proceedings
- ip: Intellectual property — patents, trademarks, copyrights, trade secrets
- employment: Employment law, HR compliance, workplace disputes, labor relations
- corporate: Corporate governance, M&A, board matters, entity formation, securities
- cofounder: Co-founder agreements, founder equity, RSPA, vesting schedules, 83(b) elections, co-founder IP assignment, mutual deliverables, RUO scope, multi-product equity

If you are uncertain about the matter type, set confidence below 0.5 and use matter_type "contract" as the default.

Respond with valid JSON only:
{"matter_type": "<type>", "confidence": <0.0-1.0>, "reasoning": "<brief reason>"}`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw Legal Intake", 200,
  );

  const matterType = (parsed?.matter_type ?? "contract") as string;
  const validMatter = MATTER_TYPES.includes(matterType as any) ? matterType : "contract";

  return {
    matter_type: validMatter,
    confidence: parsed?.confidence ?? 0.5,
    routing_target: ROUTING_MAP[validMatter] ?? ROUTING_MAP["contract"],
    reasoning: parsed?.reasoning ?? "",
    model_used,
    fallback_used,
    latency_ms,
  };
}

async function contractAnalyze(text: string): Promise<{
  risk_flags: Array<{ clause_type: string; clause_text: string; risk_level: string; recommended_action: string }>;
  blocking_issues: string[];
  next_steps: string[];
  overall_risk: string;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const systemPrompt = `You are a contract analysis specialist. Extract and analyze contract clauses. Identify risk levels and provide specific, actionable recommendations that reference the detected clause.

Respond with valid JSON only:
{
  "risk_flags": [{"clause_type": "<type>", "clause_text": "<exact excerpt from input>", "risk_level": "low|medium|high", "recommended_action": "<specific action referencing this clause — must name the clause and the action>"}],
  "blocking_issues": ["<specific issue that blocks execution>"],
  "next_steps": ["<specific actionable step — must name what to do and why>"],
  "overall_risk": "low|medium|high"
}

Rules:
- clause_text must be an exact excerpt from the input, not a paraphrase
- recommended_action must be specific: name the clause, the risk, and the action (not just "review with counsel")
- next_steps must be specific: name what to do, not generic advice
- If no blocking issues, use empty array []`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw Contract Specialist", 1000, SPECIALIST_MODEL_CHAIN,
  );

  return {
    risk_flags: parsed?.risk_flags ?? [],
    blocking_issues: parsed?.blocking_issues ?? [],
    next_steps: parsed?.next_steps ?? [],
    overall_risk: parsed?.overall_risk ?? "unknown",
    model_used,
    fallback_used,
    latency_ms,
  };
}

async function litigationAnalyze(text: string): Promise<{
  key_claims: string[];
  jurisdiction: string | null;
  estimated_complexity: string;
  recommended_next_steps: string[];
  statute_of_limitations_risk: boolean;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const systemPrompt = `You are a litigation analysis specialist. Extract key claims from the input text and provide specific next steps.

Respond with valid JSON only:
{
  "key_claims": ["<specific claim extracted verbatim or closely paraphrased from input>"],
  "jurisdiction": "<jurisdiction or null>",
  "estimated_complexity": "low|medium|high",
  "recommended_next_steps": ["<specific actionable step — name what to do and why>"],
  "statute_of_limitations_risk": true|false
}

Rules:
- key_claims must be extracted from the input text, not invented
- recommended_next_steps must be specific: name the action, the party, and the deadline if relevant
- statute_of_limitations_risk: true if filing deadlines are at risk based on dates mentioned`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw Litigation Specialist", 800, SPECIALIST_MODEL_CHAIN,
  );

  return {
    key_claims: parsed?.key_claims ?? [],
    jurisdiction: parsed?.jurisdiction ?? null,
    estimated_complexity: parsed?.estimated_complexity ?? "unknown",
    recommended_next_steps: parsed?.recommended_next_steps ?? [],
    statute_of_limitations_risk: parsed?.statute_of_limitations_risk ?? false,
    model_used,
    fallback_used,
    latency_ms,
  };
}

async function ipAnalyze(text: string): Promise<{
  ip_type: string;
  ownership_risk: boolean;
  transfer_required: boolean;
  key_restrictions: Array<{ restriction: string; clause_text: string }>;
  recommended_actions: string[];
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const systemPrompt = `You are an intellectual property analysis specialist. Analyze IP-related text and provide specific recommendations that reference detected IP issues.

Respond with valid JSON only:
{
  "ip_type": "patent|trademark|copyright|trade_secret|mixed|other",
  "ownership_risk": true|false,
  "transfer_required": true|false,
  "key_restrictions": [{"restriction": "<specific restriction>", "clause_text": "<exact excerpt from input>"}],
  "recommended_actions": ["<specific action referencing a detected IP issue — name the issue and the action>"]
}

Rules:
- clause_text in key_restrictions must be an exact excerpt from the input
- recommended_actions must reference a specific IP issue detected in the text
- ownership_risk: true if there is ambiguity about who owns the IP`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw IP Specialist", 800, SPECIALIST_MODEL_CHAIN,
  );

  return {
    ip_type: parsed?.ip_type ?? "other",
    ownership_risk: parsed?.ownership_risk ?? false,
    transfer_required: parsed?.transfer_required ?? false,
    key_restrictions: parsed?.key_restrictions ?? [],
    recommended_actions: parsed?.recommended_actions ?? [],
    model_used,
    fallback_used,
    latency_ms,
  };
}

async function employmentAnalyze(text: string): Promise<{
  compliance_flags: Array<{ rule: string; jurisdiction: string | null; severity: string; detected_text: string; recommended_action: string }>;
  ca_noncompete_void: boolean;
  escalation_required: boolean;
  next_steps: string[];
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const systemPrompt = `You are an employment law specialist. Extract employment-related clauses and compliance flags with specific recommendations.

Respond with valid JSON only:
{
  "compliance_flags": [{"rule": "<specific rule or statute name>", "jurisdiction": "<jurisdiction or null>", "severity": "low|medium|high", "detected_text": "<exact excerpt from input>", "recommended_action": "<specific action referencing this rule>"}],
  "ca_noncompete_void": true|false,
  "escalation_required": true|false,
  "next_steps": ["<specific actionable step>"]
}

Rules:
- detected_text must be an exact excerpt from the input
- rule must name a specific statute, regulation, or legal principle (not just "employment law")
- recommended_action must name the rule and the specific action to take
- ca_noncompete_void: true if a non-compete clause is present and California law applies
- escalation_required: true if any high-severity compliance issue is detected`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw Employment Specialist", 800, SPECIALIST_MODEL_CHAIN,
  );

  // S6 fix: CA non-compete post-processing
  const { ca_noncompete_void, escalation_required } = applyCANoncompeteRule(text, {
    ca_noncompete_void: parsed?.ca_noncompete_void,
    escalation_required: parsed?.escalation_required,
  });

  return {
    compliance_flags: parsed?.compliance_flags ?? [],
    ca_noncompete_void,
    escalation_required,
    next_steps: parsed?.next_steps ?? [],
    model_used,
    fallback_used,
    latency_ms,
  };
}

async function corporateAnalyze(text: string): Promise<{
  governance_clauses: Array<{ clause: string; clause_text: string }>;
  board_approval_required: boolean;
  key_obligations: string[];
  compliance_gaps: Array<{ gap: string; obligation: string }>;
  next_steps: string[];
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const systemPrompt = `You are a corporate governance specialist. Analyze corporate governance text and identify compliance gaps with specific next steps.

Respond with valid JSON only:
{
  "governance_clauses": [{"clause": "<clause type>", "clause_text": "<exact excerpt from input>"}],
  "board_approval_required": true|false,
  "key_obligations": ["<specific obligation from the text>"],
  "compliance_gaps": [{"gap": "<specific gap>", "obligation": "<specific obligation or rule not met>"}],
  "next_steps": ["<specific actionable step — name what to do and why>"]
}

Rules:
- clause_text must be an exact excerpt from the input
- compliance_gaps must reference a specific obligation or regulatory requirement
- next_steps must be specific: name the action, the party responsible, and the deadline if relevant`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt, text, "OpenClaw Corporate Specialist", 800, SPECIALIST_MODEL_CHAIN,
  );

  return {
    governance_clauses: parsed?.governance_clauses ?? [],
    board_approval_required: parsed?.board_approval_required ?? false,
    key_obligations: parsed?.key_obligations ?? [],
    compliance_gaps: parsed?.compliance_gaps ?? [],
    next_steps: parsed?.next_steps ?? [],
    model_used,
    fallback_used,
    latency_ms,
  };
}

// ── cofounderAnalyze — co-founder agreement specialist ────────────────────────
//
// Two modes in one call:
//   Analyze: extract and flag issues in existing clause text
//   Draft:   generate compliant draft language for missing/flagged clauses
//
// Always runs both modes. Critical clauses (83b, RUO, equity, IP) are always
// checked regardless of whether their keywords appear in the text.

async function cofounderAnalyze(text: string): Promise<{
  risk_flags: Array<{
    clause_type: CofounderClauseType;
    severity: "critical" | "high" | "medium";
    issue: string;
    clause_text: string;
    recommendation: string;
  }>;
  missing_clauses: CofounderClauseType[];
  blocking_issues: string[];
  overall_risk: "critical" | "high" | "medium" | "low";
  next_steps: string[];
  draft_clauses: Array<{
    clause_type: CofounderClauseType;
    title: string;
    draft_text: string;
    notes: string;
  }>;
  rag_entries_used: number;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  // Retrieve relevant corpus entries (keyword-matched + always include all critical)
  const retrieved = cofounderRetrieve(text, 5);
  const critical = getCriticalEntries();
  // Merge: critical entries always included, retrieved entries add context
  const allEntries = [...critical];
  for (const e of retrieved) {
    if (!allEntries.find((x) => x.clause_type === e.clause_type)) {
      allEntries.push(e);
    }
  }

  // Build RAG context block for the prompt
  const ragContext = allEntries
    .map(
      (e) =>
        `[${e.clause_type.toUpperCase()} — ${e.risk_level.toUpperCase()} RISK]\n` +
        `Rule: ${e.rule}\n` +
        `Red flags: ${e.red_flags.join("; ")}\n` +
        (e.governance_trigger ? `Governance trigger: ${e.governance_trigger}\n` : ""),
    )
    .join("\n---\n");

  const systemPrompt = `You are a co-founder agreement specialist with deep expertise in startup equity, 83(b) elections, RUO regulatory compliance, and co-founder dispute prevention.

You have been given a co-founder agreement text to analyze. You must:
1. Identify all risk flags in the existing text (or note "[MISSING]" if a required clause is absent)
2. List all missing required clauses
3. Identify blocking issues that must be resolved before signing
4. Generate draft clause language for each missing or flagged clause

CRITICAL RULES (always apply, regardless of what is in the text):
- 83(b) election: 30-day IRS window from grant date. Non-waivable. If equity/vesting is mentioned without 83(b), flag as CRITICAL.
- RUO scope: If CMO, medical, clinical, diagnostic, or patient is mentioned, check for RUO limitation. Missing = CRITICAL.
- Equity dilution: If equity % is mentioned without multi-product pool definition, flag as CRITICAL.
- IP assignment: If "all inventions" or broad assignment is present without carve-out, flag as CRITICAL.
- Entity type: If S-Corp or non-profit is mentioned without resolution, flag as HIGH.

KNOWLEDGE BASE (use these rules when analyzing):
${ragContext}

Respond with valid JSON only. No prose, no markdown. Start with { and end with }.

{
  "risk_flags": [
    {
      "clause_type": "<CofounderClauseType>",
      "severity": "critical|high|medium",
      "issue": "<specific problem found in the text>",
      "clause_text": "<exact excerpt from input, or '[MISSING]' if absent>",
      "recommendation": "<specific fix referencing the rule — name the clause, the risk, and the action>"
    }
  ],
  "missing_clauses": ["<clause_type>"],
  "blocking_issues": ["<issue that must be resolved before signing>"],
  "overall_risk": "critical|high|medium|low",
  "next_steps": ["<specific, non-generic step — name what to do, who does it, and when>"],
  "draft_clauses": [
    {
      "clause_type": "<CofounderClauseType>",
      "title": "<clause title>",
      "draft_text": "<ready-to-use clause text with [PLACEHOLDER] for specifics>",
      "notes": "<what the attorney needs to fill in>"
    }
  ]
}`;

  const { parsed, model_used, fallback_used, latency_ms } = await callModelWithFallback(
    systemPrompt,
    `Co-founder agreement text to analyze:\n\n"""\n${text}\n"""`,
    "OpenClaw Co-Founder Specialist",
    2000,
    SPECIALIST_MODEL_CHAIN,
  );

  return {
    risk_flags: parsed?.risk_flags ?? [],
    missing_clauses: parsed?.missing_clauses ?? [],
    blocking_issues: parsed?.blocking_issues ?? [],
    overall_risk: parsed?.overall_risk ?? "high",
    next_steps: parsed?.next_steps ?? [],
    draft_clauses: parsed?.draft_clauses ?? [],
    rag_entries_used: allEntries.length,
    model_used,
    fallback_used,
    latency_ms,
  };
}

// ── handleMatter — shared orchestration logic ─────────────────────────────────
// Used by POST /v1/legal/matter and POST /v1/legal/playbook/run
// Direct function calls — no HTTP redirects, no Kairos, no inter-process messaging.

async function handleMatter(text: string, tenantId: string): Promise<{
  matter_id: string;
  receipt_token: string;
  intake: Record<string, unknown>;
  specialist_output: Record<string, unknown>;
  governance_decision: Record<string, unknown>;
  trace: Record<string, unknown>;
  lineage: Record<string, unknown>;
}> {
  const matterId = randomUUID();
  const t0 = Date.now();

  // Input validation — enforced here so playbook (which calls handleMatter directly) also validates
  if (!text || text.trim().length < 20) {
    throw Object.assign(new Error("text required (min 20 chars)"), { status: 400 });
  }

  // Step 1: Intake classification (direct function call)
  const intake = await intakeClassify(text);
  const intakeLatency = Date.now() - t0;

  // Step 2: Specialist execution (direct function call)
  const tSpecialist = Date.now();
  let specialistOutput: Record<string, unknown>;
  let specialistModel: string;
  let specialistFallback: boolean;

  switch (intake.matter_type) {
    case "contract": {
      const r = await contractAnalyze(text);
      specialistOutput = { risk_flags: r.risk_flags, blocking_issues: r.blocking_issues, next_steps: r.next_steps, overall_risk: r.overall_risk };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    case "litigation": {
      const r = await litigationAnalyze(text);
      specialistOutput = { key_claims: r.key_claims, jurisdiction: r.jurisdiction, estimated_complexity: r.estimated_complexity, recommended_next_steps: r.recommended_next_steps, statute_of_limitations_risk: r.statute_of_limitations_risk };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    case "ip": {
      const r = await ipAnalyze(text);
      specialistOutput = { ip_type: r.ip_type, ownership_risk: r.ownership_risk, transfer_required: r.transfer_required, key_restrictions: r.key_restrictions, recommended_actions: r.recommended_actions };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    case "employment": {
      const r = await employmentAnalyze(text);
      specialistOutput = { compliance_flags: r.compliance_flags, ca_noncompete_void: r.ca_noncompete_void, escalation_required: r.escalation_required, next_steps: r.next_steps };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    case "corporate": {
      const r = await corporateAnalyze(text);
      specialistOutput = { governance_clauses: r.governance_clauses, board_approval_required: r.board_approval_required, key_obligations: r.key_obligations, compliance_gaps: r.compliance_gaps, next_steps: r.next_steps };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    case "cofounder": {
      const r = await cofounderAnalyze(text);
      specialistOutput = {
        risk_flags: r.risk_flags,
        missing_clauses: r.missing_clauses,
        blocking_issues: r.blocking_issues,
        overall_risk: r.overall_risk,
        next_steps: r.next_steps,
        draft_clauses: r.draft_clauses,
        rag_entries_used: r.rag_entries_used,
      };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
      break;
    }
    default: {
      const r = await contractAnalyze(text);
      specialistOutput = { risk_flags: r.risk_flags, blocking_issues: r.blocking_issues, next_steps: r.next_steps, overall_risk: r.overall_risk };
      specialistModel = r.model_used;
      specialistFallback = r.fallback_used;
    }
  }
  const specialistLatency = Date.now() - tSpecialist;

  // Step 3: Governance evaluation (direct function call — changes behavior)
  const govInput: GovernanceInput = {
    matter_id: matterId,
    domain: "legal",
    specialist: intake.matter_type,
    output: specialistOutput,
    raw_text: text,
    confidence: intake.confidence,
    policy: LEGAL_GOVERNANCE_POLICY,
  };
  const decision = evaluateGovernance(govInput);

  const totalLatency = Date.now() - t0;

  // Step 4: Log to model_usage_events (soft-fail — never block the response)
  try {
    await pool.query(
      `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
      [
        tenantId,
        "matter_run",
        JSON.stringify({
          matter_id: matterId,
          domain: "legal",
          specialist: intake.matter_type,
          escalation_triggered: decision.escalation_required,
          impact_tier: decision.impact_tier,
          latency_ms: totalLatency,
        }),
      ],
    );

    if (decision.escalation_required) {
      await pool.query(
        `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
        [
          tenantId,
          "escalation_triggered",
          JSON.stringify({
            matter_id: matterId,
            escalation_reasons: decision.escalation_reasons,
            impact_tier: decision.impact_tier,
          }),
        ],
      );
    }
  } catch {
    // Soft-fail: DB logging must never block the response
  }

  // Step 5: Sign receipt for action endpoint (HMAC-SHA256, SESSION_SECRET)
  const secret = process.env.SESSION_SECRET ?? "";
  const issuedAt = new Date();
  const receipt: MatterReceipt = {
    matter_id: matterId,
    receipt_id: randomUUID(),
    specialist: intake.matter_type,
    original_text_hash: hashText(text),
    specialist_output: decision.redacted_output as Record<string, unknown>,
    governance_decision: {
      action: decision.action,
      escalation_required: decision.escalation_required,
      escalation_reasons: decision.escalation_reasons,
      redacted_fields: decision.redacted_fields,
      impact_tier: decision.impact_tier,
    },
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + (parseInt(process.env.RECEIPT_TTL_HOURS ?? "4", 10) || 4) * 60 * 60 * 1000).toISOString(),
  };
  const receiptToken = signReceipt(receipt, secret);

  // Step 6: Return unified result
  return {
    matter_id: matterId,
    receipt_token: receiptToken,
    intake: {
      matter_type: intake.matter_type,
      confidence: intake.confidence,
      routing_target: intake.routing_target,
      reasoning: intake.reasoning,
      model_used: intake.model_used,
      latency_ms: intakeLatency,
    },
    specialist_output: decision.redacted_output,  // redactions applied by governance
    governance_decision: {
      action: decision.action,
      escalation_required: decision.escalation_required,
      escalation_reasons: decision.escalation_reasons,
      redacted_fields: decision.redacted_fields,
      impact_tier: decision.impact_tier,
      human_review_required: true,
      not_legal_advice: true,
    },
    trace: {
      matter_id: matterId,
      domain: "legal",
      specialist: intake.matter_type,
      intake_latency_ms: intakeLatency,
      specialist_latency_ms: specialistLatency,
      total_latency_ms: totalLatency,
      intake_model: intake.model_used,
      specialist_model: specialistModel!,
      fallback_used: intake.fallback_used || specialistFallback!,
    },
    lineage: {
      asset_version: "v1",
      dataset: "CUAD Legal Clause Dataset v2",
      dataset_version: "v2",
      eval_run: "legal-clause-extraction-v2",
      governance_policy: "legal-v1",
      training_path: "rag_adaptation",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /v1/legal/extract-clause ─────────────────────────────────────────────
router.post("/v1/legal/extract-clause", async (req, res): Promise<void> => {
  const { text, use_rag = true } = req.body ?? {};

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text (string) is required" });
    return;
  }
  if (text.length > 8000) {
    res.status(400).json({ error: "text must be <= 8000 characters" });
    return;
  }

  // S10 fix: privilege detection pre-processing
  const privilegeDetected = detectPrivilege(text);

  const startMs = Date.now();

  try {
    const result = await callWithFallback(text, Boolean(use_rag));
    const latencyMs = Date.now() - startMs;
    const modelIndex = result.model_index;
    const usageEventId = generateUsageEventId();

    // Log to model_usage_events (soft-fail)
    try {
      await pool.query(
        `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
        ["anonymous", "extract_clause", JSON.stringify({ usage_event_id: usageEventId, model_used: result.model_used, latency_ms: latencyMs, privilege_detected: privilegeDetected })],
      );
    } catch { /* soft-fail */ }

    res.json({
      clause_type: result.clause_type,
      confidence: result.confidence,
      reasoning: result.reasoning,
      privilege_detected: privilegeDetected,
      metadata: {
        model: result.model_used,
        fallback_count: result.fallback_count,
        rag_used: result.rag_used,
        asset: "Legal Clause Extractor",
        asset_version: "v1",
        dataset: "CUAD Legal Clause Dataset v2",
        dataset_version: "v2",
        artifact: "clause_index_v2.faiss",
        eval_run: "legal-clause-extraction-v2",
        model_eval_accuracy: result.model_eval_accuracy,
        model_eval_macro_f1: result.model_eval_macro_f1,
        eval_dataset: "CUAD v2 (10 test examples, 2026-05-15)",
        latency_ms: latencyMs,
        known_limitation: "limitation_of_liability may underperform on 1-sentence excerpts with sub-7B models",
      },
      lineage: {
        asset_version: "v1",
        dataset_version: "v2",
        eval_run: "legal-clause-extraction-v2",
        model_eval_accuracy: result.model_eval_accuracy,
      },
      governance: buildGovernanceBlock(result.confidence ?? null, privilegeDetected || undefined),
      trace: buildTraceBlock({
        retrieval_used: result.rag_used,
        retrieval_chunks: result.rag_used ? 3 : 0,
        fallback_used: modelIndex > 0,
        fallback_reason: modelIndex > 0 ? `primary model returned 429, fell back to ${result.model_used}` : null,
        model_used: result.model_used,
        provider_model: result.model_used,
        latency_ms: latencyMs,
        usage_event_id: usageEventId,
      }),
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    res.status(503).json({ error: "Inference failed", details: err.message, latency_ms: latencyMs });
  }
});

// ── GET /v1/legal/extract-clause — asset info + lineage ──────────────────────
router.get("/v1/legal/extract-clause", (_req, res): void => {
  res.json({
    asset: "Legal Clause Extractor",
    asset_version: "v1",
    status: "active",
    lineage: {
      dataset: "CUAD Legal Clause Dataset v2",
      dataset_version: "v2",
      dataset_source: "CUAD v1 (CC BY 4.0), 510 contracts, 41 QA types",
      dataset_size: "50 examples (30 train / 10 val / 10 test)",
      artifact: "clause_index_v2.faiss",
      artifact_type: "FAISS IndexFlatIP",
      artifact_dim: 384,
      artifact_embedder: "sentence-transformers/all-MiniLM-L6-v2",
      artifact_index_size: 30,
      eval_run: "legal-clause-extraction-v2",
      eval_status: "passed",
      registration: "Legal Clause Extractor v1",
      registration_status: "approved",
      deployment_status: "active",
      training_path: "rag_adaptation",
      training_path_note: "Retrieval asset creation only — not fine-tune. For LoRA/fine-tune: Phase 3.",
    },
    model_chain: MODEL_CHAIN.map((m) => ({
      model: m.id,
      eval_accuracy: m.eval_accuracy,
      eval_macro_f1: m.eval_macro_f1,
      eval_latency_s: m.eval_latency_s,
      rag_enabled: m.use_rag,
    })),
    clause_types: CLAUSE_TYPES,
    eval: {
      dataset: "CUAD v2 (CC BY 4.0)",
      test_size: 10,
      eval_date: "2026-05-15",
      conditions: [
        { model: "openai/gpt-oss-20b:free",            rag: false, accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.44 },
        { model: "openai/gpt-oss-20b:free",            rag: true,  accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.70 },
        { model: "openai/gpt-oss-120b:free",           rag: false, accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.45 },
        { model: "openai/gpt-oss-120b:free",           rag: true,  accuracy: 1.0,  macro_f1: 1.0000, latency_s: 4.26 },
        { model: "liquid/lfm-2.5-1.2b-instruct:free", rag: false, accuracy: 0.80, macro_f1: 0.8000, latency_s: 0.53, note: "verified 2026-05-15, n=10" },
        { model: "liquid/lfm-2.5-1.2b-instruct:free", rag: true,  accuracy: 1.00, macro_f1: 1.0000, latency_s: 0.54, note: "verified 2026-05-15, n=10" },
      ],
      heldout_eval: {
        model: "liquid/lfm-2.5-1.2b-instruct:free",
        rag: false,
        accuracy: 0.925,
        macro_f1: 0.937,
        n_responded: 40,
        n_total: 50,
        note: "10 rate-limited — free tier exhausted",
        label: "promising — internal regression verified. NOT production-ready.",
        rag_evaluated: false,
      },
    },
    usage: {
      method: "POST",
      path: "/api/v1/legal/extract-clause",
      body: { text: "string (required, max 8000 chars)", use_rag: "boolean (optional, default true)" },
    },
  });
});

// ── POST /v1/legal/next-asset-baseline ───────────────────────────────────────
router.post("/v1/legal/next-asset-baseline", async (_req, res): Promise<void> => {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY_2 ?? "";
  if (!apiKey) { res.status(503).json({ error: "No OpenRouter API key configured" }); return; }
  try {
    const result = await runTerminationExtractionBaseline(apiKey);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Baseline eval failed", details: err.message });
  }
});

// ── POST /v1/legal/intake — matter classification + routing ──────────────────
router.post("/v1/legal/intake", async (req, res): Promise<void> => {
  const { text, tenant_id } = req.body as { text?: string; tenant_id?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();

  try {
    const result = await intakeClassify(text);
    const latencyMs = Date.now() - t0;

    // Log to model_usage_events (soft-fail)
    try {
      await pool.query(
        `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
        [tenant_id ?? "anonymous", "intake_classify", JSON.stringify({ usage_event_id: usageEventId, matter_type: result.matter_type, confidence: result.confidence, latency_ms: latencyMs })],
      );
    } catch { /* soft-fail */ }

    res.json({
      matter_type: result.matter_type,
      confidence: result.confidence,
      routing_target: result.routing_target,
      reasoning: result.reasoning,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-intake-v1", eval_run: "legal-intake-router-v1-eval", model_eval_accuracy: 0.85 },
      governance: buildGovernanceBlock(result.confidence),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Intake classification failed", details: err.message });
  }
});

// ── POST /v1/legal/contract/analyze ──────────────────────────────────────────
router.post("/v1/legal/contract/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await contractAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      risk_flags: result.risk_flags,
      blocking_issues: result.blocking_issues,
      next_steps: result.next_steps,
      overall_risk: result.overall_risk,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-contract-v1", eval_run: "legal-contract-specialist-v1-eval", model_eval_accuracy: 0.80 },
      governance: buildGovernanceBlock(null),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Contract analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/litigation/analyze ────────────────────────────────────────
router.post("/v1/legal/litigation/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await litigationAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      key_claims: result.key_claims,
      jurisdiction: result.jurisdiction,
      estimated_complexity: result.estimated_complexity,
      recommended_next_steps: result.recommended_next_steps,
      statute_of_limitations_risk: result.statute_of_limitations_risk,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-litigation-v1", eval_run: "legal-litigation-specialist-v1-eval", model_eval_accuracy: 0.80 },
      governance: buildGovernanceBlock(null),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Litigation analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/ip/analyze ─────────────────────────────────────────────────
router.post("/v1/legal/ip/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await ipAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      ip_type: result.ip_type,
      ownership_risk: result.ownership_risk,
      transfer_required: result.transfer_required,
      key_restrictions: result.key_restrictions,
      recommended_actions: result.recommended_actions,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-ip-v1", eval_run: "legal-ip-specialist-v1-eval", model_eval_accuracy: 0.80 },
      governance: buildGovernanceBlock(null),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "IP analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/employment/analyze ────────────────────────────────────────
router.post("/v1/legal/employment/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await employmentAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      compliance_flags: result.compliance_flags,
      ca_noncompete_void: result.ca_noncompete_void,
      escalation_required: result.escalation_required,
      next_steps: result.next_steps,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-employment-v1", eval_run: "legal-employment-specialist-v1-eval", model_eval_accuracy: 0.80 },
      governance: buildGovernanceBlock(null, result.escalation_required || undefined),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Employment analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/corporate/analyze ─────────────────────────────────────────
router.post("/v1/legal/corporate/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await corporateAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      governance_clauses: result.governance_clauses,
      board_approval_required: result.board_approval_required,
      key_obligations: result.key_obligations,
      compliance_gaps: result.compliance_gaps,
      next_steps: result.next_steps,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "legal-corporate-v1", eval_run: "legal-corporate-specialist-v1-eval", model_eval_accuracy: 0.80 },
      governance: buildGovernanceBlock(null),
      trace: buildTraceBlock({ retrieval_used: false, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Corporate analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/matter — WORKFORCE ENTRY POINT ────────────────────────────
// Orchestrates: intake → specialist → governance → log → unified response
// Direct function calls — no HTTP redirects, no Kairos, no inter-process messaging.
router.post("/v1/legal/matter", async (req, res): Promise<void> => {
  const { text, tenant_id } = req.body as { text?: string; tenant_id?: string };

  if (!text || typeof text !== "string" || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }
  if (text.length > 16000) {
    res.status(400).json({ error: "text must be <= 16000 characters" });
    return;
  }

  try {
    const result = await handleMatter(text, tenant_id ?? "anonymous");
    res.json(result);
  } catch (err: any) {
    res.status(503).json({ error: "Matter processing failed", details: err.message });
  }
});

// ── POST /v1/legal/cofounder/analyze ─────────────────────────────────────────
router.post("/v1/legal/cofounder/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) { res.status(400).json({ error: "text required (min 20 chars)" }); return; }

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  try {
    const result = await cofounderAnalyze(text);
    const latencyMs = Date.now() - t0;
    res.json({
      risk_flags: result.risk_flags,
      missing_clauses: result.missing_clauses,
      blocking_issues: result.blocking_issues,
      overall_risk: result.overall_risk,
      next_steps: result.next_steps,
      draft_clauses: result.draft_clauses,
      rag_entries_used: result.rag_entries_used,
      model: result.model_used,
      latency_ms: latencyMs,
      lineage: { asset_version: "v1", dataset_version: "cofounder-corpus-v1", eval_run: "cofounder-specialist-v1-eval", model_eval_accuracy: 0.90 },
      governance: buildGovernanceBlock(null, result.blocking_issues.length > 0 || result.overall_risk === "critical"),
      trace: buildTraceBlock({ retrieval_used: true, retrieval_chunks: result.rag_entries_used, fallback_used: result.fallback_used, fallback_reason: null, model_used: result.model_used, latency_ms: latencyMs, usage_event_id: usageEventId }),
    });
  } catch (err: any) {
    res.status(503).json({ error: "Co-founder analysis failed", details: err.message });
  }
});

// ── POST /v1/legal/playbook/run — 10-scenario playbook runner ─────────────────
router.post("/v1/legal/playbook/run", async (_req, res): Promise<void> => {
  try {
    const matterFn = async (text: string) => {
      try {
        return await handleMatter(text, "playbook");
      } catch (err: any) {
        // Preserve status code from validation errors (e.g., 400 for short text)
        const status = typeof err.status === "number" ? err.status : 503;
        return { error: err.message, status } as any;
      }
    };

    const receipt = await runPlaybook(matterFn);
    res.json(receipt);
  } catch (err: any) {
    res.status(500).json({ error: "Playbook run failed", details: err.message });
  }
});


// ── POST /v1/legal/action — Phase 2A: Action Generation ──────────────────────
// Accepts a server-signed receipt_token from /matter. Verifies HMAC before use.
// Produces a draft letter or clause pack with two-source verification.
// Logs to model_usage_events with event_type "action_run" (HARD-FAIL).
router.post("/v1/legal/action", async (req, res): Promise<void> => {
  const {
    receipt_token,
    action_receipt_token,
    original_text,
    action_type,
    user_instruction,
  } = req.body as {
    receipt_token?: string;
    action_receipt_token?: string;
    original_text?: string;
    action_type?: string;
    user_instruction?: string;
  };

  // ── Input validation (all before any model call) ──────────────────────────
  if (!receipt_token || typeof receipt_token !== "string") {
    res.status(400).json({ error: "receipt_token (string) is required" });
    return;
  }
  if (!original_text || typeof original_text !== "string") {
    res.status(400).json({ error: "original_text (string) is required" });
    return;
  }
  if (original_text.length < 20 || original_text.length > 16000) {
    res.status(400).json({ error: "original_text must be 20–16000 characters" });
    return;
  }
  const VALID_ACTION_TYPES = ["draft_letter", "generate_clause_pack", "generate_revision_plan"];
  if (!action_type || !VALID_ACTION_TYPES.includes(action_type)) {
    res.status(400).json({ error: "action_type must be 'draft_letter', 'generate_clause_pack', or 'generate_revision_plan'" });
    return;
  }
  // generate_revision_plan requires action_receipt_token from a prior /action call
  if (action_type === "generate_revision_plan") {
    if (!action_receipt_token || typeof action_receipt_token !== "string") {
      res.status(400).json({ error: "action_receipt_token (string) is required for generate_revision_plan" });
      return;
    }
  }
  if (user_instruction !== undefined && user_instruction.length > 500) {
    res.status(400).json({ error: "user_instruction must be <= 500 characters" });
    return;
  }

  // ── Verify receipt token (HMAC) ───────────────────────────────────────────
  const secret = process.env.SESSION_SECRET ?? "";
  const receipt = verifyReceiptToken(receipt_token, secret);
  if (!receipt) {
    res.status(401).json({ error: "Invalid or tampered receipt_token" });
    return;
  }

  // ── Verify original_text matches receipt hash ─────────────────────────────
  const textHash = hashText(original_text);
  if (textHash !== receipt.original_text_hash) {
    res.status(400).json({ error: "original_text does not match the receipt — use the same text submitted to /matter" });
    return;
  }

  // ── generate_revision_plan: verify action receipt chain ──────────────────
  // Must happen BEFORE nonce consumption so a bad action receipt doesn't burn
  // the matter receipt nonce.
  let verifiedActionReceipt: ActionReceipt | null = null;
  if (action_type === "generate_revision_plan") {
    verifiedActionReceipt = verifyActionReceiptToken(action_receipt_token!, secret);
    if (!verifiedActionReceipt) {
      res.status(401).json({ error: "Invalid or tampered action_receipt_token" });
      return;
    }
    // Lineage: action receipt must belong to the same matter
    if (verifiedActionReceipt.matter_id !== receipt.matter_id) {
      res.status(400).json({ error: "action_receipt_token matter_id does not match receipt_token matter_id" });
      return;
    }
    // Lineage: original_text hash must match through the chain
    if (verifiedActionReceipt.original_text_hash !== receipt.original_text_hash) {
      res.status(400).json({ error: "action_receipt_token original_text_hash lineage mismatch" });
      return;
    }
    // Cannot revise a blocked artifact — blockers must be resolved first
    if (verifiedActionReceipt.artifact_status === "blocked") {
      res.status(400).json({ error: "cannot generate revision plan for a blocked artifact — resolve blockers first" });
      return;
    }
  }

  const t0 = Date.now();
  const usageEventId = generateUsageEventId();
  const actionTyped = action_type as ActionType;

  // ── Replay prevention — consume nonce(s) atomically before any model call ──
  // For draft_letter / generate_clause_pack: consume matter receipt_id.
  // For generate_revision_plan: consume action_receipt_id (the Phase 2A nonce).
  // INSERT fails with unique_violation (23505) if the nonce was already used.
  // This is a hard-fail: a replay attempt returns 409, not 500.
  const nonceId = actionTyped === "generate_revision_plan"
    ? verifiedActionReceipt!.action_receipt_id
    : receipt.receipt_id;
  try {
    await pool.query(
      `INSERT INTO legal_receipt_nonces (receipt_id, matter_id, action_type, tenant_id)
       VALUES ($1, $2, $3, $4)`,
      [nonceId, receipt.matter_id, actionTyped, "anonymous"],
    );
  } catch (nonceErr: any) {
    if (nonceErr.code === "23505") {
      // unique_violation — receipt already consumed
      const msg = actionTyped === "generate_revision_plan"
        ? "action_receipt_token already consumed — request a new action receipt from /action"
        : "receipt already consumed — request a new receipt from /matter";
      res.status(409).json({ error: msg });
      return;
    }
    // Unexpected DB error — surface as 500
    res.status(500).json({ error: "Action generation failed", details: nonceErr.message });
    return;
  }

  try {
    const issues = extractIssues(receipt.specialist_output);
    const privilegeDetected = detectPrivilege(original_text);

    // ── Pass 1: Draft ─────────────────────────────────────────────────────
    const actionInput = {
      receipt,
      originalText: original_text,
      actionType: actionTyped,
      userInstruction: user_instruction,
      callModelWithFallback: callModelForLegalAction,
      modelChain: SPECIALIST_MODEL_CHAIN as unknown[],
    };

    let draftArtifact: Record<string, unknown>;
    let draftBody: string;
    let draftModelUsed: string;
    let draftFallback: boolean;
    let draftLatency: number;

    // ── generate_revision_plan branch ────────────────────────────────────
    if (actionTyped === "generate_revision_plan") {
      const revisionInput: RevisionActionInput = {
        matterReceipt: receipt,
        actionReceipt: verifiedActionReceipt!,
        originalText: original_text,
        userInstruction: user_instruction,
        callModelWithFallback: callModelForLegalAction,
        modelChain: SPECIALIST_MODEL_CHAIN as unknown[],
      };

      const revResult = await generateRevisionPlan(revisionInput);
      const revArtifact = revResult.artifact;
      const revBody = JSON.stringify(revArtifact.edits);

      // Pass 2: verify revision plan (distinct contract from verifyDraft)
      const tRevVerify = Date.now();
      const revVerification = await verifyRevisionPlan(
        revArtifact,
        original_text,
        issues,
        callModelForLegalAction,
        SPECIALIST_MODEL_CHAIN as unknown[],
      );
      const revVerifyLatency = Date.now() - tRevVerify;

      // Build issue resolution map from revision plan coverage
      const revCoverageForMap = issues.map((issue) => {
        if (revArtifact.unaddressable_issues.includes(issue.id)) {
          return { issue_id: issue.id, status: "human_only_blocker", evidence: "Flagged as unaddressable by revision planner" };
        }
        const edit = revArtifact.edits.find((e) => e.issue_id === issue.id);
        if (!edit) {
          return { issue_id: issue.id, status: "unresolved", evidence: "No edit generated" };
        }
        if (edit.edit_type === "flag_for_attorney") {
          return { issue_id: issue.id, status: "human_only_blocker", evidence: "Flagged for attorney action" };
        }
        return { issue_id: issue.id, status: "addressed", evidence: `Edit proposed: ${edit.edit_type} at ${edit.location_hint}` };
      });
      const revIssueResolutionMap = buildIssueResolutionMap(issues, revCoverageForMap);

      const revGovernance = buildRevisionGovernance(revVerification, privilegeDetected);

      // Hashes
      const revDraftHashFull = hashText(revBody);
      const revVerificationHashFull = hashText(JSON.stringify(revVerification));
      const revIssueMapHashFull = hashText(JSON.stringify(revIssueResolutionMap));
      const revDraftHash = revDraftHashFull.slice(0, 16);
      const revVerificationHash = revVerificationHashFull.slice(0, 16);
      const revTotalLatency = Date.now() - t0;

      // Hard-fail log
      await pool.query(
        `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
        [
          "anonymous",
          "action_run",
          JSON.stringify({
            matter_id: receipt.matter_id,
            action_type: actionTyped,
            artifact_status: revGovernance.artifact_status,
            draft_hash: revDraftHash,
            verification_hash: revVerificationHash,
            issue_resolution_map: revIssueResolutionMap,
            governance: {
              impact_tier: revGovernance.impact_tier,
              approval_required: revGovernance.approval_required,
              escalation_required: revGovernance.escalation_required,
            },
            revision_model: revResult.model_used,
            verification_model: revVerification.model_used,
            revision_latency_ms: revResult.latency_ms,
            verification_latency_ms: revVerifyLatency,
            total_latency_ms: revTotalLatency,
            usage_event_id: usageEventId,
            revision_prompt_version: REDLINE_PROMPT_VERSION,
            policy_version: ACTION_POLICY_VERSION,
          }),
        ],
      );

      // Sign action receipt for this revision run
      const revReceiptIssuedAt = new Date();
      const revActionReceiptPayload: ActionReceipt = {
        matter_id: receipt.matter_id,
        action_receipt_id: randomUUID(),
        action_type: actionTyped,
        artifact_status: revGovernance.artifact_status,
        draft_hash: revDraftHashFull,
        verification_hash: revVerificationHashFull,
        issue_resolution_map_hash: revIssueMapHashFull,
        original_text_hash: receipt.original_text_hash,
        draft_prompt_version: REDLINE_PROMPT_VERSION,
        verification_prompt_version: REDLINE_PROMPT_VERSION,
        policy_version: ACTION_POLICY_VERSION,
        issued_at: revReceiptIssuedAt.toISOString(),
        expires_at: new Date(
          revReceiptIssuedAt.getTime() +
          ((parseInt(process.env.RECEIPT_TTL_HOURS ?? "4", 10) || 4) * 60 * 60 * 1000),
        ).toISOString(),
      };
      const revActionReceiptToken = signActionReceipt(revActionReceiptPayload, secret);

      res.json({
        matter_id: receipt.matter_id,
        action_type: actionTyped,
        artifact_status: revGovernance.artifact_status,
        action_receipt_token: revActionReceiptToken,
        draft_artifact: revArtifact,
        issue_resolution_map: revIssueResolutionMap,
        verification: {
          passed: revVerification.passed,
          missing_edits: revVerification.missing_edits,
          invented_facts: revVerification.invented_facts,
          misrouted_blockers: revVerification.misrouted_blockers,
        },
        governance: revGovernance,
        trace: {
          matter_id: receipt.matter_id,
          action_type: actionTyped,
          revision_model: revResult.model_used,
          verification_model: revVerification.model_used,
          revision_latency_ms: revResult.latency_ms,
          verification_latency_ms: revVerifyLatency,
          total_latency_ms: revTotalLatency,
          draft_hash: revDraftHash,
          verification_hash: revVerificationHash,
          usage_event_id: usageEventId,
          revision_prompt_version: REDLINE_PROMPT_VERSION,
          policy_version: ACTION_POLICY_VERSION,
        },
      });
      return;
    }

    if (actionTyped === "draft_letter") {
      const r = await draftLetter(actionInput);
      draftArtifact = r.artifact as unknown as Record<string, unknown>;
      draftBody = r.artifact.body;
      draftModelUsed = r.model_used;
      draftFallback = r.fallback_used;
      draftLatency = r.latency_ms;
    } else {
      const r = await generateClausePack(actionInput);
      draftArtifact = r.artifact as unknown as Record<string, unknown>;
      draftBody = JSON.stringify(r.artifact.clauses);
      draftModelUsed = r.model_used;
      draftFallback = r.fallback_used;
      draftLatency = r.latency_ms;
    }

    // ── Output size check (post-generation, pre-verification) ────────────
    const oversized =
      actionTyped === "draft_letter" &&
      typeof (draftArtifact as any).body === "string" &&
      (draftArtifact as any).body.length > 4000;

    // ── Pass 2: Verify ────────────────────────────────────────────────────
    const tVerify = Date.now();
    const verification = await verifyDraft(
      draftBody,
      original_text,
      issues,
      actionTyped,
      callModelForLegalAction,
      SPECIALIST_MODEL_CHAIN as unknown[],
    );
    const verifyLatency = Date.now() - tVerify;

    // Inject oversized flag into verification result
    if (oversized) {
      verification.passed = false;
      verification.new_risks_detected.push("draft_exceeds_length_limit");
    }

    // Placeholder count check
    const placeholders: string[] = Array.isArray((draftArtifact as any).placeholders)
      ? (draftArtifact as any).placeholders
      : [];
    if (placeholders.length > 20) {
      verification.new_risks_detected.push("excessive_placeholder_count — review for missing facts");
    }

    // ── Build issue resolution map ────────────────────────────────────────
    // Extract coverage from verification model output (re-parse from verifyDraft internals)
    // verifyDraft returns structured fields; we reconstruct coverage from unresolved + human_only
    const coverageForMap = issues.map((issue) => {
      if (verification.human_only_blockers.includes(issue.id)) {
        return { issue_id: issue.id, status: "human_only_blocker", evidence: "Flagged by verifier as requiring attorney action" };
      }
      if (verification.unresolved_issues.includes(issue.id)) {
        return { issue_id: issue.id, status: "unresolved", evidence: "Not addressed in draft" };
      }
      if (verification.partially_addressed_issues.includes(issue.id)) {
        return { issue_id: issue.id, status: "partially_addressed", evidence: "Partially addressed in draft per verifier" };
      }
      return { issue_id: issue.id, status: "addressed", evidence: "Addressed in draft per verifier" };
    });
    const issueResolutionMap = buildIssueResolutionMap(issues, coverageForMap);

    // ── Governance state machine ──────────────────────────────────────────
    const governance = buildActionGovernance(verification, actionTyped, privilegeDetected);

    // ── Hashes ────────────────────────────────────────────────────────────
    // Full SHA-256 hashes for the action receipt (provenance chain).
    // Truncated 16-char versions kept in the DB log for display only.
    const draftHashFull = hashText(draftBody);
    const verificationHashFull = hashText(JSON.stringify(verification));
    const issueResolutionMapHashFull = hashText(JSON.stringify(issueResolutionMap));
    const draftHash = draftHashFull.slice(0, 16);
    const verificationHash = verificationHashFull.slice(0, 16);

    const totalLatency = Date.now() - t0;

    // ── Hard-fail action run log ──────────────────────────────────────────
    await pool.query(
      `INSERT INTO model_usage_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
      [
        "anonymous",
        "action_run",
        JSON.stringify({
          matter_id: receipt.matter_id,
          action_type: actionTyped,
          artifact_status: governance.artifact_status,
          draft_hash: draftHash,
          verification_hash: verificationHash,
          issue_resolution_map: issueResolutionMap,
          governance: {
            impact_tier: governance.impact_tier,
            approval_required: governance.approval_required,
            escalation_required: governance.escalation_required,
          },
          draft_model: draftModelUsed,
          verification_model: verification.model_used,
          draft_latency_ms: draftLatency,
          verification_latency_ms: verifyLatency,
          total_latency_ms: totalLatency,
          usage_event_id: usageEventId,
          draft_prompt_version: DRAFT_PROMPT_VERSION,
          verification_prompt_version: VERIFY_PROMPT_VERSION,
          policy_version: ACTION_POLICY_VERSION,
          corpus_version: CORPUS_VERSION,
        }),
      ],
    );
    // Hard-fail: if pool.query throws, the catch block returns 500

    // ── Sign action receipt (Phase 2B trust anchor) ───────────────────────
    // The action receipt carries full hashes and lineage so generate_revision_plan
    // can verify provenance without accepting unsigned client-supplied artifacts.
    const actionReceiptIssuedAt = new Date();
    const actionReceiptPayload: ActionReceipt = {
      matter_id: receipt.matter_id,
      action_receipt_id: randomUUID(),
      action_type: actionTyped,
      artifact_status: governance.artifact_status,
      draft_hash: draftHashFull,
      verification_hash: verificationHashFull,
      issue_resolution_map_hash: issueResolutionMapHashFull,
      original_text_hash: receipt.original_text_hash,  // lineage from MatterReceipt
      draft_prompt_version: DRAFT_PROMPT_VERSION,
      verification_prompt_version: VERIFY_PROMPT_VERSION,
      policy_version: ACTION_POLICY_VERSION,
      issued_at: actionReceiptIssuedAt.toISOString(),
      expires_at: new Date(
        actionReceiptIssuedAt.getTime() +
        ((parseInt(process.env.RECEIPT_TTL_HOURS ?? "4", 10) || 4) * 60 * 60 * 1000),
      ).toISOString(),
    };
    const actionReceiptToken = signActionReceipt(actionReceiptPayload, secret);

    // ── Response ──────────────────────────────────────────────────────────
    res.json({
      matter_id: receipt.matter_id,
      action_type: actionTyped,
      artifact_status: governance.artifact_status,
      action_receipt_token: actionReceiptToken,
      draft_artifact: draftArtifact,
      issue_resolution_map: issueResolutionMap,
      verification: {
        passed: verification.passed,
        unresolved_issues: verification.unresolved_issues,
        partially_addressed_issues: verification.partially_addressed_issues,
        new_risks_detected: verification.new_risks_detected,
        human_only_blockers: verification.human_only_blockers,
      },
      governance,
      trace: {
        matter_id: receipt.matter_id,
        action_type: actionTyped,
        draft_model: draftModelUsed,
        verification_model: verification.model_used,
        draft_latency_ms: draftLatency,
        verification_latency_ms: verifyLatency,
        total_latency_ms: totalLatency,
        draft_hash: draftHash,
        verification_hash: verificationHash,
        usage_event_id: usageEventId,
        draft_prompt_version: DRAFT_PROMPT_VERSION,
        verification_prompt_version: VERIFY_PROMPT_VERSION,
        policy_version: ACTION_POLICY_VERSION,
        corpus_version: CORPUS_VERSION,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: "Action generation failed", details: err.message });
  }
});

// ── Startup Counsel draft routes ──────────────────────────────────────────────
// POST /api/v1/legal/draft        — deterministic draft generation (no model calls)
// POST /api/v1/legal/draft/revise — apply revision instruction to existing draft
router.use(draftRouter);

export default router;
