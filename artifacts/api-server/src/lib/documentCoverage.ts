/**
 * documentCoverage.ts
 *
 * Lane B: whole-text document completeness review.
 * Deterministic regex/string scan — zero external model calls.
 *
 * Exports:
 *   reviewDocumentCoverage(text, doc_class) → CoverageResult
 */

import type { DocClass, ReviewThreshold } from "./draftReceiptEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpectedClause {
  clause_id: string;
  label: string;
  required: boolean;
  /** High-specificity phrases — one match alone is sufficient for detection. */
  high_specificity_phrases: string[];
  /** Ordinary keyword patterns — require 2+ matches for detection. */
  keyword_patterns: string[];
  /** Section heading patterns (regex strings, case-insensitive). */
  heading_patterns: string[];
  risk_if_absent: string;
  review_threshold: ReviewThreshold;
}

export interface DetectedClause {
  clause_id: string;
  label: string;
  required: boolean;
  confidence: "high" | "medium" | "low";
  matched_patterns: string[];
}

export interface UnsupportedSection {
  heading: string;
  reason: string;
  review_threshold: ReviewThreshold;
}

export interface CrossReferenceWarning {
  reference: string;
  context: string;
  warning: string;
}

export interface CoverageResult {
  coverage_score: number;
  review_threshold: ReviewThreshold;
  expected_clauses: ExpectedClause[];
  detected_clauses: DetectedClause[];
  missing_expected_clauses: ExpectedClause[];
  missing_required_clause_ids: string[];
  material_missing_clause_ids: string[];
  material_unsupported_sections: UnsupportedSection[];
  boilerplate_unsupported_sections: UnsupportedSection[];
  cross_reference_warnings: CrossReferenceWarning[];
  exhibits_detected: string[];
  coverage_summary: string;
}

// ── ReviewThreshold ordering ──────────────────────────────────────────────────

const THRESHOLD_ORDER: ReviewThreshold[] = [
  "self_review_ok",
  "business_review_required",
  "counsel_review_required",
  "blocked",
];

function maxThreshold(a: ReviewThreshold, b: ReviewThreshold): ReviewThreshold {
  return THRESHOLD_ORDER.indexOf(a) >= THRESHOLD_ORDER.indexOf(b) ? a : b;
}

// ── Clause inventories ────────────────────────────────────────────────────────

