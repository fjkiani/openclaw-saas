/**
 * contractExtractor.ts
 *
 * Extracts structured DraftIntake fields from raw contract text using a
 * specialist LLM. Self-contained model call helper — no import from legal.ts.
 *
 * Exports:
 *   extractIntakeFromText(text, doc_class) → ExtractResult
 */

import type { DraftIntake, DocClass } from "./draftReceiptEngine";
import { resolveApiKey } from "./resolveApiKey.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UncertainField {
  field: string;
  extracted_value: unknown;
  confidence: number;   // 0.0–1.0
  reason: string;
}

export interface ExtractResult {
  /** Raw extraction — may contain uncertain or missing fields. */
  intake: DraftIntake;
  /**
   * Intake with uncertain fields (confidence < 0.6) replaced by safe defaults.
   * Use this for buildDraft() to avoid placeholder leaks.
   */
  draft_ready_intake: DraftIntake;
  uncertain_fields: UncertainField[];
  unextractable_fields: string[];
  extraction_confidence: number;   // 0.0–1.0 overall
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}

// ── Model chain (duplicated from legal.ts — no shared-infra refactor in v1) ──

type Provider = "groq" | "openrouter";

interface ModelEntry {
  id: string;
  provider: Provider;
  apiKeyEnv: string;
}

const GROQ_LLAMA_70B = "llama-3.3-70b-versatile";
const OR_LLAMA_70B   = "meta-llama/llama-3.3-70b-instruct:free";
const OR_GPT_120B    = "openai/gpt-oss-120b:free";
const OR_GPT_20B     = "openai/gpt-oss-20b:free";

