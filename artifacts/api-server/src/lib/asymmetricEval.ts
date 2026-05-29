/**
 * asymmetricEval.ts
 *
 * Asymmetric clause evaluation: benchmarks incoming contract clauses against
 * high_leverage and minimum_acceptable positions.
 *
 * Design principles (v2 — hardened per plan approval):
 *
 * 1. Two-step test:
 *    Step 1 — Clause presence gate: only evaluate if detected by the coverage
 *             classifier (detected_clauses[]). Not detected → position: "absent".
 *    Step 2 — Synonym family matching against the clause's detected text span,
 *             NOT the full contract. This prevents recital/preamble false positives.
 *
 * 2. Synonym families replace single-token hard floors. A concept is matched
 *    if ANY synonym in the family appears in the clause text span.
 *
 * 3. benchmark_confidence: "strong" | "moderate" | "weak"
 *    - weak → position is "needs_review", never "below_minimum"
 *
 * 4. position values:
 *    high_leverage | acceptable | below_minimum | absent | needs_review | unknown
 *
 * No model calls. All classification is deterministic.
 */

import type { DocClass } from "./draftReceiptEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClausePosition =
  | "high_leverage"
  | "acceptable"
  | "below_minimum"
  | "absent"
  | "needs_review"   // detected but benchmark confidence weak
  | "unknown";       // detected but no benchmark defined for this clause/doc_class

export type BenchmarkConfidence = "strong" | "moderate" | "weak";

export interface ClauseEvaluation {
  clause_id: string;
  label: string;
  position: ClausePosition;
  benchmark_confidence: BenchmarkConfidence;
  deviation_from_ideal: string | null;      // null if at ideal (high_leverage)
  deviation_from_minimum: string | null;    // non-null when below_minimum or absent
  matched_high_leverage: string[];          // synonym family members that matched
  matched_minimum: string[];                // synonym family members that matched
  missing_minimum_terms: string[];          // minimum family members not found
}

export interface AsymmetricEvalResult {
  evaluations: ClauseEvaluation[];
  below_minimum_count: number;
  high_leverage_count: number;
  acceptable_count: number;
  absent_count: number;
  needs_review_count: number;
}

// ── Detected clause type (matches documentCoverage.ts DetectedClause exactly) ──
// All items in detected_clauses[] are by definition detected.
// text_span is not provided by documentCoverage — we extract it from fullText.

export interface DetectedClause {
  clause_id: string;
  label: string;
  required: boolean;
  confidence: "high" | "medium" | "low";
  matched_patterns: string[];
}

// ── Benchmark definition ──────────────────────────────────────────────────────

interface SynonymFamily {
  /** Human-readable description of what this family represents */
  description: string;
  /** Regex patterns — any match in the clause text span counts */
  patterns: RegExp[];
  /**
   * Context qualifiers: if present, at least one must match alongside the
   * primary pattern for the match to count as "in-clause" (not recital).
   * If empty, primary pattern alone is sufficient.
   */
  context_qualifiers?: RegExp[];
}

interface ClauseBenchmark {
  clause_id: string;
  label: string;
  doc_classes: Array<DocClass | "all">;
  high_leverage: SynonymFamily;
  minimum: SynonymFamily;
  /**
   * Recital exclusion patterns: if the matched text is preceded by these
   * patterns within 200 chars, the match is demoted to "weak" confidence.
   */
  recital_exclusions?: RegExp[];
}

// ── Benchmark library ─────────────────────────────────────────────────────────