const CO_FOUNDER_CLAUSES: ExpectedClause[] = [
  {
    clause_id: "preamble",
    label: "Parties & Recitals",
    required: true,
    high_specificity_phrases: ["this co-founder agreement", "co-founder agreement is entered", "this agreement is made and entered"],
    keyword_patterns: ["agreement", "between", "whereas", "recital", "parties"],
    heading_patterns: ["^\\s*(recitals?|preamble|parties|background)\\b"],
    risk_if_absent: "No identified parties — agreement is unexecutable.",
    review_threshold: "blocked",
  },
  {
    clause_id: "equity_split",
    label: "Equity Split",
    required: true,
    high_specificity_phrases: ["equity split", "ownership percentage", "founder shares", "equity allocation", "percentage interest"],
    keyword_patterns: ["equity", "ownership", "percent", "shares", "interest", "allocation", "split"],
    heading_patterns: ["^\\s*(equity|ownership|capitalization|share|stock)\\b"],
    risk_if_absent: "Equity allocation undefined — agreement is incomplete and unexecutable.",
    review_threshold: "blocked",
  },
  {
    clause_id: "vesting_schedule",
    label: "Vesting Schedule",
    required: true,
    high_specificity_phrases: ["vesting schedule", "vesting period", "shares shall vest", "equity shall vest", "subject to vesting"],
    keyword_patterns: ["vest", "vesting", "cliff", "schedule", "monthly"],
    heading_patterns: ["^\\s*(vesting|vesting schedule|equity vesting)\\b"],
    risk_if_absent: "No vesting schedule — equity is fully liquid at signing.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "election_83b",
    label: "83(b) Election",
    required: true,
    high_specificity_phrases: ["section 83(b)", "83(b) election", "internal revenue code section 83", "irs section 83"],
    keyword_patterns: ["83(b)", "section 83", "irs", "election", "tax"],
    heading_patterns: ["^\\s*(83\\(b\\)|section 83|tax election)\\b"],
    risk_if_absent: "No 83(b) election guidance — founders may face adverse tax treatment on vesting.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "ip_assignment",
    label: "IP Assignment",
    required: true,
    high_specificity_phrases: ["intellectual property assignment", "assigns all right, title and interest", "work made for hire", "hereby assigns", "ip assignment"],
    keyword_patterns: ["intellectual property", "assign", "invention", "copyright", "patent", "trade secret"],
    heading_patterns: ["^\\s*(intellectual property|ip assignment|assignment of inventions|proprietary rights)\\b"],
    risk_if_absent: "No IP assignment — company may not own founder-created IP.",
    review_threshold: "blocked",
  },
  {
    clause_id: "roles_and_responsibilities",
    label: "Roles & Responsibilities",
    required: true,
    high_specificity_phrases: ["roles and responsibilities", "duties and responsibilities", "founder responsibilities", "time commitment"],
    keyword_patterns: ["role", "responsibilit", "title", "officer", "ceo", "cto", "duties", "commitment"],
    heading_patterns: ["^\\s*(roles?|responsibilities|duties|titles?|officers?)\\b"],
    risk_if_absent: "No defined roles — operational authority is ambiguous.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "decision_making",
    label: "Decision Making",
    required: true,
    high_specificity_phrases: ["unanimous consent", "majority vote", "board approval required", "decision-making authority", "voting rights"],
    keyword_patterns: ["decision", "vote", "majority", "unanimous", "board", "approval", "authority"],
    heading_patterns: ["^\\s*(decision.making|governance|voting|management|board)\\b"],
    risk_if_absent: "No decision-making framework — operational disputes have no resolution path.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "deadlock_resolution",
    label: "Deadlock Resolution",
    required: true,
    high_specificity_phrases: ["deadlock resolution", "in the event of a deadlock", "impasse resolution", "tie-breaking", "dispute resolution mechanism"],
    keyword_patterns: ["deadlock", "impasse", "dispute", "arbitration", "mediation", "tie"],
    heading_patterns: ["^\\s*(deadlock|impasse|dispute resolution|arbitration|mediation)\\b"],
    risk_if_absent: "No deadlock resolution — equal-split disputes have no exit mechanism.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "transfer_restrictions",
    label: "Transfer Restrictions",
    required: true,
    high_specificity_phrases: ["right of first refusal", "transfer restriction", "lock-up period", "prohibited transfer", "consent to transfer"],
    keyword_patterns: ["transfer", "rofr", "right of first refusal", "lock-up", "restriction", "prohibited"],
    heading_patterns: ["^\\s*(transfer|rofr|right of first refusal|lock.up|restrictions on transfer)\\b"],
    risk_if_absent: "No transfer restrictions — equity can be freely transferred to third parties.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "termination_and_buyout",
    label: "Termination & Buyout",
    required: true,
    high_specificity_phrases: ["buyout provision", "repurchase right", "termination for cause", "separation from the company", "buy-out price"],
    keyword_patterns: ["terminat", "buyout", "buy-out", "repurchase", "separation", "departure", "exit"],
    heading_patterns: ["^\\s*(termination|buyout|buy.out|separation|departure|exit)\\b"],
    risk_if_absent: "No termination/buyout mechanism — departing founder retains equity with no repurchase right.",
    review_threshold: "blocked",
  },
  {
    clause_id: "governing_law",
    label: "Governing Law",
    required: true,
    high_specificity_phrases: ["governed by the laws of", "governing law shall be", "laws of the state of", "subject to the laws of"],
    keyword_patterns: ["governing law", "governed by", "jurisdiction", "laws of", "choice of law"],
    heading_patterns: ["^\\s*(governing law|choice of law|applicable law|jurisdiction)\\b"],
    risk_if_absent: "No governing law — dispute forum is undefined.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "acceleration_clause",
    label: "Acceleration",
    required: false,
    high_specificity_phrases: ["single trigger acceleration", "double trigger acceleration", "accelerated vesting upon", "change of control acceleration"],
    keyword_patterns: ["accelerat", "single trigger", "double trigger", "change of control", "acquisition"],
    heading_patterns: ["^\\s*(acceleration|accelerated vesting|change of control)\\b"],
    risk_if_absent: "No acceleration clause — founders lose unvested equity in acquisition.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "non_solicitation",
    label: "Non-Solicitation",
    required: false,
    high_specificity_phrases: ["non-solicitation agreement", "shall not solicit", "covenant not to solicit", "solicitation of employees"],
    keyword_patterns: ["solicit", "non-solicitation", "poach", "recruit", "hire away"],
    heading_patterns: ["^\\s*(non.solicitation|solicitation|covenant not to solicit)\\b"],
    risk_if_absent: "No non-solicitation — departing founders may recruit company employees.",
    review_threshold: "business_review_required",
  },
];

