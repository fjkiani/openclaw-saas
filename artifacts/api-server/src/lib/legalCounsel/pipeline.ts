/**
 * legalCounsel/pipeline.ts
 *
 * Multi-lens contract counsel: hybrid RAG + structured reasoning.
 * Inspired by contract-analyzer / Policy-Compliance patterns — in-repo, no Python Agent B.
 *
 * Lenses:
 *   1. enforceability — Delaware enforceability, arbitration, restrictive covenants
 *   2. tax_and_securities — QSBS §1202 (post-OBBBA $75M), 83(b), DGCL §144
 *   3. regulatory — RUO/FDA, clinical AI, CMO liability
 *   4. company_exposure — loopholes, one-sided terms, missing company protections
 */

import { z } from "zod";
import { invokeWithFallback, type ModelRouteConfig } from "../modelRouter.js";
import { legalCorpusHybridRetrieve } from "../legalCorpus/hybridRetrieve.js";
import { chunkContractSections } from "./chunkContract.js";
import { LEGAL_CORPUS_VERSION } from "../legalCorpus/documents.js";
import { logger } from "../logger.js";

const COUNSEL_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 4096,
    timeoutMs: 55_000,
    tags: ["70b", "counsel-primary"],
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 4096,
    timeoutMs: 55_000,
    tags: ["70b", "counsel-or-k1"],
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY_2",
    maxTokens: 4096,
    timeoutMs: 55_000,
    tags: ["70b", "counsel-or-k2"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 4096,
    timeoutMs: 90_000,
    tags: ["120b", "counsel-fallback"],
  },
  {
    id: "openai/gpt-oss-20b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY_2",
    maxTokens: 4096,
    timeoutMs: 55_000,
    tags: ["20b", "counsel-last-resort"],
  },
];

const LensFindingSchema = z.object({
  lens: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  issue: z.string().min(5),
  contract_excerpt: z.string().optional(),
  statutory_basis: z.string().optional(),
  corpus_slugs: z.array(z.string()).optional(),
  recommendation: z.string().min(5),
});

const OpportunitySchema = z.object({
  type: z.enum([
    "tax_optimization",
    "loophole_for_company",
    "missing_protective_clause",
    "negotiation_leverage",
    "compliance_fix",
  ]),
  title: z.string(),
  description: z.string(),
  suggested_language: z.string().optional(),
  corpus_slugs: z.array(z.string()).optional(),
});

const RedlineSchema = z.object({
  section: z.string(),
  original_excerpt: z.string(),
  suggested_text: z.string(),
  rationale: z.string(),
  favors: z.enum(["company", "balanced", "counterparty"]),
});

export const CounselOutputSchema = z.object({
  doc_class: z.enum(["cofounder_agreement", "contract", "employment", "other"]),
  overall_risk: z.enum(["critical", "high", "medium", "low"]),
  executive_summary: z.string().min(20),
  lens_findings: z.array(LensFindingSchema).min(1),
  opportunities_for_company: z.array(OpportunitySchema),
  redlines: z.array(RedlineSchema),
  blocking_issues: z.array(z.string()),
  missing_clauses: z.array(z.string()),
  next_steps: z.array(z.string()).min(1),
  reasoning_notes: z.string().optional(),
});

export type CounselOutput = z.infer<typeof CounselOutputSchema>;

export interface CounselAnalyzeInput {
  text: string;
  perspective?: "company" | "counterparty" | "neutral";
  docHint?: string;
}

export interface CounselAnalyzeResult {
  output: CounselOutput;
  rag_sources: string[];
  rag_corpus_version: string;
  retrieval_mode: string;
  section_count: number;
  model_used: string;
  latency_ms: number;
}

const SYSTEM_PROMPT = `You are senior Delaware startup counsel analyzing a contract for your client (the COMPANY side unless stated otherwise).

You MUST reason from the KNOWLEDGE BASE provided — cite corpus slug IDs in corpus_slugs when applying a rule.
You MUST go BEYOND checklist items: find tax opportunities, regulatory gaps, asymmetric terms, loopholes, and missing clauses not in any checklist.

Statutory anchors you must apply correctly:
- QSBS IRC §1202: post-OBBBA $75M gross asset ceiling (NOT obsolete $50M)
- DGCL §144: restricted stock / affiliate resale safe harbor for Delaware issuers
- IRC §83(b): 30-day non-waivable election window for restricted stock
- RUO vs clinical use for AI/oncology products with a CMO co-founder

Output ONLY valid JSON matching the schema. No markdown outside JSON.
Be specific: quote contract excerpts, name sections, propose actual clause language in redlines.
For opportunities_for_company and redlines where favors=company, optimize for the Company's protection while staying enforceable under Delaware law.`;

export async function runLegalCounselAnalyze(
  input: CounselAnalyzeInput,
): Promise<CounselAnalyzeResult> {
  const t0 = Date.now();
  const { text, perspective = "company", docHint } = input;

  const sections = chunkContractSections(text);
  const queryParts = sections.slice(0, 6).map((s) => `${s.heading}: ${s.text.slice(0, 400)}`);
  const retrievalQuery = [docHint, ...queryParts, text.slice(0, 1500)].filter(Boolean).join("\n");

  const rag = await legalCorpusHybridRetrieve({
    query: retrievalQuery,
    domains: ["cofounder", "tax", "delaware", "regulatory", "contract"],
    topK: 12,
    maxChars: 9000,
    forceCofounderCritical: /co-founder|cofounder|cmo|restricted stock/i.test(text),
  });

  const sectionDigest = sections
    .slice(0, 12)
    .map((s) => `### ${s.heading}\n${s.text.slice(0, 1200)}`)
    .join("\n\n");

  const userContent = JSON.stringify({
    perspective,
    doc_hint: docHint ?? null,
    knowledge_base: rag.context_block,
    contract_sections: sectionDigest,
    full_text_length: text.length,
    instruction:
      "Analyze all lenses. Find issues AND company-favorable opportunities (tax, protective clauses, closing loopholes). Return complete JSON.",
  });

  const result = await invokeWithFallback<CounselOutput>(
    {
      systemPrompt: SYSTEM_PROMPT,
      userContent,
      title: "OpenClaw Legal Counsel Multi-Lens",
      maxTokens: 8192,
      temperature: 0.15,
    },
    COUNSEL_CHAIN,
    {
      validator: (raw) => CounselOutputSchema.parse(raw),
      routeChainId: "legal-counsel-v1",
      schemaType: "premium",
    },
  );

  const slugs = [...new Set(rag.hits.map((h) => h.slug))];

  logger.info(
    {
      overall_risk: result.parsed.overall_risk,
      findings: result.parsed.lens_findings.length,
      retrieval_mode: rag.retrieval_mode,
      model: result.model_used,
    },
    "legalCounsel: analysis complete",
  );

  return {
    output: result.parsed,
    rag_sources: slugs,
    rag_corpus_version: LEGAL_CORPUS_VERSION,
    retrieval_mode: rag.retrieval_mode,
    section_count: sections.length,
    model_used: result.model_used,
    latency_ms: Date.now() - t0,
  };
}
