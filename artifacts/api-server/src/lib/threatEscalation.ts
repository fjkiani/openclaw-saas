/**
 * threatEscalation.ts
 *
 * Deterministic threat trigger detection for contract analysis.
 * No model calls. All classification is regex-based with confidence tiers.
 *
 * Taxonomy (v2 — revised per plan approval):
 *   outside_affiliation     — concurrent employment / board / advisory conflicts
 *   third_party_ip          — third-party IP, licensed data, open-source obligations
 *   competitive_overlap     — competing business / product language
 *   sensitive_breach        — regulated data (HIPAA, PII, GDPR, biometric, SOX)
 *   dependency_excuse_risk  — counterparty excuse language tied to company delays/resources
 *   unilateral_authority    — company-protective discretion language (posture marker, NOT a threat)
 *
 * Confidence tiers:
 *   signal  — pattern matched; context unknown; may be benign. Never auto-blocks.
 *   review  — pattern matched with supporting context; likely relevant. Never auto-blocks.
 *   strong  — multiple corroborating patterns; high specificity. Auto-blocks only if severity=critical.
 *
 * Severity:
 *   info     — posture marker; no escalation
 *   high     — requires counsel review; does not block
 *   critical — blocks auto-insert; elevates governance threshold
 *
 * Auto-block rule: triggers.some(t => t.confidence === "strong" && t.severity === "critical")
 * Single keyword match alone NEVER auto-blocks.
 */

import type { DocClass } from "./draftReceiptEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TriggerCategory =
  | "outside_affiliation"
  | "third_party_ip"
  | "competitive_overlap"
  | "sensitive_breach"
  | "dependency_excuse_risk"
  | "unilateral_authority";

export type TriggerConfidence = "signal" | "review" | "strong";
export type TriggerSeverity = "info" | "high" | "critical";

export interface ThreatTrigger {
  trigger_id: string;
  category: TriggerCategory;
  label: string;
  matched_text: string;             // excerpt from contract that fired the trigger
  matched_patterns: string[];       // which pattern strings fired
  trigger_source_section: string | null; // section heading where match found; null if undetermined
  confidence: TriggerConfidence;
  severity: TriggerSeverity;
  escalation_required: boolean;
  recommended_action: string;
}

export interface ThreatAssessment {
  triggers: ThreatTrigger[];
  posture_markers: ThreatTrigger[];  // unilateral_authority triggers — separate from threat triggers
  overall_threat_level: "none" | "elevated" | "critical";
  auto_block: boolean;
}

// ── Section segmentation ──────────────────────────────────────────────────────

interface TextSegment {
  heading: string | null;
  body: string;
  start: number;
  end: number;
}

/**
 * Splits contract text into sections by detecting headings.
 * Heading patterns: ALL CAPS lines, numbered sections (1., 2.1., etc.),
 * or title-case lines followed by a newline.
 */
function segmentText(text: string): TextSegment[] {
  const headingPattern =
    /^(?:(\d+(?:\.\d+)*\.?\s+[A-Z][^\n]{0,80})|([A-Z][A-Z\s]{3,60})|([A-Z][a-z][^\n]{3,60}(?=\n)))/gm;

  const segments: TextSegment[] = [];
  const matches: Array<{ index: number; heading: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(text)) !== null) {
    matches.push({ index: m.index, heading: m[0].trim() });
  }

  if (matches.length === 0) {
    return [{ heading: null, body: text, start: 0, end: text.length }];
  }

  // Preamble before first heading
  if (matches[0].index > 0) {
    segments.push({
      heading: null,
      body: text.slice(0, matches[0].index),
      start: 0,
      end: matches[0].index,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    segments.push({
      heading: matches[i].heading,
      body: text.slice(start, end),
      start,
      end,
    });
  }

  return segments;
}

function findSourceSection(text: string, matchIndex: number, segments: TextSegment[]): string | null {
  for (const seg of segments) {
    if (matchIndex >= seg.start && matchIndex < seg.end) {
      return seg.heading;
    }
  }
  return null;
}

function extractExcerpt(text: string, matchIndex: number, length = 120): string {
  const start = Math.max(0, matchIndex - 20);
  const end = Math.min(text.length, matchIndex + length);
  let excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) excerpt = "…" + excerpt;
  if (end < text.length) excerpt = excerpt + "…";
  return excerpt;
}

// ── Pattern definitions ───────────────────────────────────────────────────────

interface PatternGroup {
  id: string;
  patterns: RegExp[];
}