const CONTRACTOR_IP_CLAUSES: ExpectedClause[] = [
  {
    clause_id: "preamble",
    label: "Parties & Recitals",
    required: true,
    high_specificity_phrases: ["this contractor agreement", "this ip assignment agreement", "this agreement is entered into", "this agreement is made"],
    keyword_patterns: ["agreement", "between", "whereas", "recital", "parties"],
    heading_patterns: ["^\\s*(recitals?|preamble|parties|background)\\b"],
    risk_if_absent: "No identified parties — agreement is unexecutable.",
    review_threshold: "blocked",
  },
  {
    clause_id: "scope_of_work",
    label: "Scope of Work",
    required: true,
    high_specificity_phrases: ["scope of work", "statement of work", "services to be performed", "deliverables include", "work product shall"],
    keyword_patterns: ["scope", "services", "deliverable", "work product", "perform", "provide"],
    heading_patterns: ["^\\s*(scope of work|statement of work|services|deliverables|work product)\\b"],
    risk_if_absent: "No defined scope — contractor obligations are unenforceable.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "ip_assignment",
    label: "IP Assignment",
    required: true,
    high_specificity_phrases: ["assigns all right, title and interest", "work made for hire", "hereby assigns", "ip assignment", "intellectual property assignment"],
    keyword_patterns: ["intellectual property", "assign", "invention", "copyright", "patent", "trade secret"],
    heading_patterns: ["^\\s*(intellectual property|ip assignment|assignment of inventions|proprietary rights)\\b"],
    risk_if_absent: "No IP assignment — company may not own contractor-created IP.",
    review_threshold: "blocked",
  },
  {
    clause_id: "work_made_for_hire",
    label: "Work Made for Hire",
    required: true,
    high_specificity_phrases: ["work made for hire", "work-for-hire", "made for hire within the meaning", "17 u.s.c"],
    keyword_patterns: ["work made for hire", "work-for-hire", "copyright act", "17 u.s.c", "hire"],
    heading_patterns: ["^\\s*(work made for hire|work.for.hire|copyright)\\b"],
    risk_if_absent: "No work-for-hire clause — copyright ownership may default to contractor.",
    review_threshold: "blocked",
  },
  {
    clause_id: "moral_rights_waiver",
    label: "Moral Rights Waiver",
    required: true,
    high_specificity_phrases: ["moral rights", "waives all moral rights", "waiver of moral rights", "right of attribution"],
    keyword_patterns: ["moral rights", "waiver", "attribution", "integrity", "paternity"],
    heading_patterns: ["^\\s*(moral rights|waiver of moral rights)\\b"],
    risk_if_absent: "No moral rights waiver — contractor may assert attribution or integrity rights.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "prior_inventions_carveout",
    label: "Prior Inventions Carve-out",
    required: true,
    high_specificity_phrases: ["prior inventions", "schedule a", "exhibit a", "pre-existing inventions", "prior work carve-out", "prior art carve"],
    keyword_patterns: ["prior invention", "schedule a", "exhibit a", "carve-out", "pre-existing", "prior work"],
    heading_patterns: ["^\\s*(prior inventions?|schedule a|exhibit a|pre.existing|carve.out)\\b"],
    risk_if_absent: "No prior inventions carve-out — broad assignment may capture pre-existing contractor IP.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "confidentiality",
    label: "Confidentiality",
    required: true,
    high_specificity_phrases: ["confidential information", "non-disclosure", "shall keep confidential", "duty of confidentiality", "proprietary information"],
    keyword_patterns: ["confidential", "nda", "non-disclosure", "proprietary", "secret"],
    heading_patterns: ["^\\s*(confidentiality|non.disclosure|nda|proprietary information)\\b"],
    risk_if_absent: "No confidentiality obligation — contractor may disclose company information.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "governing_law",
    label: "Governing Law",
    required: true,
    high_specificity_phrases: ["governed by the laws of", "governing law shall be", "laws of the state of", "subject to the laws of"],
    keyword_patterns: ["governing law", "governed by", "jurisdiction", "laws of", "choice of law"],
    heading_patterns: ["^\\s*(governing law|choice of law|applicable law|jurisdiction)\\b"],
    risk_if_absent: "No governing law — dispute forum is undefined.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "representations_and_warranties",
    label: "Representations & Warranties",
    required: true,
    high_specificity_phrases: ["represents and warrants", "contractor represents", "party represents", "warranties and representations"],
    keyword_patterns: ["represent", "warrant", "covenant", "certif"],
    heading_patterns: ["^\\s*(representations? and warranties|warranties|representations?)\\b"],
    risk_if_absent: "No representations and warranties — no contractual basis for breach claims.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "non_solicitation",
    label: "Non-Solicitation",
    required: false,
    high_specificity_phrases: ["non-solicitation agreement", "shall not solicit", "covenant not to solicit"],
    keyword_patterns: ["solicit", "non-solicitation", "poach", "recruit"],
    heading_patterns: ["^\\s*(non.solicitation|solicitation)\\b"],
    risk_if_absent: "No non-solicitation — contractor may recruit company employees.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "non_compete",
    label: "Non-Compete",
    required: false,
    high_specificity_phrases: ["non-compete agreement", "covenant not to compete", "shall not compete", "competitive activity"],
    keyword_patterns: ["non-compete", "noncompete", "compete", "competitive", "covenant not to compete"],
    heading_patterns: ["^\\s*(non.compete|noncompete|covenant not to compete)\\b"],
    risk_if_absent: "No non-compete — contractor may work for direct competitors.",
    review_threshold: "business_review_required",
  },
];

