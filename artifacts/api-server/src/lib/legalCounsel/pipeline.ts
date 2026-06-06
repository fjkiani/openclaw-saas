/**
 * legalCounsel/pipeline.ts — Phase 3: full-doc coverage, version diff, grounded/inferred split.
 */

import { z } from "zod";
import { invokeWithFallback, type ModelRouteConfig } from "../modelRouter.js";
import { legalCorpusStatus } from "../legalCorpus/retrieve.js";
import { LEGAL_CORPUS_VERSION } from "../legalCorpus/documents.js";
import { logger } from "../logger.js";
import { chunkContractSections } from "./chunkContract.js";
import { splitContractVersions } from "./splitVersions.js";
import { diffContractVersions, buildVersionRedlines, type VersionDiffItem } from "./diffVersions.js";
import { buildFullContractDigest, buildMultiRetrievalQueries } from "./buildDigest.js";
import { mergedHybridRetrieve } from "./multiRetrieve.js";
import { partitionAndValidateFindings, type GroundedFinding, type InferredFinding } from "./grounding.js";
import { counselGovernanceBlock } from "./disclaimer.js";

const COUNSEL_CHAIN: ModelRouteConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 4096,
    timeoutMs: 35_000,
    tags: ["70b", "counsel-groq"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 4096,
    timeoutMs: 90_000,
    tags: ["120b", "counsel-primary-or"],
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
    id: "openai/gpt-oss-20b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY_2",
    maxTokens: 4096,
    timeoutMs: 55_000,
    tags: ["20b", "counsel-last-resort"],
  },
];

const GroundedFindingSchema = z.object({
  lens: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  issue: z.string().min(5),
  chunk_id: z.number().int().optional(),
  slug: z.string().optional(),
  corpus_excerpt: z.string().optional(),
  contract_excerpt: z.string().optional(),
  recommendation: z.string().min(5),
});

const InferredFindingSchema = z.object({
  lens: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  issue: z.string().min(5),
  reason: z.string().min(5),
});

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
  findings_grounded: z.array(GroundedFindingSchema).default([]),
  findings_inferred: z.array(InferredFindingSchema).default([]),
  lens_findings: z.array(LensFindingSchema).default([]),
  opportunities_for_company: z.array(OpportunitySchema).default([]),
  redlines: z.array(RedlineSchema).default([]),
  blocking_issues: z.array(z.string()).default([]),
  missing_clauses: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).min(1),
  reasoning_notes: z.string().optional(),
});

export type CounselOutput = z.infer<typeof CounselOutputSchema>;

export interface CounselAnalyzeInput {
  text: string;
  perspective?: "company" | "counterparty" | "neutral";
  docHint?: string;
  /** Analyze only this version index when multiple versions detected (0-based). */
  versionIndex?: number;
}

export interface VersionAnalysisMeta {
  versions_detected: number;
  version_labels: string[];
  diff_items: VersionDiffItem[];
  version_redlines: ReturnType<typeof buildVersionRedlines>;
}

export interface CounselAnalyzeResult {
  output: CounselOutput & {
    findings_grounded: GroundedFinding[];
    findings_inferred: InferredFinding[];
    governance: ReturnType<typeof counselGovernanceBlock>;
    coverage: {
      sections_total: number;
      sections_included: number;
      chars_sent: number;
      full_text_length: number;
      coverage_pct: number;
    };
    version_analysis?: VersionAnalysisMeta;
  };
  rag_sources: string[];
  rag_corpus_version: string;
  retrieval_mode: string;
  section_count: number;
  model_used: string;
  latency_ms: number;
  meta: {
    chunks_retrieved: number;
    corpus_chunks_total: number;
    retrieval_mode: string;
    force_critical_used: boolean;
    queries_run: number;
    multi_version: boolean;
  };
}