const BENCHMARKS: ClauseBenchmark[] = [
  // ── ip_assignment ──────────────────────────────────────────────────────────
  {
    clause_id: "ip_assignment",
    label: "IP Assignment",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment"],
    high_leverage: {
      description: "Broad, irrevocable assignment of all IP",
      patterns: [
        /irrevocably\s+assigns?/i,
        /work\s+made\s+for\s+hire/i,
        /all\s+right[,\s]+title[,\s]+and\s+interest/i,
        /hereby\s+assigns?\s+and\s+transfers?/i,
        /perpetual[,\s]+irrevocable/i,
      ],
    },
    minimum: {
      description: "Any assignment of IP or inventions",
      patterns: [
        /\bassigns?\b/i,
        /assignment\s+of/i,
        /intellectual\s+property.*assign/i,
        /assign.*intellectual\s+property/i,
        /all\s+inventions/i,
        /all\s+developments/i,
        /work\s+product.*assign/i,
        /assign.*work\s+product/i,
      ],
    },
    recital_exclusions: [
      /\bwhereas\b/i,
      /\brecital\b/i,
      /\bpreamble\b/i,
      /\bbackground\b/i,
    ],
  },

  // ── vesting_schedule ───────────────────────────────────────────────────────
  {
    clause_id: "vesting_schedule",
    label: "Vesting Schedule",
    doc_classes: ["co_founder_agreement"],
    high_leverage: {
      description: "4-year schedule with 1-year cliff",
      patterns: [
        /four[\s-]year\s+vest/i,
        /4[\s-]year\s+vest/i,
        /vest.*four\s+year/i,
        /vest.*4\s+year/i,
        /one[\s-]year\s+cliff/i,
        /1[\s-]year\s+cliff/i,
        /12[\s-]month\s+cliff/i,
        /36\s+month.*vest/i,
        /48\s+month.*vest/i,
      ],
    },
    minimum: {
      description: "Any vesting schedule present",
      patterns: [
        /\bvest\b/i,
        /\bvesting\b/i,
        /\bvested\b/i,
        /vesting\s+schedule/i,
        /equity.*vest/i,
        /shares.*vest/i,
        /vest.*equity/i,
        /vest.*shares/i,
      ],
    },
  },

  // ── termination_and_buyout ─────────────────────────────────────────────────
  {
    clause_id: "termination_and_buyout",
    label: "Termination & Buyout",
    doc_classes: ["co_founder_agreement"],
    high_leverage: {
      description: "Repurchase right or forfeiture of unvested equity on termination",
      patterns: [
        /repurchase\s+right/i,
        /right\s+of\s+(?:first\s+)?repurchase/i,
        /unvested.*(?:shall\s+be\s+)?forfeit/i,
        /forfeit.*unvested/i,
        /buyout\s+right/i,
        /right\s+to\s+buy\s+(?:back|out)/i,
      ],
    },
    minimum: {
      description: "Any termination provision addressing equity",
      patterns: [
        /\bterminat/i,
        /upon\s+termination/i,
        /termination.*equity/i,
        /equity.*termination/i,
        /termination.*shares/i,
        /shares.*termination/i,
      ],
    },
  },

  // ── transfer_restrictions ──────────────────────────────────────────────────
  {
    clause_id: "transfer_restrictions",
    label: "Transfer Restrictions",
    doc_classes: ["co_founder_agreement"],
    high_leverage: {
      description: "ROFR, lock-up, or explicit prohibition on transfer",
      patterns: [
        /right\s+of\s+first\s+refusal/i,
        /\brofr\b/i,
        /prohibited\s+transfer/i,
        /prior\s+written\s+consent\s+of\s+all/i,
        /lock[\s-]up/i,
        /transfer\s+restriction/i,
        /may\s+not\s+transfer/i,
        /shall\s+not\s+transfer/i,
      ],
    },
    minimum: {
      description: "Any restriction on transfer of equity",
      patterns: [
        /\btransfer\b/i,
        /transferabilit/i,
        /restrict.*transfer/i,
        /transfer.*restrict/i,
      ],
      context_qualifiers: [
        /equity|shares|interest|stock/i,
      ],
    },
    recital_exclusions: [
      /\bwhereas\b/i,
      /\brecital\b/i,
      /\bip\s+assignment\b/i,
      /intellectual\s+property/i,
    ],
  },

  // ── governing_law ──────────────────────────────────────────────────────────
  {
    clause_id: "governing_law",
    label: "Governing Law",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement", "all"],
    high_leverage: {
      description: "Exclusive jurisdiction with conflict-of-laws waiver",
      patterns: [
        /exclusive\s+jurisdiction/i,
        /without\s+regard\s+to\s+(?:its\s+)?conflict\s+of\s+laws/i,
        /irrevocably\s+submit/i,
        /exclusive\s+venue/i,
        /sole\s+and\s+exclusive\s+jurisdiction/i,
      ],
    },
    minimum: {
      description: "Any governing law clause",
      patterns: [
        /governed\s+by/i,
        /governed\s+by\s+the\s+laws/i,
        /laws\s+of\s+the\s+state/i,
        /applicable\s+law/i,
        /choice\s+of\s+law/i,
        /governing\s+law/i,
      ],
    },
  },

  // ── non_solicitation ───────────────────────────────────────────────────────
  {
    clause_id: "non_solicitation",
    label: "Non-Solicitation",
    doc_classes: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement", "all"],
    high_leverage: {
      description: "12+ month non-solicitation with direct/indirect scope",
      patterns: [
        /12[\s-]month.*solicit/i,
        /24[\s-]month.*solicit/i,
        /solicit.*12[\s-]month/i,
        /solicit.*24[\s-]month/i,
        /directly\s+or\s+indirectly\s+solicit/i,
        /solicit.*employ/i,
        /hire.*directly\s+or\s+indirectly/i,
      ],
    },
    minimum: {
      description: "Any non-solicitation provision",
      patterns: [
        /\bsolicit\b/i,
        /\bsolicitation\b/i,
        /non[\s-]solicit/i,
        /shall\s+not.*solicit/i,
        /agree.*not.*solicit/i,
      ],
    },
  },
];