const ADVISOR_CLAUSES: ExpectedClause[] = [
  {
    clause_id: "preamble",
    label: "Parties & Recitals",
    required: true,
    high_specificity_phrases: ["this advisor agreement", "this advisory agreement", "this agreement is entered into", "this agreement is made"],
    keyword_patterns: ["agreement", "between", "whereas", "recital", "parties"],
    heading_patterns: ["^\\s*(recitals?|preamble|parties|background)\\b"],
    risk_if_absent: "No identified parties — agreement is unexecutable.",
    review_threshold: "blocked",
  },
  {
    clause_id: "advisory_services",
    label: "Advisory Services",
    required: true,
    high_specificity_phrases: ["advisory services", "advisor shall provide", "services as an advisor", "advisory role", "scope of advisory"],
    keyword_patterns: ["advisory", "services", "advise", "assist", "consult", "guidance"],
    heading_patterns: ["^\\s*(advisory services?|services|scope of services|advisor obligations?)\\b"],
    risk_if_absent: "No defined advisory services — advisor obligations are unenforceable.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "equity_compensation",
    label: "Equity Compensation",
    required: true,
    high_specificity_phrases: ["equity compensation", "stock option grant", "option to purchase", "equity award", "shares of common stock"],
    keyword_patterns: ["equity", "option", "shares", "compensation", "grant", "stock"],
    heading_patterns: ["^\\s*(equity compensation|equity|stock options?|compensation)\\b"],
    risk_if_absent: "No equity compensation defined — agreement has no enforceable consideration.",
    review_threshold: "blocked",
  },
  {
    clause_id: "vesting_schedule",
    label: "Vesting Schedule",
    required: true,
    high_specificity_phrases: ["vesting schedule", "vesting period", "shares shall vest", "equity shall vest", "subject to vesting"],
    keyword_patterns: ["vest", "vesting", "cliff", "schedule", "monthly"],
    heading_patterns: ["^\\s*(vesting|vesting schedule|equity vesting)\\b"],
    risk_if_absent: "No vesting schedule — equity is fully liquid at signing.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "ip_assignment",
    label: "IP Assignment",
    required: true,
    high_specificity_phrases: ["assigns all right, title and interest", "work made for hire", "hereby assigns", "ip assignment", "intellectual property assignment"],
    keyword_patterns: ["intellectual property", "assign", "invention", "copyright", "patent"],
    heading_patterns: ["^\\s*(intellectual property|ip assignment|assignment of inventions|proprietary rights)\\b"],
    risk_if_absent: "No IP assignment — company may not own advisor-created IP.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "confidentiality",
    label: "Confidentiality",
    required: true,
    high_specificity_phrases: ["confidential information", "non-disclosure", "shall keep confidential", "duty of confidentiality", "proprietary information"],
    keyword_patterns: ["confidential", "nda", "non-disclosure", "proprietary", "secret"],
    heading_patterns: ["^\\s*(confidentiality|non.disclosure|nda|proprietary information)\\b"],
    risk_if_absent: "No confidentiality obligation — advisor may disclose company information.",
    review_threshold: "counsel_review_required",
  },
  {
    clause_id: "no_conflict",
    label: "No Conflict",
    required: true,
    high_specificity_phrases: ["no conflict of interest", "no competing obligations", "advisor represents no conflict", "does not conflict with"],
    keyword_patterns: ["conflict", "no conflict", "competing", "other obligations", "represent"],
    heading_patterns: ["^\\s*(no conflict|conflict of interest|competing obligations?)\\b"],
    risk_if_absent: "No conflict-of-interest representation — advisor may have undisclosed competing obligations.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "termination",
    label: "Termination",
    required: true,
    high_specificity_phrases: ["this agreement may be terminated", "termination for cause", "either party may terminate", "upon termination"],
    keyword_patterns: ["terminat", "end", "expir", "cancel", "notice"],
    heading_patterns: ["^\\s*(termination|term and termination|expiration)\\b"],
    risk_if_absent: "No termination clause — agreement has no defined end mechanism.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "governing_law",
    label: "Governing Law",
    required: true,
    high_specificity_phrases: ["governed by the laws of", "governing law shall be", "laws of the state of", "subject to the laws of"],
    keyword_patterns: ["governing law", "governed by", "jurisdiction", "laws of", "choice of law"],
    heading_patterns: ["^\\s*(governing law|choice of law|applicable law|jurisdiction)\\b"],
    risk_if_absent: "No governing law — dispute forum is undefined.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "cash_compensation",
    label: "Cash Compensation",
    required: false,
    high_specificity_phrases: ["cash compensation", "monthly retainer", "advisory fee", "cash fee", "payment of"],
    keyword_patterns: ["cash", "fee", "payment", "retainer", "monthly"],
    heading_patterns: ["^\\s*(cash compensation|fees?|retainer|payment)\\b"],
    risk_if_absent: "No cash compensation defined.",
    review_threshold: "business_review_required",
  },
  {
    clause_id: "acceleration_clause",
    label: "Acceleration",
    required: false,
    high_specificity_phrases: ["single trigger acceleration", "double trigger acceleration", "accelerated vesting upon", "change of control acceleration"],
    keyword_patterns: ["accelerat", "single trigger", "double trigger", "change of control", "acquisition"],
    heading_patterns: ["^\\s*(acceleration|accelerated vesting|change of control)\\b"],
    risk_if_absent: "No acceleration clause — advisor loses unvested equity in acquisition.",
    review_threshold: "business_review_required",
  },
];

