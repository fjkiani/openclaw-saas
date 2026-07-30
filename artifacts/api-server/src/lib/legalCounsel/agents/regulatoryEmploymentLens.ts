/**
 * regulatoryEmploymentLens.ts — Contractor vs employee, noncompete, Mutual Dependency, RUO scope.
 */

import { z } from "zod";
import { invokeWithFallback, RouterExhaustedError, type ModelRouteConfig } from "../../modelRouter.js";
import { logger } from "../../logger.js";
import type { LensInput, LensOutput } from "../types.js";

const GEMINI_OPENAI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const COUNSEL_CHAIN: ModelRouteConfig[] = [
  { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 2048, timeoutMs: 35_000 },
  { id: "openai/gpt-oss-120b", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 2048, timeoutMs: 90_000 },
  { id: "gemini-2.5-flash", provider: "local", apiKeyEnv: "GOOGLE_API_KEY", baseUrl: GEMINI_OPENAI_ENDPOINT, maxTokens: 2048, timeoutMs: 55_000 },
  { id: "gemini-2.5-flash-lite", provider: "local", apiKeyEnv: "GOOGLE_API_KEY", baseUrl: GEMINI_OPENAI_ENDPOINT, maxTokens: 2048, timeoutMs: 55_000 },
];

const SYSTEM_PROMPT = `You are a regulatory and employment specialist reviewing a startup agreement.
Focus ONLY on: contractor vs employee classification, noncompete enforceability, Mutual Dependency clause, RUO/clinical scope, acceleration economics.

GROUNDING RULES:
- findings with chunk_id/slug: ONLY when that slug appears in knowledge_base_chunks.
- findings without corpus match: set is_inferred=true.
- Do NOT invent chunk_ids.

CRITICAL PERSPECTIVE RULE: Mutual Dependency clauses that allow milestones to be "deemed Satisfied" when the Company lacks resources FAVOR THE COUNTERPARTY, not the company. When perspective=company, flag this as counterparty-favorable and recommend pushing back.

Output ONLY valid JSON:
{
  "findings": [{"lens":"regulatory_employment","severity":"critical|high|medium|low|info","issue":"string","chunk_id":123,"slug":"string","corpus_excerpt":"string","contract_excerpt":"string","recommendation":"string","is_inferred":false}],
  "redlines": [{"section":"string","original_excerpt":"string","suggested_text":"string","rationale":"string","favors":"company|balanced|counterparty"}],
  "opportunities": []
}`;

const LensOutputSchema = z.object({
  findings: z.array(z.object({
    lens: z.literal("regulatory_employment"),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    issue: z.string().min(5),
    chunk_id: z.number().int().nullish(),
    slug: z.string().nullish(),
    corpus_excerpt: z.string().nullish(),
    contract_excerpt: z.string().nullish(),
    recommendation: z.string().min(5).nullable().or(z.literal("").transform(() => "See recommendation above")),
    is_inferred: z.boolean().nullish(),
    inferred_reason: z.string().nullish(),
  })).default([]),
  redlines: z.array(z.object({
    section: z.string(),
    original_excerpt: z.string().nullish(),
    suggested_text: z.string(),
    rationale: z.string(),
    favors: z.enum(["company", "balanced", "counterparty"]),
  })).default([]),
  opportunities: z.array(z.any()).default([]),
});

export async function runRegulatoryEmploymentLens(input: LensInput): Promise<LensOutput> {
  const t0 = Date.now();
  const { signals, ragHits, digest, perspective } = input;

  const regHits = ragHits.filter(h =>
    /noncompete|employment|regulatory|ruo|classification|mutual.depend/i.test(h.slug + h.title)
  );

  const userContent = JSON.stringify({
    perspective,
    knowledge_base_chunks: regHits.map(h => ({
      chunk_id: h.chunk_id,
      slug: h.slug,
      title: h.title,
      excerpt: h.content.slice(0, 500),
    })),
    contract_digest: digest.slice(0, 8000),
    signals: {
      has_mutual_dependency: signals.has_mutual_dependency,
      has_employee_classification: signals.has_employee_classification,
      has_ruo: signals.has_ruo,
      has_acceleration: signals.has_acceleration,
    },
    instruction: "Identify regulatory and employment issues. Mutual Dependency that lets milestones be deemed satisfied when Company lacks resources is COUNTERPARTY-FAVORABLE — flag it as such when perspective=company. Check contractor vs employee classification risk.",
  });

  try {
    const result = await invokeWithFallback<z.infer<typeof LensOutputSchema>>(
      { systemPrompt: SYSTEM_PROMPT, userContent, title: "Regulatory/Employment Lens", maxTokens: 2048, temperature: 0.1 },
      COUNSEL_CHAIN,
      { validator: (raw) => LensOutputSchema.parse(raw), routeChainId: "regulatory-employment-lens-v1", schemaType: "seo" },
    );
    return {
      lens: "regulatory_employment",
      findings: result.parsed.findings,
      redlines: result.parsed.redlines,
      opportunities: result.parsed.opportunities,
      model_used: result.model_used,
      latency_ms: Date.now() - t0,
    };
  } catch (err: unknown) {
    const attempts = err instanceof RouterExhaustedError ? err.attempt_log : [];
    logger.error(
      { lens: "regulatory_employment", err: err instanceof Error ? err.message : String(err), attempts },
      "regulatoryEmploymentLens: all models exhausted",
    );
    return { lens: "regulatory_employment", findings: [], redlines: [], opportunities: [], model_used: "failed", latency_ms: Date.now() - t0 };
  }
}