const OUTSIDE_AFFILIATION_PATTERNS: PatternGroup[] = [
  {
    id: "employment_conflict",
    patterns: [
      /outside\s+employment/i,
      /other\s+employer/i,
      /concurrent\s+engagement/i,
      /simultaneous\s+employment/i,
    ],
  },
  {
    id: "board_advisory",
    patterns: [
      /board\s+member\s+of/i,
      /advisor\s+to\s+(?:a|an|the)\s+\w/i,
      /affiliated\s+with\s+(?:a|an|the)\s+\w/i,
      /serves?\s+(?:on|as)\s+(?:the\s+)?board/i,
    ],
  },
];

const THIRD_PARTY_IP_PATTERNS: PatternGroup[] = [
  {
    id: "open_source_signal",
    patterns: [
      /open[\s-]source/i,
      /\bmit\s+licen[sc]e\b/i,
      /\bapache\s+licen[sc]e\b/i,
      /\bgpl\b/i,
      /\blgpl\b/i,
    ],
  },
  {
    id: "licensed_from_third",
    patterns: [
      /licen[sc]ed?\s+from\s+(?:a\s+)?third/i,
      /third[\s-]party\s+(?:intellectual\s+property|ip|data|software)/i,
      /proprietary\s+(?:data|software|technology)\s+(?:from|of|owned\s+by)/i,
    ],
  },
  {
    id: "assignment_conflict",
    patterns: [
      /third[\s-]party\s+ip\s+.*assign/i,
      /assign.*third[\s-]party\s+ip/i,
      /encumbered\s+by\s+(?:a\s+)?(?:prior|existing|third)/i,
    ],
  },
];

const COMPETITIVE_OVERLAP_PATTERNS: PatternGroup[] = [
  {
    id: "competitor_mention",
    patterns: [
      /\bcompetitor\b/i,
      /competing\s+(?:product|business|service|company)/i,
      /direct\s+competitor/i,
    ],
  },
  {
    id: "competitive_activity",
    patterns: [
      /competitive\s+activit/i,
      /engage\s+in\s+(?:any\s+)?(?:business|activity)\s+(?:that\s+)?competes/i,
      /competes?\s+(?:directly|indirectly)\s+with/i,
    ],
  },
];

// Sensitive breach: single keyword = signal/high; keyword + breach/liability = review/high;
// keyword + inadequate protection = strong/critical
const SENSITIVE_BREACH_SIGNAL_PATTERNS: PatternGroup[] = [
  {
    id: "regulated_data_keyword",
    patterns: [
      /\bhipaa\b/i,
      /\bgdpr\b/i,
      /\bpii\b/i,
      /\bpersonal\s+(?:data|information)\b/i,
      /\bbiometric(?:\s+data)?\b/i,
      /\bhealth\s+information\b/i,
      /\bsox\b/i,
      /\bfinancial\s+(?:data|records|information)\b/i,
    ],
  },
];

const SENSITIVE_BREACH_REVIEW_PATTERNS: PatternGroup[] = [
  {
    id: "breach_liability",
    patterns: [
      /breach\s+(?:of\s+)?(?:data|privacy|security)/i,
      /data\s+breach/i,
      /liability\s+for\s+(?:data|privacy|security)/i,
      /indemnif\w+\s+(?:for\s+)?(?:data|privacy|security)/i,
    ],
  },
];

const SENSITIVE_BREACH_STRONG_PATTERNS: PatternGroup[] = [
  {
    id: "inadequate_protection",
    patterns: [
      /no\s+(?:obligation|duty|requirement)\s+to\s+(?:protect|secure|encrypt)/i,
      /not\s+responsible\s+for\s+(?:data|privacy|security)/i,
      /waives?\s+(?:any\s+)?(?:claim|right)\s+(?:related\s+to\s+)?(?:data|privacy)/i,
      /excludes?\s+(?:all\s+)?(?:liability|damages)\s+(?:for\s+)?(?:data|privacy|breach)/i,
    ],
  },
];

