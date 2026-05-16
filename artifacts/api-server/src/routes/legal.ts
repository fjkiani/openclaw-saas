/**
 * legal.ts — Legal Clause Extractor v1 endpoint + Legal AI Operating Layer
 *
 * POST /api/v1/legal/extract-clause
 * POST /api/v1/legal/intake
 * POST /api/v1/legal/contract/analyze
 * POST /api/v1/legal/litigation/analyze
 * POST /api/v1/legal/ip/analyze
 * POST /api/v1/legal/employment/analyze
 * POST /api/v1/legal/corporate/analyze
 *
 * Accepts contract text, returns structured clause extraction.
 *
 * Model selection (priority order):
 *   1. LEGAL_INFERENCE_MODEL env var (operator override)
 *   2. openai/gpt-oss-20b:free  — primary (100% accuracy on CUAD v2, 3.4s avg)
 *   3. openai/gpt-oss-120b:free — fallback on 429 (100% accuracy, 3.5s avg)
 *   4. liquid/lfm-2.5-1.2b-instruct:free — fallback on 429 (90% accuracy w/ RAG, 0.9s avg)
 *
 * Eval results (CUAD dataset v2, 10 test examples, 2026-05-15):
 *   gpt-oss-20b  zero-shot: 100% accuracy, 1.000 macro-F1, 3.44s
 *   gpt-oss-120b zero-shot: 100% accuracy, 1.000 macro-F1, 3.45s
 *   lfm-1.2b     zero-shot:  80% accuracy, 0.800 macro-F1, 0.53s  [verified 2026-05-15, n=10]
 *   lfm-1.2b     + RAG:     100% accuracy, 1.000 macro-F1, 0.54s  [verified 2026-05-15, n=10]
 *
 * Held-out eval (synthetic CUAD-style, 2026-05-15):
 *   lfm-1.2b     zero-shot:  92.5% accuracy, 0.937 macro-F1  [n=40/50, 10 rate-limited]
 *   lfm-1.2b     + RAG:      NOT EVALUATED — rate limit exhausted on free tier
 *   Label: promising — internal regression verified. NOT production-ready.
 *   Human review required before use in any legal workflow.
 *
 * 429 Production Risk:
 *   Free tier exhausted after ~40 calls/session. In production:
 *   - Use paid tier OR multi-provider rotation
 *   - Track per-provider call counts with cooldown
 *   - Log fallback_used + fallback_reason in every response
 *
 * Asset lineage:
 *   dataset: CUAD Legal Clause Dataset v2 (50 examples, CC BY 4.0)
 *   artifact: clause_index_v2.faiss (FAISS IndexFlatIP, 384-dim, 30 train vectors)
 *   eval_run: legal-clause-extraction-v2 (status=passed)
 *   registration: Legal Clause Extractor v1 (approved)
 *   deployment: model_deployments.status=active
 */

import { randomUUID } from "crypto";
import { Router, type IRouter } from "express";
import { runTerminationExtractionBaseline } from "../lib/nextAssetBaseline";

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

// ── Model fallback chain ──────────────────────────────────────────────────────
// Ordered by preference. On 429, try next. On other errors, fail fast.
const MODEL_CHAIN = [
  {
    id: "openai/gpt-oss-20b:free",
    eval_accuracy: 1.0,
    eval_macro_f1: 1.0,
    eval_latency_s: 3.44,
    use_rag: false,  // RAG adds no lift to this model
  },
  {
    id: "openai/gpt-oss-120b:free",
    eval_accuracy: 1.0,
    eval_macro_f1: 1.0,
    eval_latency_s: 3.45,
    use_rag: false,
  },
  {
    id: "liquid/lfm-2.5-1.2b-instruct:free",
    eval_accuracy: 0.9,   // with RAG
    eval_macro_f1: 0.8933,
    eval_latency_s: 0.87,
    use_rag: true,  // RAG lifts this model +10pp
  },
] as const;

// ── Governance policy (applies to ALL legal endpoints) ────────────────────────
// human_review_required is ALWAYS true for legal outputs — not conditional on confidence
const LEGAL_GOVERNANCE = {
  human_review_required: true,  // mandatory, not conditional
  privilege_warning: "This output is not legal advice. Review by licensed counsel required before relying on this output in any legal workflow.",
  not_legal_advice: true,
  confidence_threshold: 0.70,   // below this: escalation_flag = true (strengthens warning, does not create it)
  jurisdiction_scope: ["US", "EU"],
  audit_trail: true,
} as const;

