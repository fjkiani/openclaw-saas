/**
 * semantic.law.counsel.unit.test.ts
 *
 * Semantic Law Counsel v1 — Unit tests.
 * 23 cases. All must pass. Zero skips.
 *
 * SLC-22 note (from plan approval):
 *   SLC-22 is a compile-time structural compatibility assertion, not a runtime
 *   safety guarantee. It verifies that SemanticClauseAnalysisSchema and
 *   PremiumClauseAnalysisSchema share the required base fields. It does NOT
 *   prove that detector output can never drift semantically.
 */

import { describe, it, expect } from "vitest";
import {
  SemanticClauseAnalysisSchema,
  PremiumClauseAnalysisSchema,
  classifyModelResponse,
  detectUnusableOutput,
} from "../../lib/semanticClauseSchema";
import {
  getRoutePolicy,
  buildFullChain,
} from "../../lib/routePolicy";
import {
  SPECIALIST_TO_DOC_CLASS,
  SEMANTIC_PROMPT_VERSION,
  buildRouteChainId,
} from "../../lib/semanticLegalAnalyzer";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// These match the actual SemanticClauseAnalysisSchema / PremiumClauseAnalysisSchema fields.

// A rationale_summary that satisfies the 50-word minimum and no generic phrases.
const LONG_RATIONALE =
  "The equity split clause is entirely absent from this co-founder agreement. " +
  "Without an explicit equity allocation table, the parties have no binding record of " +
  "their respective ownership percentages. This creates a critical governance gap: in the " +
  "event of a dispute, a court would have no contractual basis to determine ownership. " +
  "Founders should add a clause specifying exact percentages, vesting schedule, and cliff.";

const VALID_STANDARD_OBJECT = {
  clause_id: "equity_split",
  clause_label: "Equity Split",
  semantic_position: "absent" as const,
  risk_level: "high" as const,
  rationale_summary: LONG_RATIONALE,
  recommended_action:
    "Add an explicit equity split table specifying each founder's percentage and vesting terms.",
  confidence: 0.9,
  flags: [],
  prompt_version: SEMANTIC_PROMPT_VERSION,
  schema_version: "standard-v1" as const,
  route_chain_id: "co_founder_agreement:premium:semantic-v1.0",
};

// Premium rationale must be ≥75 words.
const LONG_PREMIUM_RATIONALE =
  "The equity split clause is entirely absent from this co-founder agreement. " +
  "Without an explicit equity allocation table, the parties have no binding record of " +
  "their respective ownership percentages. This creates a critical governance gap: in the " +
  "event of a dispute, a court would have no contractual basis to determine ownership. " +
  "Market standard for early-stage co-founder agreements is a 4-year vesting schedule with " +
  "a 1-year cliff. Delaware courts have consistently held that oral equity agreements are " +
  "unenforceable without written corroboration. Founders should add a clause specifying " +
  "exact percentages, vesting schedule, cliff, and acceleration triggers.";

const VALID_PREMIUM_OBJECT = {
  clause_id: "equity_split",
  clause_label: "Equity Split",
  semantic_position: "absent" as const,
  risk_level: "high" as const,
  rationale_summary: LONG_PREMIUM_RATIONALE,
  precedent_or_market_norm_note:
    "Delaware standard: 4-year vesting with 1-year cliff is market norm for co-founder agreements.",
  target_redline:
    "Add Section 3.1: Equity Allocation table specifying each founder's percentage.",
  key_risk_if_accepted:
    "Without written equity allocation, founders face unenforceable oral agreement risk under Delaware law.",
  recommended_action:
    "Add an explicit equity split table specifying each founder's percentage and vesting terms.",
  confidence: 0.9,
  requires_human_review: true as const,
  flags: [],
  prompt_version: SEMANTIC_PROMPT_VERSION,
  schema_version: "premium-v1" as const,
  route_chain_id: "co_founder_agreement:premium:semantic-v1.0",
};

// JSON strings for classifyModelResponse (which takes a raw string)
const VALID_STANDARD_JSON = JSON.stringify(VALID_STANDARD_OBJECT);
const VALID_PREMIUM_JSON = JSON.stringify(VALID_PREMIUM_OBJECT);

