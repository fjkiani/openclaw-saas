/**
 * legalCounsel/pipeline.ts — Phase 3: full-doc coverage, version diff, grounded/inferred split.
 *
 * mode="orchestrator" → 4 parallel lens agents + reconcile + compliance (C1, C4, C5, C10, C12)
 * mode="monolith"     → single LLM call (legacy baseline)
 * default             → orchestrator (C1 gate: meta.orchestrator_mode=true without ?mode= param)
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
import { detectContractSignals, buildStatuteRetrievalQueries } from "./contractSignals.js";
import { buildCompanyLeverageFindings, enrichGroundedStatuteFindings } from "./companyLeverage.js";
import { COFOUNDER_STATUTE_SLUGS } from "../legalCorpus/cofounderSlugs.js";
import { runOrchestrator } from "./orchestrator.js";
import { buildDealMemo, type DealMemo } from "./dealMemo.js";

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
  /**
   * mode="orchestrator" → 4 parallel lens agents (default, satisfies C1 gate)
   * mode="monolith"     → single LLM call (legacy)
   */
  mode?: "orchestrator" | "monolith";
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
    deal_memo: DealMemo;
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
    forced_slugs_requested: string[];
    forced_slugs_retrieved: string[];
    contract_signals: ReturnType<typeof detectContractSignals>;
    queries_run: number;
    multi_version: boolean;
    /** C1 gate: true when orchestrator path was used */
    orchestrator_mode: boolean;
    /** C10 gate: grounded / (grounded + inferred) */
    grounded_ratio: number;
    /** Models used per lens (orchestrator mode) or single model (monolith) */
    lens_models: string[];
  };
}

