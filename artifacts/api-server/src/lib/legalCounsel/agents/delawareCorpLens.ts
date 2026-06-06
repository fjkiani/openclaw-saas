/**
 * delawareCorpLens.ts — DGCL §144, protective provisions, board consent, drag-along, ROFR.
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

const SYSTEM_PROMPT = `You are a Delaware corporate law specialist reviewing a startup agreement.
Focus ONLY on: DGCL §144 interested-director safe harbor, protective provisions, board consent requirements, drag-along, ROFR, co-sale rights, NVCA standard terms.

GROUNDING RULES:
- findings with chunk_id/slug: ONLY when that slug appears in knowledge_base_chunks.
- findings without corpus match: set is_inferred=true.
- Do NOT invent chunk_ids.

Output ONLY valid JSON:
{
  "findings": [{"lens":"delaware_corp","severity":"critical|high|medium|low|info","issue":"string","chunk_id":123,"slug":"dgcl-144","corpus_excerpt":"string","contract_excerpt":"string","recommendation":"string","is_inferred":false}],
  "redlines": [{"section":"string","original_excerpt":"string","suggested_text":"string","rationale":"string","favors":"company|balanced|counterparty"}],
  "opportunities": []
}`;

const LensOutputSchema = z.object({
  findings: z.array(z.object({
    lens: z.literal("delaware_corp"),
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

export async function runDelawareCorpLens(input: LensInput): Promise<LensOutput> {
  const t0 = Date.now();
  const { ragHits, digest, perspective } = input;

  const corpHits = ragHits.filter(h =>
    /dgcl|delaware|nvca|protective|rofr|drag|co-sale|board/i.test(h.slug + h.title)
  );

  const userContent = JSON.stringify({
    perspective,
    knowledge_base_chunks: corpHits.map(h => ({
      chunk_id: h.chunk_id,
      slug: h.slug,
      title: h.title,
      excerpt: h.content.slice(0, 500),
    })),
    contract_digest: digest.slice(0, 8000),
    instruction: "Identify Delaware corporate law issues. Ground to corpus when available. Flag DGCL §144 safe harbor, protective provisions, board consent, drag-along, ROFR.",
  });

  try {
    const result = await invokeWithFallback<z.infer<typeof LensOutputSchema>>(
      { systemPrompt: SYSTEM_PROMPT, userContent, title: "Delaware Corp Lens", maxTokens: 2048, temperature: 0.1 },
      COUNSEL_CHAIN,
      { validator: (raw) => LensOutputSchema.parse(raw), routeChainId: "delaware-corp-lens-v1", schemaType: "seo" },
    );
    return {
      lens: "delaware_corp",
      findings: result.parsed.findings,
      redlines: result.parsed.redlines,
      opportunities: result.parsed.opportunities,
      model_used: result.model_used,
      latency_ms: Date.now() - t0,
    };
  } catch {
    return { lens: "delaware_corp", findings: [], redlines: [], opportunities: [], model_used: "failed", latency_ms: Date.now() - t0 };
  }
}