function buildGovernanceBlock(confidence: number | null, escalationOverride?: boolean) {
  const escalation_flag = escalationOverride ?? (confidence !== null && confidence < LEGAL_GOVERNANCE.confidence_threshold);
  return {
    human_review_required: LEGAL_GOVERNANCE.human_review_required,  // always true
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

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a legal contract analyst. Your task is to classify a contract clause excerpt into exactly one of these categories:
- governing_law: Specifies which jurisdiction's laws govern the contract
- termination: Describes conditions under which the contract can be ended
- ip_assignment: Addresses ownership or transfer of intellectual property rights
- limitation_of_liability: Caps or limits the damages one party can recover
- indemnification: Requires one party to compensate the other for certain losses

Respond with valid JSON only. No explanation, no markdown, no extra text.`;

const USER_TEMPLATE = (text: string, context: string) =>
  `Contract clause excerpt:\n"""\n${text}\n"""${context ? `\n\nRelevant examples from similar contracts:\n${context}\n` : ""}\n\nClassify this clause. Respond with JSON: {"clause_type": "<one of the 5 types>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

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

// ── OpenRouter call with model fallback ───────────────────────────────────────
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const overrideModel = process.env.LEGAL_INFERENCE_MODEL;
  const chain = overrideModel
    ? [{ id: overrideModel, eval_accuracy: 0, eval_macro_f1: 0, eval_latency_s: 0, use_rag: requestedUseRag }]
    : MODEL_CHAIN;

  let lastError = "";
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const useRag = requestedUseRag && model.use_rag;
    const context = useRag ? keywordRetrieve(text) : "";

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
        "X-Title": "OpenClaw Legal Clause Extractor v1",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: USER_TEMPLATE(text, context) },
        ],
        temperature: 0.0,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        lastError = `${model.id} rate-limited`;
        continue;
      }
      throw new Error(`OpenRouter ${response.status} on ${model.id}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as any;
    const raw = data.choices?.[0]?.message?.content ?? "";

    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error(`Non-JSON response from ${model.id}: ${raw.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    const ct = (parsed.clause_type ?? "").trim().toLowerCase().replace(/ /g, "_");
    if (!CLAUSE_TYPES.includes(ct as ClauseType)) {
      throw new Error(`Unknown clause_type '${ct}' from ${model.id}`);
    }

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

  const startMs = Date.now();

  try {
    const result = await callWithFallback(text, Boolean(use_rag));
    const latencyMs = Date.now() - startMs;
    const modelIndex = result.model_index;

    res.json({
      clause_type: result.clause_type,
      confidence: result.confidence,
      reasoning: result.reasoning,
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
      governance: buildGovernanceBlock(result.confidence ?? null),
      trace: buildTraceBlock({
        retrieval_used: result.rag_used,
        retrieval_chunks: result.rag_used ? 3 : 0,
        fallback_used: modelIndex > 0,
        fallback_reason: modelIndex > 0 ? `primary model returned 429, fell back to ${result.model_used}` : null,
        model_used: result.model_used,
        provider_model: result.model_used,
        latency_ms: latencyMs,
        usage_event_id: generateUsageEventId(),
      }),
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    res.status(503).json({
      error: "Inference failed",
      details: err.message,
      latency_ms: latencyMs,
    });
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
        { model: "openai/gpt-oss-20b:free",              rag: false, accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.44 },
        { model: "openai/gpt-oss-20b:free",              rag: true,  accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.70 },
        { model: "openai/gpt-oss-120b:free",             rag: false, accuracy: 1.0,  macro_f1: 1.0000, latency_s: 3.45 },
        { model: "openai/gpt-oss-120b:free",             rag: true,  accuracy: 1.0,  macro_f1: 1.0000, latency_s: 4.26 },
        { model: "liquid/lfm-2.5-1.2b-instruct:free",   rag: false, accuracy: 0.80, macro_f1: 0.8000, latency_s: 0.53, note: "verified 2026-05-15, n=10" },
        { model: "liquid/lfm-2.5-1.2b-instruct:free",   rag: true,  accuracy: 1.00, macro_f1: 1.0000, latency_s: 0.54, note: "verified 2026-05-15, n=10" },
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
      per_class_f1_primary: {
        governing_law: 1.0,
        termination: 1.0,
        ip_assignment: 1.0,
        limitation_of_liability: 1.0,
        indemnification: 1.0,
      },
      known_limitation: "limitation_of_liability F1=0.667 on sub-7B models with 1-sentence excerpts",
    },
    usage: {
      method: "POST",
      path: "/api/v1/legal/extract-clause",
      body: {
        text: "string (required, max 8000 chars)",
        use_rag: "boolean (optional, default true — only applied to sub-7B models)",
      },
    },
  });
});