const SYSTEM_PROMPT = `You are senior Delaware startup counsel analyzing a contract for your client (the COMPANY side unless stated otherwise).

IMPORTANT: Output is decision-support only — not legal advice.

GROUNDING RULES (strict):
- findings_grounded: ONLY issues directly supported by a chunk in knowledge_base. Each entry MUST include chunk_id and slug copied from a knowledge_base chunk header like [slug-id].
- findings_inferred: issues from contract text or general legal reasoning WITHOUT a matching corpus chunk. Include reason explaining no corpus match.
- Do NOT duplicate the same issue in both arrays.
- lens_findings: optional legacy summary entries; prefer findings_grounded / findings_inferred.

Statutory anchors:
- QSBS IRC §1202: post-OBBBA $75M gross asset ceiling (NOT $50M)
- DGCL §144: restricted stock / affiliate resale safe harbor
- IRC §83(b): 30-day non-waivable election window
- RUO vs clinical use for AI/oncology products with a CMO co-founder

Output ONLY valid JSON (no markdown):
{
  "doc_class": "cofounder_agreement|contract|employment|other",
  "overall_risk": "critical|high|medium|low",
  "executive_summary": "string",
  "findings_grounded": [{"lens":"string","severity":"critical|high|medium|low|info","issue":"string","chunk_id":123,"slug":"irc-83b","corpus_excerpt":"string","contract_excerpt":"string","recommendation":"string"}],
  "findings_inferred": [{"lens":"string","severity":"critical|high|medium|low|info","issue":"string","reason":"string"}],
  "lens_findings": [],
  "opportunities_for_company": [{"type":"tax_optimization|...","title":"string","description":"string","suggested_language":"string","corpus_slugs":["slug"]}],
  "redlines": [{"section":"string","original_excerpt":"string","suggested_text":"string","rationale":"string","favors":"company|balanced|counterparty"}],
  "blocking_issues": ["string"],
  "missing_clauses": ["string"],
  "next_steps": ["string"],
  "reasoning_notes": "string"
}`;

