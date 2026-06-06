/**
 * taxSecuritiesLens.ts — IRC 83(b), 409A, 1202 QSBS, Section 16 lens.
 *
 * Focuses on: 83(b) filing window, FMV at grant, QSBS ceiling, blank Schedule C tax angle.
 * Uses shared RAG hits — no duplicate retrieval.
 */

import { z } from "zod";
import { invokeWithFallback, type ModelRouteConfig } from "../../modelRouter.js";
import type { LensInput, LensOutput } from "../types.js";

const COUNSEL_CHAIN: ModelRouteConfig[] = [
  { id: "llama-3.3-70b-versatile", provider: "groq", apiKeyEnv: "GROQ_API_KEY", maxTokens: 2048, timeoutMs: 35_000 },
  { id: "openai/gpt-oss-120b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 2048, timeoutMs: 90_000 },
  { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2", maxTokens: 2048, timeoutMs: 55_000 },
  { id: "openai/gpt-oss-20b:free", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY_2", maxTokens: 2048, timeoutMs: 55_000 },
];

const SYSTEM_PROMPT = `You are a tax and securities specialist reviewing a startup agreement.
Focus ONLY on: IRC §83(b) election, IRC §409A FMV, IRC §1202 QSBS, Section 16 reporting, RSPA mechanics.

GROUNDING RULES:
- findings with chunk_id/slug: ONLY when that slug appears in knowledge_base_chunks.
- findings without corpus match: set is_inferred=true, inferred_reason="model inference".
- Do NOT invent chunk_ids.

Output ONLY valid JSON:
{
  "findings": [
    {
      "lens": "tax_securities",
      "severity": "critical|high|medium|low|info",
      "issue": "string",
      "chunk_id": 123,
      "slug": "irc-83b",
      "corpus_excerpt": "string",
      "contract_excerpt": "string",
      "recommendation": "string",
      "is_inferred": false
    }
  ],
  "redlines": [
    {
      "section": "string",
      "original_excerpt": "string",
      "suggested_text": "string",
      "rationale": "string",
      "favors": "company|balanced|counterparty"
    }
  ],
  "opportunities": []
}`;

const LensOutputSchema = z.object({
  findings: z.array(z.object({
    lens: z.literal("tax_securities"),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    issue: z.string().min(5),
    chunk_id: z.number().int().optional(),
    slug: z.string().optional(),
    corpus_excerpt: z.string().optional(),
    contract_excerpt: z.string().optional(),
    recommendation: z.string().min(5),
    is_inferred: z.boolean().optional(),
    inferred_reason: z.string().optional(),
  })).default([]),
  redlines: z.array(z.object({
    section: z.string(),
    original_excerpt: z.string(),
    suggested_text: z.string(),
    rationale: z.string(),
    favors: z.enum(["company", "balanced", "counterparty"]),
  })).default([]),
  opportunities: z.array(z.any()).default([]),
});

export async function runTaxSecuritiesLens(input: LensInput): Promise<LensOutput> {
  const t0 = Date.now();
  const { signals, ragHits, digest, perspective } = input;

  // Only run if tax signals present
  const hasTaxSignal = signals.has_83b || signals.has_restricted_stock;
  if (!hasTaxSignal) {
    return { lens: "tax_securities", findings: [], redlines: [], opportunities: [], model_used: "skipped", latency_ms: 0 };
  }

  const taxHits = ragHits.filter(h =>
    /irc-83b|irc-409a|irc-1202|qsbs|section-83|tax/i.test(h.slug + h.title)
  );

  const userContent = JSON.stringify({
    perspective,
    knowledge_base_chunks: taxHits.map(h => ({
      chunk_id: h.chunk_id,
      slug: h.slug,
      title: h.title,
      excerpt: h.content.slice(0, 500),
    })),
    contract_digest: digest.slice(0, 8000),
    signals: {
      has_83b: signals.has_83b,
      has_restricted_stock: signals.has_restricted_stock,
    },
    instruction: "Identify all tax and securities issues. Ground findings to corpus chunks when available. Flag 83(b) window, 409A FMV, QSBS ceiling, RSPA mechanics.",
  });

  try {
    const result = await invokeWithFallback<z.infer<typeof LensOutputSchema>>(
      { systemPrompt: SYSTEM_PROMPT, userContent, title: "Tax/Securities Lens", maxTokens: 2048, temperature: 0.1 },
      COUNSEL_CHAIN,
      { validator: (raw) => LensOutputSchema.parse(raw), routeChainId: "tax-securities-lens-v1", schemaType: "seo" },
    );
    return {
      lens: "tax_securities",
      findings: result.parsed.findings,
      redlines: result.parsed.redlines,
      opportunities: result.parsed.opportunities,
      model_used: result.model_used,
      latency_ms: Date.now() - t0,
    };
  } catch {
    return { lens: "tax_securities", findings: [], redlines: [], opportunities: [], model_used: "failed", latency_ms: Date.now() - t0 };
  }
}
