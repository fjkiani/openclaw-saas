/**
 * seoAuditAnalyzer.ts
 *
 * Double-dip SEO content audit analyzer.
 *
 * Fast path: liquid/lfm-2.5-1.2b-instruct:free (or policy-promoted model)
 * Slow path: openai/gpt-4o via OpenRouter
 *
 * Captures every audit into zie_training_records (SFT) and
 * zie_preference_pairs (DPO) with domain="seo", source_kind="direct_call".
 */

import { z } from "zod";
import crypto from "node:crypto";
import { executeDoubleDip } from "./doubleDipRouter.js";
import { logger } from "./logger.js";

// ─── Input schema ────────────────────────────────────────────────────────────

export interface SeoAuditInput {
  domain: string;
  github_owner: string;
  github_repo: string;
  github_branch: string;
  keywords: Array<{
    keyword: string;
    volume: number;
    competition_index: number;
  }>;
  desktop_performance: number;
}

// ─── Output schema (Zod-validated) ───────────────────────────────────────────

export const SeoAuditSchema = z.object({
  overall_score: z.number().min(0).max(100),
  issues: z.array(
    z.object({
      type: z.enum([
        "missing_meta",
        "thin_content",
        "keyword_gap",
        "performance_lag",
        "broken_link",
        "duplicate_content",
      ]),
      severity: z.enum(["low", "medium", "high", "critical"]),
      description: z.string().min(1),
      recommendation: z.string().min(1),
    }),
  ).min(1, "Must surface at least one issue"),
  keyword_coverage: z.object({
    covered: z.array(z.string()),
    missing: z.array(z.string()),
    coverage_pct: z.number().min(0).max(100),
  }),
  confidence: z.number().min(0).max(1),
}).superRefine((data, ctx) => {
  const criticalIssues = data.issues.filter(i => i.severity === "critical");
  if (criticalIssues.length > 0 && data.overall_score > 60) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "overall_score cannot exceed 60 when critical issues are present",
      path: ["overall_score"],
    });
  }
});

export type SeoAuditResult = z.infer<typeof SeoAuditSchema>;

// ─── System prompt ────────────────────────────────────────────────────────────

const SEO_SYSTEM_PROMPT = `You are an expert SEO auditor. Analyze the provided site data and return a JSON audit.

Return ONLY valid JSON matching this exact schema — no markdown fences, no prose:
{
  "overall_score": <integer 0-100>,
  "issues": [
    {
      "type": <"missing_meta"|"thin_content"|"keyword_gap"|"performance_lag"|"broken_link"|"duplicate_content">,
      "severity": <"low"|"medium"|"high"|"critical">,
      "description": "<specific finding citing the domain and keyword>",
      "recommendation": "<actionable fix>"
    }
  ],
  "keyword_coverage": {
    "covered": ["<keywords likely present in site content>"],
    "missing": ["<keywords not found>"],
    "coverage_pct": <integer 0-100>
  },
  "confidence": <float 0.0-1.0>
}

Hard rules:
- overall_score MUST be <= 60 if any critical issues exist
- issues array MUST have at least 1 entry
- confidence reflects certainty given limited crawl data (0=uncertain, 1=certain)
- Be specific: cite the domain name and keyword slugs in descriptions`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildSeoPrompt(input: SeoAuditInput): string {
  const keywordList = input.keywords
    .map(k => `  - "${k.keyword}" (volume: ${k.volume}, competition: ${k.competition_index})`)
    .join("\n");

  return JSON.stringify({
    site: input.domain,
    github: `${input.github_owner}/${input.github_repo}@${input.github_branch}`,
    desktop_performance: input.desktop_performance,
    target_keywords: input.keywords,
    instruction: `Audit ${input.domain} for SEO issues. Keywords:\n${keywordList}`,
  });
}

// ─── Hash helper ─────────────────────────────────────────────────────────────

function hashSeoPrompt(input: SeoAuditInput): string {
  const key = `seo_content_audit:${input.domain}:${input.github_owner}/${input.github_repo}:${input.keywords.map(k => k.keyword).sort().join(",")}`;
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runSeoAudit(input: SeoAuditInput): Promise<{
  audit: SeoAuditResult;
  path_taken: "fast" | "slow";
  prompt_hash: string;
}> {
  const promptPayload = buildSeoPrompt(input);
  const promptHash = hashSeoPrompt(input);

  logger.info(
    { domain: input.domain, promptHash },
    "seoAuditAnalyzer: starting double-dip audit",
  );

  const result = await executeDoubleDip(
    promptPayload,
    promptHash,
    "seo_content_audit",
    {
      domain: "seo",
      sourceKind: "direct_call",
      preferenceSource: "path_race",
      systemPrompt: SEO_SYSTEM_PROMPT,
      outputSchema: SeoAuditSchema,
      confidenceThreshold: 0.85,
    },
  );

  // result.analysis is already validated by SeoAuditSchema inside executeDoubleDip
  const audit = result.analysis as SeoAuditResult;

  logger.info(
    {
      domain: input.domain,
      path_taken: result.path_taken,
      overall_score: audit.overall_score,
      confidence: audit.confidence,
    },
    "seoAuditAnalyzer: audit complete",
  );

  return {
    audit,
    path_taken: result.path_taken,
    prompt_hash: promptHash,
  };
}