export async function runLegalCounselAnalyze(
  input: CounselAnalyzeInput,
): Promise<CounselAnalyzeResult> {
  const t0 = Date.now();
  const { text, perspective = "company", docHint, versionIndex } = input;

  const { versions, single } = splitContractVersions(text);
  let versionAnalysis: VersionAnalysisMeta | undefined;

  if (!single && versions.length >= 2) {
    versionAnalysis = {
      versions_detected: versions.length,
      version_labels: versions.map((v) => v.label),
      diff_items: diffContractVersions(versions[0], versions[1]),
      version_redlines: buildVersionRedlines(diffContractVersions(versions[0], versions[1])),
    };
  }

  const analyzeText =
    versionIndex != null && versions[versionIndex]
      ? versions[versionIndex].text
      : single
        ? text
        : versions[versions.length - 1]!.text;

  const sections = chunkContractSections(analyzeText);
  const digest = buildFullContractDigest(sections, { maxTotalChars: 28_000 });

  const retrievalQueries = buildMultiRetrievalQueries(sections, docHint, 1500, analyzeText);
  const isCofounder = /co-founder|cofounder|cmo|restricted stock/i.test(analyzeText);

  const rag = await mergedHybridRetrieve({
    queries: retrievalQueries,
    domains: ["cofounder", "tax", "delaware", "regulatory", "contract"],
    topK: 12,
    maxChars: 8000,
    forceCofounderCritical: isCofounder,
  });

  let corpusChunksTotal = 0;
  try {
    const status = await legalCorpusStatus();
    corpusChunksTotal = status.chunks;
  } catch {
    corpusChunksTotal = 0;
  }

  const userContent = JSON.stringify({
    perspective,
    doc_hint: docHint ?? null,
    knowledge_base: rag.context_block,
    knowledge_base_chunks: rag.hits.map((h) => ({
      chunk_id: h.chunk_id,
      slug: h.slug,
      title: h.title,
      excerpt: h.content.slice(0, 400),
    })),
    contract_sections: digest.digest,
    coverage: {
      sections_total: digest.sections_total,
      sections_included: digest.sections_included,
      coverage_pct: digest.coverage_pct,
      full_text_length: analyzeText.length,
    },
    version_analysis: versionAnalysis
      ? {
          versions: versionAnalysis.version_labels,
          diff_count: versionAnalysis.diff_items.length,
          critical_diffs: versionAnalysis.diff_items.filter((d) => d.significance === "critical"),
          version_redlines: versionAnalysis.version_redlines.slice(0, 12),
        }
      : null,
    instruction:
      "Analyze all lenses. Split findings_grounded vs findings_inferred per grounding rules. " +
      "If version_analysis present, address material diffs in executive_summary and blocking_issues.",
  });

  const result = await invokeWithFallback<CounselOutput>(
    {
      systemPrompt: SYSTEM_PROMPT,
      userContent,
      title: "OpenClaw Legal Counsel Multi-Lens",
      maxTokens: 4096,
      temperature: 0.1,
    },
    COUNSEL_CHAIN,
    {
      validator: (raw) => CounselOutputSchema.parse(raw),
      routeChainId: "legal-counsel-v2",
      schemaType: "seo",
    },
  );

  const partitioned = partitionAndValidateFindings(result.parsed, rag.hits);
  const slugs = [...new Set(rag.hits.map((h) => h.slug))];

  const output = {
    ...result.parsed,
    findings_grounded: partitioned.findings_grounded,
    findings_inferred: partitioned.findings_inferred,
    lens_findings: result.parsed.lens_findings?.length
      ? result.parsed.lens_findings
      : [
          ...partitioned.findings_grounded.map((g) => ({
            lens: g.lens,
            severity: g.severity as "critical" | "high" | "medium" | "low" | "info",
            issue: g.issue,
            contract_excerpt: g.contract_excerpt,
            corpus_slugs: [g.slug],
            recommendation: g.recommendation,
          })),
          ...partitioned.findings_inferred.map((inf) => ({
            lens: inf.lens,
            severity: (inf.severity ?? "medium") as "critical" | "high" | "medium" | "low" | "info",
            issue: inf.issue,
            recommendation: inf.reason,
          })),
        ],
    governance: counselGovernanceBlock(),
    coverage: {
      sections_total: digest.sections_total,
      sections_included: digest.sections_included,
      chars_sent: digest.chars_sent,
      full_text_length: analyzeText.length,
      coverage_pct: digest.coverage_pct,
    },
    version_analysis: versionAnalysis,
  };

  logger.info(
    {
      overall_risk: output.overall_risk,
      grounded: output.findings_grounded.length,
      inferred: output.findings_inferred.length,
      version_diffs: versionAnalysis?.diff_items.length ?? 0,
      coverage_pct: digest.coverage_pct,
      retrieval_mode: rag.retrieval_mode,
      model: result.model_used,
    },
    "legalCounsel: analysis complete",
  );

  return {
    output,
    rag_sources: slugs,
    rag_corpus_version: LEGAL_CORPUS_VERSION,
    retrieval_mode: rag.retrieval_mode,
    section_count: sections.length,
    model_used: result.model_used,
    latency_ms: Date.now() - t0,
    meta: {
      chunks_retrieved: rag.hits.length,
      corpus_chunks_total: corpusChunksTotal,
      retrieval_mode: rag.retrieval_mode,
      force_critical_used: isCofounder,
      queries_run: rag.queries_run,
      multi_version: !single,
    },
  };
}

/** Version diff only (no LLM) — fast structural redline between two texts. */
export function runLegalCounselDiff(
  versionA: string,
  versionB: string,
  labels?: { a?: string; b?: string },
) {
  const diffs = diffContractVersions(
    { label: labels?.a ?? "Version A", text: versionA },
    { label: labels?.b ?? "Version B", text: versionB },
  );
  return {
    ok: true as const,
    governance: counselGovernanceBlock(),
    diff_items: diffs,
    version_redlines: buildVersionRedlines(diffs),
    summary: {
      total: diffs.length,
      critical: diffs.filter((d) => d.significance === "critical").length,
      material: diffs.filter((d) => d.significance === "material").length,
    },
  };
}