// ── SLC-01: Standard schema accepts valid response ────────────────────────────

describe("SLC-01: Standard schema accepts valid response", () => {
  it("parses a valid standard response without errors", () => {
    const result = SemanticClauseAnalysisSchema.safeParse(VALID_STANDARD_OBJECT);
    if (!result.success) console.error(result.error.issues);
    expect(result.success).toBe(true);
  });
});

// ── SLC-02: Premium schema accepts valid response ─────────────────────────────

describe("SLC-02: Premium schema accepts valid response", () => {
  it("parses a valid premium response without errors", () => {
    const result = PremiumClauseAnalysisSchema.safeParse(VALID_PREMIUM_OBJECT);
    if (!result.success) console.error(result.error.issues);
    expect(result.success).toBe(true);
  });
});

// ── SLC-03: Standard schema rejects missing required fields ───────────────────

describe("SLC-03: Standard schema rejects missing required fields", () => {
  it("fails when risk_level is absent", () => {
    const { risk_level: _, ...incomplete } = VALID_STANDARD_OBJECT;
    const result = SemanticClauseAnalysisSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("fails when rationale_summary is absent", () => {
    const { rationale_summary: _, ...incomplete } = VALID_STANDARD_OBJECT;
    const result = SemanticClauseAnalysisSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("fails when recommended_action is absent", () => {
    const { recommended_action: _, ...incomplete } = VALID_STANDARD_OBJECT;
    const result = SemanticClauseAnalysisSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });
});

// ── SLC-04: Standard schema rejects invalid risk_level enum ──────────────────

describe("SLC-04: Standard schema rejects invalid risk_level enum", () => {
  it("fails when risk_level is not a valid enum value", () => {
    const result = SemanticClauseAnalysisSchema.safeParse({
      ...VALID_STANDARD_OBJECT,
      risk_level: "extreme",
    });
    expect(result.success).toBe(false);
  });
});

// ── SLC-05: Standard schema rejects out-of-range confidence ──────────────────

describe("SLC-05: Standard schema rejects out-of-range confidence", () => {
  it("fails when confidence is greater than 1", () => {
    const result = SemanticClauseAnalysisSchema.safeParse({
      ...VALID_STANDARD_OBJECT,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("fails when confidence is negative", () => {
    const result = SemanticClauseAnalysisSchema.safeParse({
      ...VALID_STANDARD_OBJECT,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });
});

// ── SLC-06: Premium schema requires requires_human_review: true ───────────────

describe("SLC-06: Premium schema requires requires_human_review: true", () => {
  it("fails when requires_human_review is absent", () => {
    const { requires_human_review: _, ...withoutReview } = VALID_PREMIUM_OBJECT;
    const result = PremiumClauseAnalysisSchema.safeParse(withoutReview);
    expect(result.success).toBe(false);
  });

  it("fails when requires_human_review is false (must be literal true)", () => {
    const result = PremiumClauseAnalysisSchema.safeParse({
      ...VALID_PREMIUM_OBJECT,
      requires_human_review: false,
    });
    expect(result.success).toBe(false);
  });
});

// ── SLC-07: classifyModelResponse detects refusal ────────────────────────────

describe("SLC-07: classifyModelResponse detects refusal", () => {
  it("classifies a refusal response as kind='refusal'", () => {
    const classification = classifyModelResponse(
      '{"clause_id":"equity_split","rationale_summary":"I cannot provide legal advice."}',
    );
    // The refusal pattern check runs on the raw string before JSON parse
    const refusalRaw = "I cannot provide legal advice on this matter.";
    const result = classifyModelResponse(refusalRaw);
    expect(result.kind).toBe("refusal");
  });
});

// ── SLC-08: classifyModelResponse handles non-JSON strings ───────────────────

describe("SLC-08: classifyModelResponse handles non-JSON strings", () => {
  it("classifies a plain string (no JSON) as kind='partial_json'", () => {
    const classification = classifyModelResponse("Here is some analysis without JSON.");
    expect(["partial_json", "refusal"]).toContain(classification.kind);
  });
});

// ── SLC-09: classifyModelResponse accepts valid JSON ─────────────────────────

describe("SLC-09: classifyModelResponse accepts valid JSON", () => {
  it("classifies a valid JSON response as kind='valid_json'", () => {
    const classification = classifyModelResponse(VALID_STANDARD_JSON);
    expect(classification.kind).toBe("valid_json");
  });
});

// ── SLC-10: detectUnusableOutput flags empty critical fields ─────────────────

describe("SLC-10: detectUnusableOutput flags empty critical fields", () => {
  it("returns a reason string for an object with empty rationale_summary", () => {
    const result = detectUnusableOutput(
      { rationale_summary: "", recommended_action: "Do something specific here." },
      "standard",
    );
    expect(result).not.toBeNull();
  });

  it("returns a reason string for an object with empty recommended_action", () => {
    const result = detectUnusableOutput(
      { rationale_summary: "Some specific analysis of the clause.", recommended_action: "" },
      "standard",
    );
    expect(result).not.toBeNull();
  });

  it("returns a reason string for an object with placeholder text", () => {
    const result = detectUnusableOutput(
      {
        rationale_summary: "[PLACEHOLDER] analysis here.",
        recommended_action: "Do something specific.",
      },
      "standard",
    );
    expect(result).not.toBeNull();
  });
});

// ── SLC-11: detectUnusableOutput passes valid object ─────────────────────────

describe("SLC-11: detectUnusableOutput passes valid object", () => {
  it("returns null for a valid response object with non-empty required fields", () => {
    const result = detectUnusableOutput(
      {
        rationale_summary: "The equity split clause is absent from the document.",
        recommended_action: "Add an explicit equity split table with percentages.",
      },
      "standard",
    );
    expect(result).toBeNull();
  });
});

// ── SLC-12: getRoutePolicy returns premium for co_founder_agreement ──────────

describe("SLC-12: getRoutePolicy returns premium for co_founder_agreement", () => {
  it("returns riskTier=premium for co_founder_agreement", () => {
    const policy = getRoutePolicy("co_founder_agreement");
    expect(policy.riskTier).toBe("premium");
    expect(policy.schemaType).toBe("premium");
    expect(policy.humanReviewRule).toBe("always");
  });
});

// ── SLC-13: getRoutePolicy returns medium for contractor_ip_assignment ────────

describe("SLC-13: getRoutePolicy returns medium for contractor_ip_assignment", () => {
  it("returns riskTier=medium for contractor_ip_assignment", () => {
    const policy = getRoutePolicy("contractor_ip_assignment");
    expect(policy.riskTier).toBe("medium");
  });
});

// ── SLC-14: getRoutePolicy falls back to default for unknown doc class ────────

describe("SLC-14: getRoutePolicy falls back to default for unknown doc class", () => {
  it("returns the default policy for an unrecognized doc class", () => {
    const policy = getRoutePolicy("unknown_doc_class_xyz");
    expect(policy.docClass).toBe("default");
    expect(policy.riskTier).toBe("standard");
  });
});

// ── SLC-15: buildFullChain returns non-empty array ────────────────────────────

describe("SLC-15: buildFullChain returns non-empty array", () => {
  it("returns at least 2 models for any policy", () => {
    const policy = getRoutePolicy("co_founder_agreement");
    const chain = buildFullChain(policy);
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });

  it("all chain entries have id, provider, and apiKeyEnv", () => {
    const policy = getRoutePolicy("co_founder_agreement");
    const chain = buildFullChain(policy);
    for (const entry of chain) {
      expect(entry.id).toBeTruthy();
      expect(entry.provider).toBeTruthy();
      expect(entry.apiKeyEnv).toBeTruthy();
    }
  });
});

// ── SLC-16: SPECIALIST_TO_DOC_CLASS maps cofounder correctly ─────────────────

describe("SLC-16: SPECIALIST_TO_DOC_CLASS maps cofounder correctly", () => {
  it("maps 'cofounder' to 'co_founder_agreement'", () => {
    expect(SPECIALIST_TO_DOC_CLASS["cofounder"]).toBe("co_founder_agreement");
  });

  it("returns undefined for unmapped specialists", () => {
    expect(SPECIALIST_TO_DOC_CLASS["litigation"]).toBeUndefined();
    expect(SPECIALIST_TO_DOC_CLASS["contract"]).toBeUndefined();
  });
});

// ── SLC-17: SEMANTIC_PROMPT_VERSION is a non-empty string ────────────────────

describe("SLC-17: SEMANTIC_PROMPT_VERSION is a non-empty string", () => {
  it("is a non-empty string", () => {
    expect(typeof SEMANTIC_PROMPT_VERSION).toBe("string");
    expect(SEMANTIC_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

// ── SLC-18: buildRouteChainId includes docClass, riskTier, promptVersion ─────

describe("SLC-18: buildRouteChainId includes docClass, riskTier, promptVersion", () => {
  it("chain ID contains all three components", () => {
    const policy = getRoutePolicy("co_founder_agreement");
    const chainId = buildRouteChainId(policy);
    expect(chainId).toContain("co_founder_agreement");
    expect(chainId).toContain("premium");
    expect(chainId).toContain(SEMANTIC_PROMPT_VERSION);
  });
});

// ── SLC-19: Standard schema accepts empty flags array ────────────────────────

describe("SLC-19: Standard schema accepts empty flags array", () => {
  it("parses successfully when flags is an empty array", () => {
    const result = SemanticClauseAnalysisSchema.safeParse({
      ...VALID_STANDARD_OBJECT,
      flags: [],
    });
    expect(result.success).toBe(true);
  });
});

// ── SLC-20: Premium schema accepts empty flags array ─────────────────────────

describe("SLC-20: Premium schema accepts empty flags array", () => {
  it("parses successfully when flags is an empty array", () => {
    const result = PremiumClauseAnalysisSchema.safeParse({
      ...VALID_PREMIUM_OBJECT,
      flags: [],
    });
    expect(result.success).toBe(true);
  });
});

// ── SLC-21: classifyModelResponse handles edge-case inputs gracefully ─────────

describe("SLC-21: classifyModelResponse handles edge-case inputs gracefully", () => {
  it("returns kind='refusal' for a refusal string", () => {
    const result = classifyModelResponse("I cannot help with that.");
    expect(result.kind).toBe("refusal");
  });

  it("returns kind='empty' for an empty string", () => {
    const result = classifyModelResponse("");
    expect(result.kind).toBe("empty");
  });

  it("returns kind='partial_json' for a non-JSON non-refusal string", () => {
    const result = classifyModelResponse("Here is some analysis without JSON.");
    expect(result.kind).toBe("partial_json");
  });
});

// ── SLC-22: Structural compatibility assertion (compile-time) ─────────────────
//
// Verifies that SemanticClauseAnalysisSchema and PremiumClauseAnalysisSchema
// share the required base fields. This is a compile-time structural check only.
// It does NOT guarantee that detector output cannot drift semantically at runtime.

describe("SLC-22: Structural compatibility — standard and premium share base fields", () => {
  it("both schemas share clause_id, risk_level, rationale_summary, recommended_action, confidence", () => {
    const BASE_FIELDS = [
      "clause_id",
      "clause_label",
      "semantic_position",
      "risk_level",
      "rationale_summary",
      "recommended_action",
      "confidence",
    ] as const;

    const standardResult = SemanticClauseAnalysisSchema.safeParse(VALID_STANDARD_OBJECT);
    const premiumResult = PremiumClauseAnalysisSchema.safeParse(VALID_PREMIUM_OBJECT);

    expect(standardResult.success).toBe(true);
    expect(premiumResult.success).toBe(true);

    if (standardResult.success && premiumResult.success) {
      for (const field of BASE_FIELDS) {
        expect(field in standardResult.data).toBe(true);
        expect(field in premiumResult.data).toBe(true);
      }
    }
  });
});

// ── SLC-23: getRoutePolicy nda policy is standard tier ───────────────────────

describe("SLC-23: getRoutePolicy nda policy is standard tier", () => {
  it("returns riskTier=standard and schemaType=standard for nda", () => {
    const policy = getRoutePolicy("nda");
    expect(policy.riskTier).toBe("standard");
    expect(policy.schemaType).toBe("standard");
    expect(policy.docClass).toBe("nda");
  });

  it("nda humanReviewRule is on_critical", () => {
    const policy = getRoutePolicy("nda");
    expect(policy.humanReviewRule).toBe("on_critical");
  });
});