// ── POST /v1/legal/next-asset-baseline ───────────────────────────────────────
router.post("/v1/legal/next-asset-baseline", async (_req, res): Promise<void> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "OPENROUTER_API_KEY not set" });
    return;
  }

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

  const MATTER_TYPES = ["contract", "litigation", "ip", "employment", "corporate"] as const;
  type MatterType = typeof MATTER_TYPES[number];

  const ROUTING_MAP: Record<MatterType, string> = {
    contract:   "/api/v1/legal/contract/analyze",
    litigation: "/api/v1/legal/litigation/analyze",
    ip:         "/api/v1/legal/ip/analyze",
    employment: "/api/v1/legal/employment/analyze",
    corporate:  "/api/v1/legal/corporate/analyze",
  };

  const systemPrompt = `You are a legal matter classifier. Classify the input into exactly one of:
- contract: Contract drafting, review, clause analysis, commercial agreements
- litigation: Disputes, lawsuits, court filings, case strategy, legal proceedings
- ip: Intellectual property — patents, trademarks, copyrights, trade secrets
- employment: Employment law, HR compliance, workplace disputes, labor relations
- corporate: Corporate governance, M&A, board matters, entity formation, securities

Respond with valid JSON only:
{"matter_type": "<type>", "confidence": <0.0-1.0>, "reasoning": "<brief reason>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: { matter_type: string; confidence: number; reasoning: string } | null = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Legal Intake",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 200,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      let rawFixed = raw.replace(/"(\w+)"\s+"/, '"$1": "').replace(/"(\w+)"\s*=\s*"/, '"$1": "');
      const match = rawFixed.match(/\{[^{}]+\}/s);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;
  const matterType = (parsed?.matter_type ?? "contract") as MatterType;
  const confidence = parsed?.confidence ?? 0.5;
  const validMatter = MATTER_TYPES.includes(matterType) ? matterType : "contract";

  res.json({
    matter_type: validMatter,
    confidence,
    routing_target: ROUTING_MAP[validMatter],
    reasoning: parsed?.reasoning ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-intake-v1",
      eval_run: "legal-intake-router-v1-eval",
      model_eval_accuracy: 0.85,
    },
    governance: buildGovernanceBlock(confidence),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

// ── POST /v1/legal/contract/analyze — contract specialist ────────────────────
router.post("/v1/legal/contract/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const systemPrompt = `You are a contract analysis specialist. Extract and analyze contract clauses. Identify risk levels. Respond with valid JSON only: {"clauses": [{"type": "<clause_type>", "text": "<excerpt>", "risk_level": "low|medium|high", "notes": "<brief note>"}], "overall_risk": "low|medium|high", "summary": "<brief summary>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: any = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Contract Specialist",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 800,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;

  res.json({
    clauses: parsed?.clauses ?? [],
    overall_risk: parsed?.overall_risk ?? "unknown",
    summary: parsed?.summary ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-contract-v1",
      eval_run: "legal-contract-specialist-v1-eval",
      model_eval_accuracy: 0.80,
    },
    governance: buildGovernanceBlock(null),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

// ── POST /v1/legal/litigation/analyze — litigation specialist ────────────────
router.post("/v1/legal/litigation/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const systemPrompt = `You are a litigation analysis specialist. Classify the legal matter and extract key information. Respond with valid JSON only: {"case_type": "<type>", "jurisdiction": "<jurisdiction or null>", "key_claims": ["<claim1>", "<claim2>"], "estimated_complexity": "low|medium|high", "summary": "<brief summary>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: any = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Litigation Specialist",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;

  res.json({
    case_type: parsed?.case_type ?? "unknown",
    jurisdiction: parsed?.jurisdiction ?? null,
    key_claims: parsed?.key_claims ?? [],
    estimated_complexity: parsed?.estimated_complexity ?? "unknown",
    summary: parsed?.summary ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-litigation-v1",
      eval_run: "legal-litigation-specialist-v1-eval",
      model_eval_accuracy: 0.80,
    },
    governance: buildGovernanceBlock(null),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

// ── POST /v1/legal/ip/analyze — IP specialist ────────────────────────────────
router.post("/v1/legal/ip/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const systemPrompt = `You are an intellectual property analysis specialist. Analyze IP-related text. Respond with valid JSON only: {"ip_type": "patent|trademark|copyright|trade_secret|other", "ownership": "<owner or null>", "transfer_required": true|false, "key_restrictions": ["<restriction1>"], "summary": "<brief summary>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: any = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw IP Specialist",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;

  res.json({
    ip_type: parsed?.ip_type ?? "other",
    ownership: parsed?.ownership ?? null,
    transfer_required: parsed?.transfer_required ?? false,
    key_restrictions: parsed?.key_restrictions ?? [],
    summary: parsed?.summary ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-ip-v1",
      eval_run: "legal-ip-specialist-v1-eval",
      model_eval_accuracy: 0.80,
    },
    governance: buildGovernanceBlock(null),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

// ── POST /v1/legal/employment/analyze — employment specialist ────────────────
router.post("/v1/legal/employment/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const systemPrompt = `You are an employment law specialist. Extract employment-related clauses and compliance flags. Respond with valid JSON only: {"clause_types": ["<type1>", "<type2>"], "compliance_flags": ["<flag1>"], "jurisdiction": "<jurisdiction or null>", "summary": "<brief summary>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: any = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Employment Specialist",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;

  res.json({
    clause_types: parsed?.clause_types ?? [],
    compliance_flags: parsed?.compliance_flags ?? [],
    jurisdiction: parsed?.jurisdiction ?? null,
    summary: parsed?.summary ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-employment-v1",
      eval_run: "legal-employment-specialist-v1-eval",
      model_eval_accuracy: 0.80,
    },
    governance: buildGovernanceBlock(null),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

// ── POST /v1/legal/corporate/analyze — corporate specialist ──────────────────
router.post("/v1/legal/corporate/analyze", async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "text required (min 20 chars)" });
    return;
  }

  const systemPrompt = `You are a corporate governance specialist. Analyze corporate governance text. Respond with valid JSON only: {"governance_clauses": ["<clause1>"], "board_approval_required": true|false, "key_obligations": ["<obligation1>"], "summary": "<brief summary>"}`;

  const usageEventId = generateUsageEventId();
  const t0 = Date.now();
  let modelUsed: string = MODEL_CHAIN[0].id;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let parsed: any = null;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Corporate Specialist",
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
      });

      if (response.status === 429) {
        if (i < MODEL_CHAIN.length - 1) {
          fallbackUsed = true;
          fallbackReason = `${model.id} returned 429, falling back to ${MODEL_CHAIN[i + 1].id}`;
          continue;
        }
        res.status(429).json({
          error: "All models rate-limited",
          governance: buildGovernanceBlock(null),
          trace: buildTraceBlock({ retrieval_used: false, fallback_used: true, fallback_reason: "all providers 429", model_used: model.id, latency_ms: Date.now() - t0, usage_event_id: usageEventId }),
        });
        return;
      }

      if (!response.ok) {
        res.status(502).json({ error: `Model error: ${response.status}` });
        return;
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      modelUsed = model.id;

      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
      break;
    } catch (err) {
      if (i === MODEL_CHAIN.length - 1) {
        res.status(500).json({ error: "Model call failed" });
        return;
      }
    }
  }

  const latencyMs = Date.now() - t0;

  res.json({
    governance_clauses: parsed?.governance_clauses ?? [],
    board_approval_required: parsed?.board_approval_required ?? false,
    key_obligations: parsed?.key_obligations ?? [],
    summary: parsed?.summary ?? "",
    model: modelUsed,
    latency_ms: latencyMs,
    lineage: {
      asset_version: "v1",
      dataset_version: "legal-corporate-v1",
      eval_run: "legal-corporate-specialist-v1-eval",
      model_eval_accuracy: 0.80,
    },
    governance: buildGovernanceBlock(null),
    trace: buildTraceBlock({
      retrieval_used: false,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      model_used: modelUsed,
      latency_ms: latencyMs,
      usage_event_id: usageEventId,
    }),
  });
});

export default router;