const SYSTEM_PROMPT = `You are senior Delaware startup counsel analyzing a contract for your client (the COMPANY side unless stated otherwise).

IMPORTANT: Output is decision-support only — not legal advice.

GROUNDING RULES (strict):
- findings_grounded: ONLY issues directly supported by a chunk in knowledge_base. Each entry MUST include chunk_id and slug copied from a knowledge_base chunk header like [slug-id].
- findings_inferred: issues from contract text or general legal reasoning WITHOUT a matching corpus chunk. Include reason explaining no corpus match.
- Do NOT duplicate the same issue in both arrays.
- lens_findings: optional legacy summary entries; prefer findings_grounded / findings_inferred.

Statutory anchors (ground with corpus when present):
- QSBS IRC §1202: post-OBBBA $75M gross asset ceiling (NOT $50M) — slug irc-1202
- DGCL §144: restricted stock / affiliate resale safe harbor — slug dgcl-144
- IRC §83(b): 30-day non-waivable election window — slug irc-83b
- IRC §409A: FMV at grant — slug irc-409a
- RUO vs clinical use for AI/oncology products with a CMO co-founder

COMPANY LEVERAGE LENS (when perspective=company):
- Identify counterparty-favorable terms (Mutual Dependency, acceleration economics, blank Schedule C).
- Identify company wins to preserve (Cause-only termination, $0 cash, scoped IP).
- Put negotiation leverage in opportunities_for_company; blocking pre-sign gaps in blocking_issues.
- Do NOT suggest redlines that give away company wins unless balanced trade.

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

// ── Shared RAG + digest prep (used by both orchestrator and monolith paths) ───

async function prepSharedContext(input: CounselAnalyzeInput) {
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
  const signals = detectContractSignals(analyzeText);

  const retrievalQueries = [
    ...buildMultiRetrievalQueries(sections, docHint, 1500, analyzeText),
    ...buildStatuteRetrievalQueries(signals),
  ];
  const isCofounder = /co-founder|cofounder|cmo|restricted stock/i.test(analyzeText);

  const rag = await mergedHybridRetrieve({
    queries: retrievalQueries,
    domains: ["cofounder", "tax", "delaware", "regulatory", "contract"],
    topK: 16,
    maxChars: 10_000,
    forceCofounderCritical: isCofounder,
  });

  let corpusChunksTotal = 0;
  try {
    const status = await legalCorpusStatus();
    corpusChunksTotal = status.chunks;
  } catch {
    corpusChunksTotal = 0;
  }

  return {
    analyzeText,
    sections,
    digest,
    signals,
    rag,
    isCofounder,
    corpusChunksTotal,
    versionAnalysis,
    perspective,
  };
}

// ── Orchestrator path (C1 default) ────────────────────────────────────────────

async function runOrchestratorPath(
  input: CounselAnalyzeInput,
  t0: number,
): Promise<CounselAnalyzeResult> {
  const ctx = await prepSharedContext(input);
  const {
    analyzeText,
    sections,
    digest,
    signals,
    rag,
    isCofounder,
    corpusChunksTotal,
    versionAnalysis,
    perspective,
  } = ctx;

  const orchResult = await runOrchestrator({
    contractText: analyzeText,
    digest: digest.digest,
    ragHits: rag.hits,
    signals,
    perspective,
    versionDiffs: versionAnalysis?.diff_items,
  });

  const {
    reconciled_findings_grounded,
    reconciled_findings_inferred,
    reconciled_redlines,
    reconciled_opportunities,
    blocking_issues,
    compliance_flags,
    meta: orchMeta,
  } = orchResult;

  // Build a synthetic CounselOutput from reconciled lens results
  const overallRisk: "critical" | "high" | "medium" | "low" =
    reconciled_findings_grounded.some((f) => f.severity === "critical") ||
    blocking_issues.length > 0
      ? "critical"
      : reconciled_findings_grounded.some((f) => f.severity === "high")
        ? "high"
        : reconciled_findings_grounded.some((f) => f.severity === "medium")
          ? "medium"
          : "low";

  const execSummary =
    `${orchMeta.lens_models.length}-lens orchestrator analysis. ` +
    `${reconciled_findings_grounded.length} grounded findings, ` +
    `${reconciled_findings_inferred.length} inferred. ` +
    `Grounded ratio: ${(orchMeta.grounded_ratio * 100).toFixed(0)}%. ` +
    (blocking_issues.length > 0
      ? `${blocking_issues.length} sign blocker(s) identified.`
      : "No critical sign blockers.");

  const parsedOutput: CounselOutput = {
    doc_class: signals.has_restricted_stock || signals.has_83b ? "cofounder_agreement" : "contract",
    overall_risk: overallRisk,
    executive_summary: execSummary,
    findings_grounded: reconciled_findings_grounded,
    findings_inferred: reconciled_findings_inferred,
    lens_findings: [],
    opportunities_for_company: reconciled_opportunities,
    redlines: reconciled_redlines,
    blocking_issues,
    missing_clauses: compliance_flags,
    next_steps: [
      "Review sign_blockers in deal_memo before execution.",
      "Confirm 83(b) election filed within 30 days of grant.",
      "Validate Schedule C IP assignment scope with IP counsel.",
    ],
    reasoning_notes: `Orchestrator mode: ${orchMeta.lens_models.join(", ")}`,
  };

  const dealMemo = buildDealMemo({
    perspective,
    overall_risk: overallRisk,
    executive_summary: execSummary,
    findings_grounded: reconciled_findings_grounded,
    findings_inferred: reconciled_findings_inferred,
    blocking_issues,
    signals,
    versionDiffs: versionAnalysis?.diff_items,
  });

  const slugs = [...new Set(rag.hits.map((h) => h.slug))];

  logger.info(
    {
      overall_risk: overallRisk,
      grounded: reconciled_findings_grounded.length,
      inferred: reconciled_findings_inferred.length,
      grounded_ratio: orchMeta.grounded_ratio,
      orchestrator_mode: true,
      lens_models: orchMeta.lens_models,
    },
    "legalCounsel: orchestrator analysis complete",
  );

  return {
    output: {
      ...parsedOutput,
      governance: counselGovernanceBlock(),
      coverage: {
        sections_total: digest.sections_total,
        sections_included: digest.sections_included,
        chars_sent: digest.chars_sent,
        full_text_length: analyzeText.length,
        coverage_pct: digest.coverage_pct,
      },
      version_analysis: versionAnalysis,
      deal_memo: dealMemo,
    },
    rag_sources: slugs,
    rag_corpus_version: LEGAL_CORPUS_VERSION,
    retrieval_mode: rag.retrieval_mode,
    section_count: sections.length,
    model_used: orchMeta.lens_models[0] ?? "orchestrator",
    latency_ms: Date.now() - t0,
    meta: {
      chunks_retrieved: rag.hits.length,
      corpus_chunks_total: corpusChunksTotal,
      retrieval_mode: rag.retrieval_mode,
      force_critical_used: isCofounder,
      forced_slugs_requested: [...COFOUNDER_STATUTE_SLUGS],
      forced_slugs_retrieved: rag.forced_slugs_retrieved,
      contract_signals: signals,
      queries_run: rag.queries_run,
      multi_version: versionAnalysis != null,
      orchestrator_mode: true,
      grounded_ratio: orchMeta.grounded_ratio,
      lens_models: orchMeta.lens_models,
    },
  };
}

// ── Monolith path (legacy, mode="monolith") ───────────────────────────────────

async function runMonolithPath(
  input: CounselAnalyzeInput,
  t0: number,
): Promise<CounselAnalyzeResult> {
  const ctx = await prepSharedContext(input);
  const {
    analyzeText,
    sections,
    digest,
    signals,
    rag,
    isCofounder,
    corpusChunksTotal,
    versionAnalysis,
    perspective,
  } = ctx;

  const userContent = JSON.stringify({
    perspective,
    doc_hint: input.docHint ?? null,
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
    contract_signals: signals,
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
      "When contract_signals show 83(b)/RSPA/restricted stock, ground tax findings to irc-83b, dgcl-144, irc-1202, irc-409a if in knowledge_base. " +
      "Apply company leverage lens: flag Mutual Dependency, acceleration cost, blank Schedule C, employee vs contractor delta. " +
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
  let findingsGrounded = enrichGroundedStatuteFindings(
    partitioned.findings_grounded,
    rag.hits,
    signals,
  );
  const leverage = buildCompanyLeverageFindings(
    analyzeText,
    signals,
    versionAnalysis?.diff_items,
    perspective,
  );

  const mergeInferred = (base: InferredFinding[], extra: InferredFinding[]) => {
    const out = [...base];
    for (const e of extra) {
      if (out.some((x) => x.issue.slice(0, 40) === e.issue.slice(0, 40))) continue;
      out.push(e);
    }
    return out;
  };

  const findingsInferred = mergeInferred(partitioned.findings_inferred, leverage.inferred);
  const opportunities = [
    ...(result.parsed.opportunities_for_company ?? []),
    ...leverage.opportunities,
  ];
  const blockingIssues = [
    ...new Set([...(result.parsed.blocking_issues ?? []), ...leverage.blocking]),
  ];

  const totalFindings = findingsGrounded.length + findingsInferred.length;
  const groundedRatio = totalFindings > 0 ? findingsGrounded.length / totalFindings : 0;

  const dealMemo = buildDealMemo({
    perspective,
    overall_risk: result.parsed.overall_risk,
    executive_summary: result.parsed.executive_summary,
    findings_grounded: findingsGrounded,
    findings_inferred: findingsInferred,
    blocking_issues: blockingIssues,
    signals,
    versionDiffs: versionAnalysis?.diff_items,
  });

  const slugs = [...new Set(rag.hits.map((h) => h.slug))];

  const output = {
    ...result.parsed,
    findings_grounded: findingsGrounded,
    findings_inferred: findingsInferred,
    opportunities_for_company: opportunities,
    blocking_issues: blockingIssues,
    lens_findings: result.parsed.lens_findings?.length
      ? result.parsed.lens_findings
      : [
          ...findingsGrounded.map((g) => ({
            lens: g.lens,
            severity: g.severity as "critical" | "high" | "medium" | "low" | "info",
            issue: g.issue,
            contract_excerpt: g.contract_excerpt,
            corpus_slugs: [g.slug],
            recommendation: g.recommendation,
          })),
          ...findingsInferred.map((inf) => ({
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
    deal_memo: dealMemo,
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
      orchestrator_mode: false,
    },
    "legalCounsel: monolith analysis complete",
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
      forced_slugs_requested: [...COFOUNDER_STATUTE_SLUGS],
      forced_slugs_retrieved: rag.forced_slugs_retrieved,
      contract_signals: signals,
      queries_run: rag.queries_run,
      multi_version: versionAnalysis != null,
      orchestrator_mode: false,
      grounded_ratio: groundedRatio,
      lens_models: [result.model_used],
    },
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runLegalCounselAnalyze(
  input: CounselAnalyzeInput,
): Promise<CounselAnalyzeResult> {
  const t0 = Date.now();
  // Default to orchestrator (C1 gate: meta.orchestrator_mode=true without ?mode= param)
  const mode = input.mode ?? "orchestrator";

  if (mode === "monolith") {
    return runMonolithPath(input, t0);
  }
  return runOrchestratorPath(input, t0);
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