const CLAUSE_INVENTORIES: Record<DocClass, ExpectedClause[]> = {
  co_founder_agreement: CO_FOUNDER_CLAUSES,
  contractor_ip_assignment: CONTRACTOR_IP_CLAUSES,
  advisor_agreement: ADVISOR_CLAUSES,
};

// ── Material vs boilerplate unsupported section patterns ─────────────────────

interface UnsupportedPattern {
  id: string;
  heading: string;
  patterns: string[];           // any match triggers detection
  heading_patterns: string[];   // regex heading patterns
  reason: string;
  review_threshold: ReviewThreshold;
  category: "material" | "boilerplate";
}

const UNSUPPORTED_PATTERNS: UnsupportedPattern[] = [
  // ── Material ──────────────────────────────────────────────────────────────
  {
    id: "indemnification",
    heading: "Indemnification",
    patterns: ["indemnif", "hold harmless", "indemnitor", "indemnitee"],
    heading_patterns: ["^\\s*(indemnification|indemnity|hold harmless)\\b"],
    reason: "Indemnification clause is not modeled — liability exposure is unreviewed.",
    review_threshold: "counsel_review_required",
    category: "material",
  },
  {
    id: "limitation_of_liability",
    heading: "Limitation of Liability",
    patterns: ["limitation of liability", "liability cap", "in no event shall", "aggregate liability", "consequential damages"],
    heading_patterns: ["^\\s*(limitation of liability|liability cap|damages)\\b"],
    reason: "Limitation of liability clause is not modeled — damage exposure is unreviewed.",
    review_threshold: "counsel_review_required",
    category: "material",
  },
  {
    id: "liquidated_damages",
    heading: "Liquidated Damages",
    patterns: ["liquidated damages", "agreed damages", "pre-agreed damages", "penalty clause"],
    heading_patterns: ["^\\s*(liquidated damages|agreed damages|penalty)\\b"],
    reason: "Liquidated damages clause is not modeled — financial penalty terms are unreviewed.",
    review_threshold: "counsel_review_required",
    category: "material",
  },
  {
    id: "non_compete_material",
    heading: "Non-Compete",
    patterns: ["non-compete", "noncompete", "covenant not to compete", "competitive activity restriction"],
    heading_patterns: ["^\\s*(non.compete|noncompete|covenant not to compete)\\b"],
    reason: "Non-compete clause detected but not modeled for this doc_class — enforceability is jurisdiction-specific.",
    review_threshold: "counsel_review_required",
    category: "material",
  },
  {
    id: "arbitration_material",
    heading: "Arbitration / Dispute Resolution",
    patterns: ["binding arbitration", "arbitration clause", "aaa arbitration", "jams arbitration", "arbitration agreement"],
    heading_patterns: ["^\\s*(arbitration|dispute resolution|binding arbitration)\\b"],
    reason: "Arbitration/dispute resolution clause is not modeled — waives right to jury trial.",
    review_threshold: "counsel_review_required",
    category: "material",
  },
  {
    id: "representations_warranties_material",
    heading: "Representations & Warranties",
    patterns: ["represents and warrants", "warranties and representations", "party represents", "contractor represents"],
    heading_patterns: ["^\\s*(representations? and warranties|warranties|representations?)\\b"],
    reason: "Representations and warranties clause detected but not modeled for this doc_class.",
    review_threshold: "business_review_required",
    category: "material",
  },
  // ── Boilerplate ───────────────────────────────────────────────────────────
  {
    id: "entire_agreement",
    heading: "Entire Agreement",
    patterns: ["entire agreement", "integration clause", "supersedes all prior", "constitutes the entire"],
    heading_patterns: ["^\\s*(entire agreement|integration|merger clause)\\b"],
    reason: "Entire agreement / integration clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
  {
    id: "amendment",
    heading: "Amendment",
    patterns: ["may be amended", "amendment to this agreement", "modification of this agreement", "no amendment shall"],
    heading_patterns: ["^\\s*(amendment|modification|changes to this agreement)\\b"],
    reason: "Amendment clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
  {
    id: "severability",
    heading: "Severability",
    patterns: ["severability", "severable", "if any provision", "invalid or unenforceable"],
    heading_patterns: ["^\\s*(severability|savings clause)\\b"],
    reason: "Severability clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
  {
    id: "force_majeure",
    heading: "Force Majeure",
    patterns: ["force majeure", "act of god", "beyond the reasonable control", "unforeseeable circumstances"],
    heading_patterns: ["^\\s*(force majeure|act of god)\\b"],
    reason: "Force majeure clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
  {
    id: "counterparts",
    heading: "Counterparts",
    patterns: ["executed in counterparts", "counterpart signatures", "electronic signature", "docusign"],
    heading_patterns: ["^\\s*(counterparts?|signatures?|execution)\\b"],
    reason: "Counterparts/signature clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
  {
    id: "notices",
    heading: "Notices",
    patterns: ["notice shall be", "written notice", "notice to the parties", "notice address"],
    heading_patterns: ["^\\s*(notices?|notice provisions?)\\b"],
    reason: "Notices clause detected — standard boilerplate, not modeled.",
    review_threshold: "self_review_ok",
    category: "boilerplate",
  },
];

// ── Clause detection — precision rules ───────────────────────────────────────
// A clause is detected if ANY of:
//   (a) a heading_pattern matches a line in the text
//   (b) a high_specificity_phrase is found in the text
//   (c) 2+ keyword_patterns are found in the text

function detectClause(
  text: string,
  lines: string[],
  clause: ExpectedClause,
): DetectedClause | null {
  const lower = text; // already lowercased by caller
  const matched: string[] = [];

  // (a) Heading match
  for (const hp of clause.heading_patterns) {
    const re = new RegExp(hp, "im");
    if (re.test(lines.join("\n"))) {
      matched.push(`heading: ${hp}`);
      break;
    }
  }

  // (b) High-specificity phrase match
  for (const phrase of clause.high_specificity_phrases) {
    if (lower.includes(phrase.toLowerCase())) {
      matched.push(`phrase: "${phrase}"`);
    }
  }

  // (c) Keyword pattern count
  const keywordHits: string[] = [];
  for (const kw of clause.keyword_patterns) {
    if (lower.includes(kw.toLowerCase())) {
      keywordHits.push(kw);
    }
  }
  if (keywordHits.length >= 2) {
    matched.push(...keywordHits.map((k) => `keyword: "${k}"`));
  }

  if (matched.length === 0) return null;

  // Confidence: heading or high-specificity phrase → high; 3+ keywords → medium; 2 keywords → low
  const hasHeading = matched.some((m) => m.startsWith("heading:"));
  const hasPhrase  = matched.some((m) => m.startsWith("phrase:"));
  const kwCount    = matched.filter((m) => m.startsWith("keyword:")).length;

  let confidence: "high" | "medium" | "low";
  if (hasHeading || hasPhrase) {
    confidence = "high";
  } else if (kwCount >= 3) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    clause_id: clause.clause_id,
    label: clause.label,
    required: clause.required,
    confidence,
    matched_patterns: matched.slice(0, 6), // cap for response size
  };
}

// ── Unsupported section detection ─────────────────────────────────────────────
// Fires when: heading_pattern matches OR 2+ patterns match.
// Suppressed for patterns that are part of the expected clause inventory for this doc_class.

function detectUnsupportedSections(
  text: string,
  lines: string[],
  expectedClauseIds: Set<string>,
): { material: UnsupportedSection[]; boilerplate: UnsupportedSection[] } {
  const material: UnsupportedSection[] = [];
  const boilerplate: UnsupportedSection[] = [];
  const lower = text;

  for (const up of UNSUPPORTED_PATTERNS) {
    // Skip if this pattern maps to an expected clause for this doc_class
    if (expectedClauseIds.has(up.id)) continue;
    // Also skip representations_warranties_material if representations_and_warranties is expected
    if (up.id === "representations_warranties_material" && expectedClauseIds.has("representations_and_warranties")) continue;
    // Skip non_compete_material if non_compete is expected
    if (up.id === "non_compete_material" && expectedClauseIds.has("non_compete")) continue;
    // Skip arbitration_material if deadlock_resolution is expected (it covers dispute resolution)
    if (up.id === "arbitration_material" && expectedClauseIds.has("deadlock_resolution")) continue;

    const headingMatch = up.heading_patterns.some((hp) =>
      new RegExp(hp, "im").test(lines.join("\n"))
    );
    const patternHits = up.patterns.filter((p) => lower.includes(p.toLowerCase()));

    if (headingMatch || patternHits.length >= 2) {
      const section: UnsupportedSection = {
        heading: up.heading,
        reason: up.reason,
        review_threshold: up.review_threshold,
      };
      if (up.category === "material") {
        material.push(section);
      } else {
        boilerplate.push(section);
      }
    }
  }

  return { material, boilerplate };
}

// ── Schedule / exhibit / cross-reference detection ────────────────────────────

const EXHIBIT_RE = /\b(schedule\s+[a-z]|exhibit\s+[a-z]|annex\s+[a-z])\b/gi;
const XREF_RE    = /\b(section\s+\d+[\.\d]*|pursuant to section|as defined in section|see section)\b/gi;

function detectExhibitsAndCrossRefs(
  text: string,
): { exhibits: string[]; crossRefWarnings: CrossReferenceWarning[] } {
  const exhibits: string[] = [];
  const crossRefWarnings: CrossReferenceWarning[] = [];

  // Exhibits
  const exhibitMatches = [...text.matchAll(EXHIBIT_RE)];
  const seen = new Set<string>();
  for (const m of exhibitMatches) {
    const normalized = m[0].replace(/\s+/g, " ").toLowerCase();
    const display = m[0].replace(/\b\w/g, (c) => c.toUpperCase());
    if (!seen.has(normalized)) {
      seen.add(normalized);
      exhibits.push(display);

      // Cross-reference warning: referenced but content not present
      // Heuristic: if the exhibit name appears only once, it's referenced but not attached
      const occurrences = (text.match(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length;
      if (occurrences <= 1) {
        const idx = text.toLowerCase().indexOf(normalized);
        const context = text.slice(Math.max(0, idx - 40), idx + 60).replace(/\n/g, " ").trim();
        crossRefWarnings.push({
          reference: display,
          context: context.slice(0, 100),
          warning: `${display} is referenced but does not appear to be attached to this document.`,
        });
      }
    }
  }

  // Section cross-references (informational — no warning unless dangling)
  // We only surface these if they reference a section number > total line count / 30
  // (rough heuristic for "section that probably doesn't exist")
  const lineCount = text.split("\n").length;
  const xrefMatches = [...text.matchAll(/\bsection\s+(\d+)/gi)];
  for (const m of xrefMatches) {
    const sectionNum = parseInt(m[1], 10);
    if (sectionNum > Math.ceil(lineCount / 10)) {
      const idx = text.toLowerCase().indexOf(m[0].toLowerCase());
      const context = text.slice(Math.max(0, idx - 30), idx + 50).replace(/\n/g, " ").trim();
      const ref = `Section ${sectionNum}`;
      if (!crossRefWarnings.some((w) => w.reference === ref)) {
        crossRefWarnings.push({
          reference: ref,
          context: context.slice(0, 100),
          warning: `Section ${sectionNum} is referenced but may not exist in this document.`,
        });
      }
    }
  }

  return { exhibits, crossRefWarnings };
}

// ── Coverage threshold logic ──────────────────────────────────────────────────
// Considers: coverage_score, material_missing_clause_ids, material_unsupported_sections,
// and the incoming Lane A threshold.

function computeCoverageThreshold(
  coverageScore: number,
  materialMissingIds: string[],
  materialUnsupported: UnsupportedSection[],
): ReviewThreshold {
  // Any material missing clause → at minimum counsel_review_required
  if (materialMissingIds.length > 0) {
    return maxThreshold("counsel_review_required",
      coverageScore < 0.5 ? "blocked" : "counsel_review_required"
    );
  }

  // Material unsupported sections → counsel_review_required
  if (materialUnsupported.length > 0) {
    return maxThreshold("counsel_review_required",
      coverageScore < 0.5 ? "blocked" : "counsel_review_required"
    );
  }

  // Coverage score alone
  if (coverageScore < 0.5) return "blocked";
  if (coverageScore < 0.7) return "counsel_review_required";
  if (coverageScore < 0.9) return "business_review_required";
  return "self_review_ok";
}

// ── Material clause IDs (clauses whose absence is always material) ────────────

const MATERIAL_CLAUSE_IDS = new Set([
  "preamble",
  "ip_assignment",
  "equity_split",
  "termination_and_buyout",
  "work_made_for_hire",
  "equity_compensation",
]);

// ── Main export ───────────────────────────────────────────────────────────────

export function reviewDocumentCoverage(
  text: string,
  doc_class: DocClass,
): CoverageResult {
  const lower = text.toLowerCase();
  const lines = text.split("\n");

  const inventory = CLAUSE_INVENTORIES[doc_class] ?? [];
  const expectedClauseIds = new Set(inventory.map((c) => c.clause_id));

  // ── Detect expected clauses ───────────────────────────────────────────────
  const detectedClauses: DetectedClause[] = [];
  const missingExpected: ExpectedClause[] = [];

  for (const clause of inventory) {
    const result = detectClause(lower, lines, clause);
    if (result) {
      detectedClauses.push(result);
    } else {
      missingExpected.push(clause);
    }
  }

  // ── Coverage score (required clauses only) ────────────────────────────────
  const requiredClauses = inventory.filter((c) => c.required);
  const detectedRequiredIds = new Set(
    detectedClauses.filter((d) => d.required).map((d) => d.clause_id)
  );
  const coverageScore =
    requiredClauses.length > 0
      ? detectedRequiredIds.size / requiredClauses.length
      : 1.0;

  // ── Missing required / material clause IDs ────────────────────────────────
  const missingRequiredIds = missingExpected
    .filter((c) => c.required)
    .map((c) => c.clause_id);

  const materialMissingIds = missingRequiredIds.filter((id) =>
    MATERIAL_CLAUSE_IDS.has(id)
  );

  // ── Unsupported sections ──────────────────────────────────────────────────
  const { material: materialUnsupported, boilerplate: boilerplateUnsupported } =
    detectUnsupportedSections(lower, lines, expectedClauseIds);

  // ── Exhibits + cross-references ───────────────────────────────────────────
  const { exhibits, crossRefWarnings } = detectExhibitsAndCrossRefs(text);

  // ── Coverage threshold ────────────────────────────────────────────────────
  const coverageThreshold = computeCoverageThreshold(
    coverageScore,
    materialMissingIds,
    materialUnsupported,
  );

  // ── Coverage summary ──────────────────────────────────────────────────────
  const detectedRequired = detectedClauses.filter((d) => d.required).length;
  const totalRequired = requiredClauses.length;
  const pct = Math.round(coverageScore * 100);

  let summary: string;
  if (missingRequiredIds.length === 0 && materialUnsupported.length === 0) {
    summary = `All ${totalRequired} required clauses detected (${pct}% coverage) — no material gaps identified.`;
  } else if (materialMissingIds.length > 0) {
    summary = `${detectedRequired}/${totalRequired} required clauses detected (${pct}% coverage) — ${materialMissingIds.length} material clause(s) absent: ${materialMissingIds.join(", ")}.`;
  } else if (missingRequiredIds.length > 0) {
    summary = `${detectedRequired}/${totalRequired} required clauses detected (${pct}% coverage) — ${missingRequiredIds.length} required clause(s) not found.`;
  } else {
    summary = `${detectedRequired}/${totalRequired} required clauses detected (${pct}% coverage) — ${materialUnsupported.length} unmodeled material section(s) require review.`;
  }

  return {
    coverage_score: Math.round(coverageScore * 100) / 100,
    review_threshold: coverageThreshold,
    expected_clauses: inventory,
    detected_clauses: detectedClauses,
    missing_expected_clauses: missingExpected,
    missing_required_clause_ids: missingRequiredIds,
    material_missing_clause_ids: materialMissingIds,
    material_unsupported_sections: materialUnsupported,
    boilerplate_unsupported_sections: boilerplateUnsupported,
    cross_reference_warnings: crossRefWarnings,
    exhibits_detected: exhibits,
    coverage_summary: summary,
  };
}