// dependency_excuse_risk: counterparty excuse language tied to company delays/resources
const DEPENDENCY_EXCUSE_PATTERNS: PatternGroup[] = [
  {
    id: "milestone_excuse",
    patterns: [
      /deemed\s+(?:achieved|satisfied|complete)\s+if\s+delayed\s+by/i,
      /failure\s+excused\s+(?:by|due\s+to)\s+company/i,
      /subject\s+to\s+(?:the\s+)?company\s+providing/i,
      /if\s+(?:the\s+)?company\s+(?:fails|delays|does\s+not\s+provide)/i,
    ],
  },
  {
    id: "resource_dependency",
    patterns: [
      /conditioned\s+on\s+(?:the\s+)?company\s+delivering/i,
      /excused\s+(?:due\s+to|by\s+reason\s+of)\s+(?:the\s+)?company(?:'s)?\s+(?:failure|delay|resource)/i,
      /milestone\s+(?:shall\s+be\s+)?(?:deemed\s+)?satisfied\s+if\s+(?:the\s+)?company\s+fails/i,
      /performance\s+excused\s+(?:by|due\s+to)\s+(?:the\s+)?company(?:'s)?\s+dependency/i,
    ],
  },
];

// unilateral_authority: company-protective discretion language — posture marker ONLY
const UNILATERAL_AUTHORITY_PATTERNS: PatternGroup[] = [
  {
    id: "sole_discretion",
    patterns: [
      /\bsole\s+discretion\b/i,
      /at\s+(?:its|their|the\s+company's)\s+sole\s+discretion/i,
    ],
  },
  {
    id: "unilateral_action",
    patterns: [
      /\bunilaterally\b/i,
      /without\s+(?:the\s+)?(?:prior\s+)?(?:written\s+)?consent\s+of/i,
      /without\s+(?:prior\s+)?notice/i,
      /may\s+terminate\s+(?:this\s+agreement\s+)?immediately/i,
      /\bwithout\s+cause\b/i,
    ],
  },
];

// ── Pattern matching helpers ──────────────────────────────────────────────────

interface PatternMatch {
  patternId: string;
  matchIndex: number;
  matchedText: string;
  patternStr: string;
}

function findMatches(text: string, groups: PatternGroup[]): PatternMatch[] {
  const results: PatternMatch[] = [];
  for (const group of groups) {
    for (const pattern of group.patterns) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = globalPattern.exec(text)) !== null) {
        results.push({
          patternId: group.id,
          matchIndex: m.index,
          matchedText: m[0],
          patternStr: pattern.source,
        });
      }
    }
  }
  return results;
}

function uniquePatternIds(matches: PatternMatch[]): string[] {
  return [...new Set(matches.map((m) => m.patternId))];
}

// ── Trigger builders ──────────────────────────────────────────────────────────

function buildOutsideAffiliationTrigger(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const matches = findMatches(text, OUTSIDE_AFFILIATION_PATTERNS);
  if (matches.length === 0) return null;

  const uniqueIds = uniquePatternIds(matches);
  const confidence: TriggerConfidence = uniqueIds.length >= 2 ? "strong" : "review";
  const firstMatch = matches[0];

  return {
    trigger_id: "OUTSIDE_AFFILIATION",
    category: "outside_affiliation",
    label: "Outside Affiliation / Concurrent Employment",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: matches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence,
    severity: "high",
    escalation_required: true,
    recommended_action:
      "Identify all concurrent affiliations. Confirm no conflict with IP assignment scope or non-compete obligations.",
  };
}

function buildThirdPartyIPTrigger(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const signalMatches = findMatches(text, [THIRD_PARTY_IP_PATTERNS[0]]);
  const reviewMatches = findMatches(text, [THIRD_PARTY_IP_PATTERNS[1]]);
  const strongMatches = findMatches(text, [THIRD_PARTY_IP_PATTERNS[2]]);

  const allMatches = [...signalMatches, ...reviewMatches, ...strongMatches];
  if (allMatches.length === 0) return null;

  let confidence: TriggerConfidence;
  if (strongMatches.length > 0) {
    confidence = "strong";
  } else if (reviewMatches.length > 0) {
    confidence = "review";
  } else {
    confidence = "signal";
  }

  const firstMatch = allMatches[0];

  return {
    trigger_id: "THIRD_PARTY_IP",
    category: "third_party_ip",
    label: "Third-Party IP / Licensed Data",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: allMatches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence,
    severity: "high",
    escalation_required: confidence !== "signal",
    recommended_action:
      confidence === "signal"
        ? "Review open-source license obligations and confirm no assignment conflicts."
        : "Identify all third-party IP. Confirm assignment scope excludes encumbered IP and obtain counsel review.",
  };
}

function buildCompetitiveOverlapTrigger(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const matches = findMatches(text, COMPETITIVE_OVERLAP_PATTERNS);
  if (matches.length === 0) return null;

  const uniqueIds = uniquePatternIds(matches);
  const confidence: TriggerConfidence = uniqueIds.length >= 2 ? "strong" : "review";
  const firstMatch = matches[0];

  return {
    trigger_id: "COMPETITIVE_OVERLAP",
    category: "competitive_overlap",
    label: "Competitive Overlap",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: matches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence,
    severity: "high",
    escalation_required: true,
    recommended_action:
      "Define competitive activity scope. Confirm non-compete and non-solicitation clauses are adequate.",
  };
}