// ── Text matching helpers ─────────────────────────────────────────────────────

function matchSynonymFamily(
  text: string,
  family: SynonymFamily,
): { matched: string[]; confidence: BenchmarkConfidence } {
  const matched: string[] = [];

  for (const pattern of family.patterns) {
    const globalPat = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalPat.exec(text)) !== null) {
      // Check context qualifiers if present
      if (family.context_qualifiers && family.context_qualifiers.length > 0) {
        const window = text.slice(Math.max(0, m.index - 150), Math.min(text.length, m.index + 150));
        const qualifierMet = family.context_qualifiers.some((q) => q.test(window));
        if (!qualifierMet) continue;
      }
      matched.push(m[0]);
      break; // one match per pattern is enough
    }
  }

  let confidence: BenchmarkConfidence;
  if (matched.length >= 2) {
    confidence = "strong";
  } else if (matched.length === 1) {
    confidence = "moderate";
  } else {
    confidence = "weak";
  }

  return { matched, confidence };
}

function isRecitalContext(
  text: string,
  matchIndex: number,
  exclusions: RegExp[],
): boolean {
  // Check 300 chars before the match for recital indicators
  const window = text.slice(Math.max(0, matchIndex - 300), matchIndex);
  return exclusions.some((ex) => ex.test(window));
}