const SPECIALIST_MODEL_CHAIN: ModelEntry[] = [
  { id: GROQ_LLAMA_70B, provider: "groq",       apiKeyEnv: "GROQ_API_KEY"         },
  { id: OR_LLAMA_70B,   provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY"   },
  { id: OR_LLAMA_70B,   provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2" },
  { id: OR_GPT_120B,    provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY"   },
  { id: OR_GPT_20B,     provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2" },
];

function getProviderConfig(entry: ModelEntry): { endpoint: string; apiKey: string; modelId: string } {
  const apiKey = resolveApiKey(entry.apiKeyEnv);
  if (entry.provider === "groq") {
    return { endpoint: "https://api.groq.com/openai/v1/chat/completions", apiKey, modelId: entry.id };
  }
  return { endpoint: "https://openrouter.ai/api/v1/chat/completions", apiKey, modelId: entry.id };
}

async function callExtractorModel(
  systemPrompt: string,
  userContent: string,
  maxTokens = 1500,
): Promise<{ parsed: any; model_used: string; fallback_used: boolean; latency_ms: number }> {
  const t0 = Date.now();
  let modelUsed = SPECIALIST_MODEL_CHAIN[0].id;
  let fallbackUsed = false;

  for (let i = 0; i < SPECIALIST_MODEL_CHAIN.length; i++) {
    const entry = SPECIALIST_MODEL_CHAIN[i];
    const { endpoint, apiKey, modelId } = getProviderConfig(entry);

    if (!apiKey) {
      if (i < SPECIALIST_MODEL_CHAIN.length - 1) { fallbackUsed = true; continue; }
      throw new Error(`API key env var '${entry.apiKeyEnv}' not set (also tried OpenRouter key fallback)`);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (entry.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://openclaw-api-k30t.onrender.com";
      headers["X-Title"] = "OpenClaw Contract Extractor";
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
        if (i < SPECIALIST_MODEL_CHAIN.length - 1) { fallbackUsed = true; continue; }
        throw new Error("All models/keys rate-limited (429)");
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${entry.provider} ${response.status} on ${modelId}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as any;
      const raw  = data.choices?.[0]?.message?.content ?? "";
      modelUsed  = entry.id;

      const match = raw.match(/\{[\s\S]*\}/);
      let parsed: any = null;
      if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }

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
        if (parsed === null && i < SPECIALIST_MODEL_CHAIN.length - 1) { fallbackUsed = true; continue; }
      }

      return { parsed, model_used: modelUsed, fallback_used: fallbackUsed, latency_ms: Date.now() - t0 };
    } catch (err: any) {
      if (i === SPECIALIST_MODEL_CHAIN.length - 1) throw err;
      fallbackUsed = true;
    }
  }
  throw new Error("All models failed");
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(doc_class: DocClass): string {
  const docLabel: Record<DocClass, string> = {
    co_founder_agreement:       "Co-Founder Agreement",
    contractor_ip_assignment:   "Contractor IP Assignment Agreement",
    advisor_agreement:          "Advisor Agreement",
  };

  return `You are a legal contract analyst specializing in startup agreements.

Your task: extract structured fields from the provided ${docLabel[doc_class]} contract text.

Return a single JSON object with exactly these top-level keys:
{
  "intake": {
    "doc_class": "${doc_class}",
    "jurisdiction": "<string — e.g. 'Delaware, USA'>",
    "parties": [{ "name": "<string>", "role": "<string>", "entity_type": "<string or null>" }],
    "effective_date": "<ISO date string or null>",
    "equity": {
      "split": { "<party_name>": <percentage_as_number_0_to_100> },
      "vesting_years": <number or null>,
      "cliff_months": <number or null>,
      "acceleration": "single" | "double" | "none" | null
    },
    "ip": {
      "prior_inventions": ["<string>"],
      "scope": "broad" | "work_product_only" | null
    },
    "advisory": {
      "equity_pct": <number or null>,
      "services_description": "<string or null>",
      "cash_fee": <number or null>
    }
  },
  "uncertain_fields": [
    {
      "field": "<dot-path e.g. equity.vesting_years>",
      "extracted_value": <value or null>,
      "confidence": <0.0–1.0>,
      "reason": "<one sentence explaining why uncertain>"
    }
  ],
  "unextractable_fields": ["<dot-path>"],
  "extraction_confidence": <0.0–1.0>
}

Rules:
- Include only fields relevant to ${docLabel[doc_class]}. Omit irrelevant top-level keys (e.g. omit "advisory" for co_founder_agreement unless present).
- "uncertain_fields": list any field you extracted but are not confident about (confidence < 0.8). Do NOT include fields in both "intake" and "uncertain_fields" — include them in intake AND list them in uncertain_fields with their confidence.
- "unextractable_fields": list dot-paths for fields that are simply not present in the text.
- "extraction_confidence": overall confidence across all extracted fields (0.0 = nothing extracted, 1.0 = all fields extracted with high confidence).
- Respond with valid JSON only. No prose, no markdown fences, no explanation outside the JSON.`;
}

// ── Safe defaults for uncertain fields ───────────────────────────────────────

const SAFE_DEFAULTS: Record<string, unknown> = {
  "equity.vesting_years":  4,
  "equity.cliff_months":   12,
  "equity.acceleration":   "none",
  "ip.scope":              "broad",
  "jurisdiction":          "Delaware, USA",
};

function applyDotPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function buildDraftReadyIntake(intake: DraftIntake, uncertainFields: UncertainField[]): DraftIntake {
  // Deep clone
  const ready: DraftIntake = JSON.parse(JSON.stringify(intake));

  for (const uf of uncertainFields) {
    if (uf.confidence < 0.6) {
      const safeDefault = SAFE_DEFAULTS[uf.field];
      if (safeDefault !== undefined) {
        applyDotPath(ready, uf.field, safeDefault);
      }
    }
  }

  return ready;
}

// ── Fallback empty intake ─────────────────────────────────────────────────────

function emptyIntake(doc_class: DocClass): DraftIntake {
  return {
    doc_class,
    jurisdiction: "Delaware, USA",
    parties: [],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function extractIntakeFromText(
  text: string,
  doc_class: DocClass,
): Promise<ExtractResult> {
  const systemPrompt = buildSystemPrompt(doc_class);
  const userContent  = `Contract text:\n"""\n${text}\n"""`;

  let parsed: any = null;
  let model_used   = SPECIALIST_MODEL_CHAIN[0].id;
  let fallback_used = false;
  let latency_ms   = 0;

  try {
    const result = await callExtractorModel(systemPrompt, userContent, 1500);
    parsed       = result.parsed;
    model_used   = result.model_used;
    fallback_used = result.fallback_used;
    latency_ms   = result.latency_ms;
  } catch {
    // All models failed — return empty extraction
    const empty = emptyIntake(doc_class);
    return {
      intake:                empty,
      draft_ready_intake:    empty,
      uncertain_fields:      [],
      unextractable_fields:  ["jurisdiction", "parties", "equity", "ip"],
      extraction_confidence: 0,
      model_used,
      fallback_used,
      latency_ms,
    };
  }

  // Parse failed after all retries
  if (parsed === null) {
    const empty = emptyIntake(doc_class);
    return {
      intake:                empty,
      draft_ready_intake:    empty,
      uncertain_fields:      [],
      unextractable_fields:  ["jurisdiction", "parties", "equity", "ip"],
      extraction_confidence: 0,
      model_used,
      fallback_used,
      latency_ms,
    };
  }

  // Coerce and validate parsed output
  const rawIntake: DraftIntake = {
    doc_class,
    jurisdiction: typeof parsed.intake?.jurisdiction === "string"
      ? parsed.intake.jurisdiction
      : "Delaware, USA",
    parties: Array.isArray(parsed.intake?.parties)
      ? parsed.intake.parties.filter(
          (p: any) => typeof p?.name === "string" && typeof p?.role === "string"
        )
      : [],
    effective_date: typeof parsed.intake?.effective_date === "string"
      ? parsed.intake.effective_date
      : undefined,
    equity: parsed.intake?.equity != null ? {
      split:         parsed.intake.equity.split ?? undefined,
      vesting_years: typeof parsed.intake.equity.vesting_years === "number"
        ? parsed.intake.equity.vesting_years : undefined,
      cliff_months:  typeof parsed.intake.equity.cliff_months === "number"
        ? parsed.intake.equity.cliff_months : undefined,
      acceleration:  ["single", "double", "none"].includes(parsed.intake.equity.acceleration)
        ? parsed.intake.equity.acceleration : undefined,
    } : undefined,
    ip: parsed.intake?.ip != null ? {
      prior_inventions: Array.isArray(parsed.intake.ip.prior_inventions)
        ? parsed.intake.ip.prior_inventions.filter((s: any) => typeof s === "string")
        : undefined,
      scope: ["broad", "work_product_only"].includes(parsed.intake.ip.scope)
        ? parsed.intake.ip.scope : undefined,
    } : undefined,
    advisory: parsed.intake?.advisory != null ? {
      equity_pct:           typeof parsed.intake.advisory.equity_pct === "number"
        ? parsed.intake.advisory.equity_pct : undefined,
      services_description: typeof parsed.intake.advisory.services_description === "string"
        ? parsed.intake.advisory.services_description : undefined,
      cash_fee:             typeof parsed.intake.advisory.cash_fee === "number"
        ? parsed.intake.advisory.cash_fee : undefined,
    } : undefined,
  };

  const uncertainFields: UncertainField[] = Array.isArray(parsed.uncertain_fields)
    ? parsed.uncertain_fields.filter(
        (uf: any) =>
          typeof uf?.field === "string" &&
          typeof uf?.confidence === "number" &&
          typeof uf?.reason === "string"
      ).map((uf: any) => ({
        field:            uf.field,
        extracted_value:  uf.extracted_value ?? null,
        confidence:       Math.min(1, Math.max(0, uf.confidence)),
        reason:           uf.reason,
      }))
    : [];

  const unextractableFields: string[] = Array.isArray(parsed.unextractable_fields)
    ? parsed.unextractable_fields.filter((f: any) => typeof f === "string")
    : [];

  const extractionConfidence: number =
    typeof parsed.extraction_confidence === "number"
      ? Math.min(1, Math.max(0, parsed.extraction_confidence))
      : 0.5;

  const draftReadyIntake = buildDraftReadyIntake(rawIntake, uncertainFields);

  return {
    intake:                rawIntake,
    draft_ready_intake:    draftReadyIntake,
    uncertain_fields:      uncertainFields,
    unextractable_fields:  unextractableFields,
    extraction_confidence: extractionConfidence,
    model_used,
    fallback_used,
    latency_ms,
  };
}
