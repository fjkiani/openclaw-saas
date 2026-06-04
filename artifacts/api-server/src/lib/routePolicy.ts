/**
 * routePolicy.ts
 *
 * Semantic Law Counsel v1 — Risk-tiered routing policy config.
 *
 * One policy object per doc class. No scattered conditionals.
 * getRoutePolicy(docClass) is the single source of truth for chain selection,
 * schema type, and human review rules.
 *
 * SemanticDocClass extends DocClass with "nda" and "default" for routing purposes.
 * Callers that pass SemanticDocClass values to DocClass-bound functions (e.g.
 * evaluateAsymmetric, reviewDocumentCoverage) must guard against unsupported values
 * before calling — see semanticLegalAnalyzer.ts.
 */

import type { DocClass } from "./draftReceiptEngine.js";
import type { ModelRouteConfig } from "./modelRouter.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * SemanticDocClass extends the three supported DocClass values with routing-only
 * classes that have no CLAUSE_INVENTORIES or BENCHMARKS entries.
 * "nda" and "default" will be skipped by the unsupported-doc-class guard in
 * semanticLegalAnalyzer.ts — they exist here only to give them explicit policy config.
 */
export type SemanticDocClass = DocClass | "nda" | "default";

export type RiskTier = "premium" | "medium" | "standard";

export interface RoutePolicy {
  docClass: SemanticDocClass;
  riskTier: RiskTier;
  schemaType: "premium" | "standard";
  primaryChain: ModelRouteConfig[];
  fallbackChain: ModelRouteConfig[];
  humanReviewRule: "always" | "on_disagreement" | "on_critical";
  description: string;
}

// ── Model constants ───────────────────────────────────────────────────────────
// timeoutMs: 55_000 on all entries — Railway max request timeout is 5 minutes.
// modelRouter.ts defaults to 25_000 (AbortSignal.timeout) which kills calls
// before Railway's proxy sees them. 55s gives the full chain room to respond.

const GROQ_LLAMA_70B: ModelRouteConfig = {
  id: "llama-3.3-70b-versatile",
  provider: "groq",
  apiKeyEnv: "GROQ_API_KEY",
  timeoutMs: 55_000,
  tags: ["70b", "fast"],
};

const OR_LLAMA_70B_K1: ModelRouteConfig = {
  id: "meta-llama/llama-3.3-70b-instruct:free",
  provider: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  timeoutMs: 55_000,
  tags: ["70b"],
};

const OR_LLAMA_70B_K2: ModelRouteConfig = {
  id: "meta-llama/llama-3.3-70b-instruct:free",
  provider: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY_2",
  timeoutMs: 55_000,
  tags: ["70b"],
};

const OR_GPT_120B: ModelRouteConfig = {
  id: "openai/gpt-oss-120b:free",
  provider: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  timeoutMs: 55_000,
  tags: ["120b"],
};

const OR_GPT_20B: ModelRouteConfig = {
  id: "openai/gpt-oss-20b:free",
  provider: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY_2",
  timeoutMs: 55_000,
  tags: ["20b"],
};

// ── Chain definitions ─────────────────────────────────────────────────────────

/** Premium-first: starts with highest-capacity available. */
const PREMIUM_PRIMARY_CHAIN: ModelRouteConfig[] = [
  GROQ_LLAMA_70B,
  OR_LLAMA_70B_K1,
  OR_LLAMA_70B_K2,
];
const PREMIUM_FALLBACK_CHAIN: ModelRouteConfig[] = [OR_GPT_120B, OR_GPT_20B];

/** Standard: 20B first (fast/cheap), 70B as fallback. */
const STANDARD_PRIMARY_CHAIN: ModelRouteConfig[] = [OR_GPT_20B, OR_LLAMA_70B_K1];
const STANDARD_FALLBACK_CHAIN: ModelRouteConfig[] = [OR_GPT_120B, GROQ_LLAMA_70B];

/** Medium: 70B primary, 20B fallback. */
const MEDIUM_PRIMARY_CHAIN: ModelRouteConfig[] = [OR_LLAMA_70B_K1, GROQ_LLAMA_70B];
const MEDIUM_FALLBACK_CHAIN: ModelRouteConfig[] = [OR_GPT_120B, OR_GPT_20B];

// ── Policy table ──────────────────────────────────────────────────────────────

const ROUTE_POLICIES: RoutePolicy[] = [
  {
    docClass: "co_founder_agreement",
    riskTier: "premium",
    schemaType: "premium",
    primaryChain: PREMIUM_PRIMARY_CHAIN,
    fallbackChain: PREMIUM_FALLBACK_CHAIN,
    humanReviewRule: "always",
    description:
      "Co-founder agreements carry equity, IP, and governance risk. Premium-first chain. Human review mandatory regardless of semantic output.",
  },
  {
    docClass: "contractor_ip_assignment",
    riskTier: "medium",
    schemaType: "standard",
    primaryChain: MEDIUM_PRIMARY_CHAIN,
    fallbackChain: MEDIUM_FALLBACK_CHAIN,
    humanReviewRule: "on_disagreement",
    description:
      "IP assignment contracts. Medium risk. Human review triggered on deterministic/semantic disagreement.",
  },
  {
    docClass: "advisor_agreement",
    riskTier: "medium",
    schemaType: "standard",
    primaryChain: MEDIUM_PRIMARY_CHAIN,
    fallbackChain: MEDIUM_FALLBACK_CHAIN,
    humanReviewRule: "on_disagreement",
    description: "Advisor agreements. Medium risk. Human review on disagreement.",
  },
  {
    docClass: "nda",
    riskTier: "standard",
    schemaType: "standard",
    primaryChain: STANDARD_PRIMARY_CHAIN,
    fallbackChain: STANDARD_FALLBACK_CHAIN,
    humanReviewRule: "on_critical",
    description:
      "NDAs. Standard risk. Human review only on critical risk_level. Note: no CLAUSE_INVENTORIES or BENCHMARKS entry — semantic analysis will be skipped in v1.",
  },
  {
    docClass: "default",
    riskTier: "standard",
    schemaType: "standard",
    primaryChain: STANDARD_PRIMARY_CHAIN,
    fallbackChain: STANDARD_FALLBACK_CHAIN,
    humanReviewRule: "on_critical",
    description:
      "Default policy for unrecognized doc classes. Semantic analysis skipped in v1 — no CLAUSE_INVENTORIES or BENCHMARKS coverage.",
  },
];

// ── Exports ───────────────────────────────────────────────────────────────────

export function getRoutePolicy(docClass: string): RoutePolicy {
  return (
    ROUTE_POLICIES.find((p) => p.docClass === docClass) ??
    ROUTE_POLICIES.find((p) => p.docClass === "default")!
  );
}

/**
 * buildFullChain — primary + fallback combined.
 * The router tries primary entries first and falls through to fallback.
 */
export function buildFullChain(policy: RoutePolicy): ModelRouteConfig[] {
  return [...policy.primaryChain, ...policy.fallbackChain];
}