function getClauseTextSpan(
  fullText: string,
  clauseId: string,
  detectedClause: DetectedClause,
): string {
  // Extract a window around the clause heading in the full text
  // (documentCoverage does not provide text_span)
  // Look for the clause label or common heading variants
  const headingPatterns = [
    new RegExp(clauseId.replace(/_/g, "[\\s_-]"), "i"),
    new RegExp(detectedClause.label.replace(/[^a-zA-Z0-9]/g, ".{0,3}"), "i"),
  ];

  for (const pat of headingPatterns) {
    const m = pat.exec(fullText);
    if (m) {
      // Extract up to 1500 chars after the heading
      return fullText.slice(m.index, Math.min(fullText.length, m.index + 1500));
    }
  }

  // Last resort: use full text (will be marked weak confidence)
  return fullText;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function evaluateAsymmetric(
  fullText: string,
  detectedClauses: DetectedClause[],
  docClass: DocClass,
): AsymmetricEvalResult {
  const evaluations: ClauseEvaluation[] = [];

  // Build a lookup of detected clauses
  const detectedMap = new Map<string, DetectedClause>();
  for (const dc of detectedClauses) {
    detectedMap.set(dc.clause_id, dc);
  }

  // Filter benchmarks applicable to this doc_class
  const applicableBenchmarks = BENCHMARKS.filter(
    (b) => b.doc_classes.includes(docClass) || b.doc_classes.includes("all"),
  );

  for (const benchmark of applicableBenchmarks) {
    const detected = detectedMap.get(benchmark.clause_id);

    // Step 1: Clause presence gate
    if (!detected) {
      evaluations.push({
        clause_id: benchmark.clause_id,
        label: benchmark.label,
        position: "absent",
        benchmark_confidence: "strong", // absence is a definitive finding
        deviation_from_ideal: `Clause not detected. Expected: ${benchmark.high_leverage.description}`,
        deviation_from_minimum: `Clause absent. Minimum required: ${benchmark.minimum.description}`,
        matched_high_leverage: [],
        matched_minimum: [],
        missing_minimum_terms: benchmark.minimum.patterns.map((p) => p.source),
      });
      continue;
    }

    // Step 2: Get clause text span (not full contract)
    const clauseText = getClauseTextSpan(fullText, benchmark.clause_id, detected);
    const isFullTextFallback = clauseText === fullText;

    // Match synonym families
    const hlResult = matchSynonymFamily(clauseText, benchmark.high_leverage);
    const minResult = matchSynonymFamily(clauseText, benchmark.minimum);

    // Check for recital context on minimum matches
    let recitalDemotion = false;
    if (benchmark.recital_exclusions && minResult.matched.length > 0) {
      // Find the first minimum match index in clauseText
      for (const pattern of benchmark.minimum.patterns) {
        const m = pattern.exec(clauseText);
        if (m && isRecitalContext(clauseText, m.index, benchmark.recital_exclusions)) {
          recitalDemotion = true;
          break;
        }
      }
    }

    // Determine benchmark_confidence
    let benchmarkConfidence: BenchmarkConfidence;
    if (isFullTextFallback || recitalDemotion) {
      benchmarkConfidence = "weak";
    } else if (minResult.confidence === "strong" || hlResult.confidence === "strong") {
      benchmarkConfidence = "strong";
    } else {
      benchmarkConfidence = "moderate";
    }

    // Determine position
    let position: ClausePosition;
    if (benchmarkConfidence === "weak") {
      // Never force below_minimum when confidence is weak
      position = "needs_review";
    } else if (hlResult.matched.length > 0) {
      position = "high_leverage";
    } else if (minResult.matched.length > 0) {
      position = "acceptable";
    } else {
      position = "below_minimum";
    }

    // Compute missing minimum terms
    const missingMinimumTerms: string[] = [];
    if (minResult.matched.length === 0) {
      missingMinimumTerms.push(...benchmark.minimum.patterns.slice(0, 3).map((p) => p.source));
    }

    // Deviation from ideal
    let deviationFromIdeal: string | null = null;
    if (position !== "high_leverage") {
      const missingHL = benchmark.high_leverage.patterns
        .filter((p) => !hlResult.matched.some((m) => p.test(m)))
        .slice(0, 3)
        .map((p) => p.source);
      deviationFromIdeal = `Missing high-leverage terms: ${missingHL.join(", ")}`;
    }

    // Deviation from minimum
    let deviationFromMinimum: string | null = null;
    if (position === "below_minimum") {
      deviationFromMinimum = missingMinimumTerms.length > 0
        ? `Missing minimum terms: ${missingMinimumTerms.join(", ")}`
        : `Minimum concept not satisfied: ${benchmark.minimum.description}`;
    }

    evaluations.push({
      clause_id: benchmark.clause_id,
      label: benchmark.label,
      position,
      benchmark_confidence: benchmarkConfidence,
      deviation_from_ideal: deviationFromIdeal,
      deviation_from_minimum: deviationFromMinimum,
      matched_high_leverage: hlResult.matched,
      matched_minimum: minResult.matched,
      missing_minimum_terms: missingMinimumTerms,
    });
  }

  // Counts
  const below_minimum_count = evaluations.filter((e) => e.position === "below_minimum").length;
  const high_leverage_count = evaluations.filter((e) => e.position === "high_leverage").length;
  const acceptable_count = evaluations.filter((e) => e.position === "acceptable").length;
  const absent_count = evaluations.filter((e) => e.position === "absent").length;
  const needs_review_count = evaluations.filter((e) => e.position === "needs_review").length;

  return {
    evaluations,
    below_minimum_count,
    high_leverage_count,
    acceptable_count,
    absent_count,
    needs_review_count,
  };
}