function buildSensitiveBreachTrigger(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const signalMatches = findMatches(text, SENSITIVE_BREACH_SIGNAL_PATTERNS);
  if (signalMatches.length === 0) return null;

  const reviewMatches = findMatches(text, SENSITIVE_BREACH_REVIEW_PATTERNS);
  const strongMatches = findMatches(text, SENSITIVE_BREACH_STRONG_PATTERNS);

  let confidence: TriggerConfidence;
  let severity: TriggerSeverity;

  if (strongMatches.length > 0) {
    confidence = "strong";
    severity = "critical";
  } else if (reviewMatches.length > 0) {
    confidence = "review";
    severity = "high";
  } else {
    confidence = "signal";
    severity = "high";
  }

  const allMatches = [...signalMatches, ...reviewMatches, ...strongMatches];
  const firstMatch = allMatches[0];

  return {
    trigger_id: "SENSITIVE_BREACH",
    category: "sensitive_breach",
    label: "Regulated / Sensitive Data",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: allMatches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence,
    severity,
    escalation_required: true,
    recommended_action:
      confidence === "signal"
        ? "Regulated data language detected. Confirm data handling obligations and applicable compliance requirements."
        : confidence === "review"
          ? "Breach/liability language combined with regulated data. Counsel review required before execution."
          : "Inadequate data protection language detected alongside regulated data. This is a blocking issue — do not execute without counsel review.",
  };
}

function buildDependencyExcuseTrigger(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const matches = findMatches(text, DEPENDENCY_EXCUSE_PATTERNS);
  if (matches.length === 0) return null;

  const uniqueIds = uniquePatternIds(matches);
  const confidence: TriggerConfidence = uniqueIds.length >= 2 ? "strong" : "review";
  const firstMatch = matches[0];

  return {
    trigger_id: "DEPENDENCY_EXCUSE_RISK",
    category: "dependency_excuse_risk",
    label: "Dependency-Based Performance Excuse",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: matches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence,
    severity: "high",
    escalation_required: true,
    recommended_action:
      "Counterparty excuse language tied to company resource delivery detected. " +
      "Confirm milestone definitions are not contingent on company performance obligations that shift risk.",
  };
}

function buildUnilateralAuthorityMarker(
  text: string,
  segments: TextSegment[],
): ThreatTrigger | null {
  const matches = findMatches(text, UNILATERAL_AUTHORITY_PATTERNS);
  if (matches.length === 0) return null;

  const firstMatch = matches[0];

  return {
    trigger_id: "UNILATERAL_AUTHORITY",
    category: "unilateral_authority",
    label: "Unilateral Authority / Company Discretion",
    matched_text: extractExcerpt(text, firstMatch.matchIndex),
    matched_patterns: matches.map((m) => m.patternStr),
    trigger_source_section: findSourceSection(text, firstMatch.matchIndex, segments),
    confidence: "signal",   // always signal — this is company-protective language
    severity: "info",       // always info — posture marker, not a threat
    escalation_required: false,
    recommended_action:
      "Company-protective discretion language. Review whether scope is appropriate for negotiation context.",
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function assessThreats(
  text: string,
  _doc_class: DocClass,
): ThreatAssessment {
  const segments = segmentText(text);

  const threatBuilders = [
    buildOutsideAffiliationTrigger,
    buildThirdPartyIPTrigger,
    buildCompetitiveOverlapTrigger,
    buildSensitiveBreachTrigger,
    buildDependencyExcuseTrigger,
  ];

  const triggers: ThreatTrigger[] = [];
  for (const builder of threatBuilders) {
    const trigger = builder(text, segments);
    if (trigger !== null) {
      triggers.push(trigger);
    }
  }

  const postureTrigger = buildUnilateralAuthorityMarker(text, segments);
  const posture_markers: ThreatTrigger[] = postureTrigger ? [postureTrigger] : [];

  // Auto-block: only when confidence=strong AND severity=critical
  const auto_block = triggers.some(
    (t) => t.confidence === "strong" && t.severity === "critical",
  );

  let overall_threat_level: ThreatAssessment["overall_threat_level"] = "none";
  if (triggers.some((t) => t.severity === "critical")) {
    overall_threat_level = "critical";
  } else if (triggers.length > 0) {
    overall_threat_level = "elevated";
  }

  return { triggers, posture_markers, overall_threat_level, auto_block };
}
