/**
 * legalActionEngine.ts — Phase 2A: Action Generation
 *
 * Provides:
 *   signReceipt()          — HMAC-SHA256 sign a MatterReceipt using SESSION_SECRET
 *   verifyReceiptToken()   — verify + decode a receipt token; returns null on tamper
 *   hashText()             — SHA-256 hex of any string
 *   draftLetter()          — generate a draft letter artifact from a verified receipt
 *   generateClausePack()   — generate a clause pack artifact from a verified receipt
 *   verifyDraft()          — two-source verification (issue list + original text)
 *   buildActionGovernance()— deterministic state machine; never model-decided
 *
 * Trust model:
 *   - Receipt tokens are HMAC-SHA256 signed with SESSION_SECRET.
 *   - The action endpoint verifies the token before consuming any issue data.
 *   - original_text is re-hashed at action time and compared to receipt.original_text_hash.
 *   - No client-supplied issue sets are accepted.
 *
 * Logging:
 *   - Every action run logs to model_usage_events with event_type "action_run".
 *   - This is a HARD-FAIL log — DB failure returns 500 (not soft-fail like matter_run).
 */

import { createHmac, createHash, randomUUID } from "crypto";
import {
  DRAFT_PROMPT_VERSION,
  VERIFY_PROMPT_VERSION,
  ACTION_POLICY_VERSION,
  CORPUS_VERSION,
  REDLINE_PROMPT_VERSION,
} from "../prompts/versions.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionType = "draft_letter" | "generate_clause_pack" | "generate_revision_plan";
export type ArtifactStatus = "draft_pending_approval" | "needs_revision" | "blocked";
export type IssueStatus = "addressed" | "partially_addressed" | "unresolved" | "human_only_blocker";

export interface MatterReceipt {
  matter_id: string;
  receipt_id: string;           // UUID nonce — unique per issuance, for future replay control
  specialist: string;
  original_text_hash: string;   // SHA-256 hex of original_text
  specialist_output: Record<string, unknown>;
  governance_decision: Record<string, unknown>;
  issued_at: string;            // ISO timestamp
  expires_at: string;           // ISO timestamp — RECEIPT_TTL_MS after issued_at
}

/**
 * ActionReceipt — server-signed record of a completed Phase 2A action run.
 * Issued by /action at the end of a successful draft_letter or generate_clause_pack run.
 * Required as input to generate_revision_plan (Phase 2B) to establish trusted provenance.
 *
 * Trust chain: MatterReceipt → ActionReceipt → RevisionPlanArtifact
 */
export interface ActionReceipt {
  matter_id: string;                   // from upstream MatterReceipt
  action_receipt_id: string;           // UUID nonce — unique per action run
  action_type: ActionType;             // "draft_letter" | "generate_clause_pack"
  artifact_status: ArtifactStatus;     // final status from Phase 2A governance
  draft_hash: string;                  // full SHA-256 hex of draft body
  verification_hash: string;           // full SHA-256 hex of JSON.stringify(VerificationResult)
  issue_resolution_map_hash: string;   // full SHA-256 hex of JSON.stringify(issueResolutionMap)
  original_text_hash: string;          // carried forward from MatterReceipt for lineage check
  draft_prompt_version: string;
  verification_prompt_version: string;
  policy_version: string;
  issued_at: string;                   // ISO timestamp
  expires_at: string;                  // ISO timestamp — same TTL as matter receipt
}

export interface IssueResolution {
  issue_id: string;
  issue_source: "blocking_issue" | "risk_flag";
  status: IssueStatus;
  evidence: string;
}

export interface VerificationResult {
  passed: boolean;
  unresolved_issues: string[];
  partially_addressed_issues: string[];
  new_risks_detected: string[];
  human_only_blockers: string[];
  contradiction_notes: string[];
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}

export interface ActionGovernance {
  artifact_status: ArtifactStatus;
  impact_tier: "decision_support" | "action_triggering";
  approval_required: true;
  escalation_required: boolean;
  human_review_required: true;
  not_legal_advice: true;
  privilege_warning: string;
}

export interface DraftLetterArtifact {
  title: string;
  body: string;
  placeholders: string[];
}

export interface ClausePackArtifact {
  clauses: Array<{
    clause_id: string;
    issue_id: string;
    title: string;
    body: string;
    source: "generated" | "template_only";
    note?: string;
  }>;
}

export interface ActionInput {
  receipt: MatterReceipt;
  originalText: string;
  actionType: ActionType;
  userInstruction?: string;
  callModelWithFallback: (
    systemPrompt: string,
    userContent: string,
    title: string,
    maxTokens: number,
    chain: unknown[],
  ) => Promise<{ parsed: any; model_used: string; fallback_used: boolean; latency_ms: number }>;
  modelChain: unknown[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Receipt validity window: 4 hours. Balances usability (long analysis sessions)
 *  against replay risk. Adjust via RECEIPT_TTL_HOURS env var if needed. */
const RECEIPT_TTL_MS = (parseInt(process.env.RECEIPT_TTL_HOURS ?? "4", 10) || 4) * 60 * 60 * 1000;

// Version constants are imported from ../prompts/versions.ts — the single source
// of truth. Re-exported here so callers that import from legalActionEngine.ts
// continue to work without changes.
export { DRAFT_PROMPT_VERSION, VERIFY_PROMPT_VERSION, ACTION_POLICY_VERSION, CORPUS_VERSION, REDLINE_PROMPT_VERSION };

const PRIVILEGE_WARNING =
  "This output is not legal advice. It is a draft artifact for attorney review only. " +
  "It must not be sent, filed, or relied upon without review and approval by licensed counsel.";

const MAX_LETTER_BODY_CHARS = 4000;
const MAX_CLAUSE_COUNT = 10;
const MAX_PLACEHOLDER_COUNT = 20;

// ── HMAC receipt signing ──────────────────────────────────────────────────────

/**
 * Sign a MatterReceipt with HMAC-SHA256 using the provided secret.
 * Returns a base64-encoded JSON envelope: { payload: string, sig: string }
 */
export function signReceipt(receipt: MatterReceipt, secret: string): string {
  const payload = JSON.stringify(receipt);
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64");
}

/**
 * Verify a receipt token. Returns the decoded MatterReceipt on success, null on tamper/malform.
 */
export function verifyReceiptToken(token: string, secret: string): MatterReceipt | null {
  try {
    const envelope = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as {
      payload: string;
      sig: string;
    };
    if (!envelope.payload || !envelope.sig) return null;

    const expectedSig = createHmac("sha256", secret).update(envelope.payload).digest("hex");
    // Constant-time comparison to prevent timing attacks
    if (envelope.sig.length !== expectedSig.length) return null;
    let diff = 0;
    for (let i = 0; i < expectedSig.length; i++) {
      diff |= envelope.sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }
    if (diff !== 0) return null;

    const decoded = JSON.parse(envelope.payload) as MatterReceipt;

    // Expiry enforcement — reject tokens past their validity window
    if (!decoded.expires_at) return null;
    if (Date.now() > new Date(decoded.expires_at).getTime()) return null;

    return decoded;
  } catch {
    return null;
  }
}

/**
 * SHA-256 hex of any string. Used for original_text_hash and draft/verification hashes.
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Sign an ActionReceipt with HMAC-SHA256 using the provided secret.
 * Returns a base64-encoded JSON envelope: { payload: string, sig: string }
 * Same envelope format as signReceipt() — verifiable with the same constant-time check.
 */
export function signActionReceipt(receipt: ActionReceipt, secret: string): string {
  const payload = JSON.stringify(receipt);
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64");
}

/**
 * Verify an action receipt token. Returns the decoded ActionReceipt on success, null on tamper/malform/expiry.
 */
export function verifyActionReceiptToken(token: string, secret: string): ActionReceipt | null {
  try {
    const envelope = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as {
      payload: string;
      sig: string;
    };
    if (!envelope.payload || !envelope.sig) return null;

    const expectedSig = createHmac("sha256", secret).update(envelope.payload).digest("hex");
    // Constant-time comparison to prevent timing attacks
    if (envelope.sig.length !== expectedSig.length) return null;
    let diff = 0;
    for (let i = 0; i < expectedSig.length; i++) {
      diff |= envelope.sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }
    if (diff !== 0) return null;

    const decoded = JSON.parse(envelope.payload) as ActionReceipt;

    // Expiry enforcement
    if (!decoded.expires_at) return null;
    if (Date.now() > new Date(decoded.expires_at).getTime()) return null;

    return decoded;
  } catch {
    return null;
  }
}

// ── Issue extraction helpers ──────────────────────────────────────────────────

interface NormalizedIssue {
  id: string;
  source: "blocking_issue" | "risk_flag";
  description: string;
  risk_level?: string;
}

function extractIssues(specialistOutput: Record<string, unknown>): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];

  // blocking_issues — always included
  const blocking = specialistOutput.blocking_issues as Array<any> | undefined;
  if (Array.isArray(blocking)) {
    for (const b of blocking) {
      const id = typeof b === "string"
        ? b.toUpperCase().replace(/\s+/g, "_").slice(0, 60)
        : (b.id ?? b.issue ?? String(b)).toUpperCase().replace(/\s+/g, "_").slice(0, 60);
      const desc = typeof b === "string" ? b : (b.description ?? b.issue ?? String(b));
      issues.push({ id, source: "blocking_issue", description: desc });
    }
  }

  // risk_flags — only high/critical
  const flags = specialistOutput.risk_flags as Array<any> | undefined;
  if (Array.isArray(flags)) {
    for (const f of flags) {
      const level: string = (f.risk_level ?? f.severity ?? "").toLowerCase();
      if (level !== "high" && level !== "critical") continue;
      const id = (f.id ?? f.flag ?? f.issue ?? String(f)).toUpperCase().replace(/\s+/g, "_").slice(0, 60);
      const desc = f.description ?? f.issue ?? String(f);
      issues.push({ id, source: "risk_flag", description: desc, risk_level: level });
    }
  }

  return issues;
}

// ── Draft letter ──────────────────────────────────────────────────────────────

export async function draftLetter(input: ActionInput): Promise<{
  artifact: DraftLetterArtifact;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const issues = extractIssues(input.receipt.specialist_output);
  const issueList = issues
    .map((i, idx) => `${idx + 1}. [${i.source.toUpperCase()}] ${i.id}: ${i.description}`)
    .join("\n");

  const systemPrompt = `You are a legal document drafter. You produce draft letters for attorney review only.

RULES:
1. Address every issue in the ISSUE LIST below. For each issue, either:
   a. Draft specific language that addresses it, OR
   b. Mark it as [HUMAN_ONLY_BLOCKER: <reason>] if it cannot be addressed by a letter.
2. Never silently omit an issue.
3. Use [PLACEHOLDER: description] wherever a specific name, date, number, or fact is needed but not present in the source text.
4. Do not cite statutes, cases, or legal rules not already referenced in the issue list.
5. Do not invent specific facts (names, dates, amounts). Use placeholders instead.
6. Keep the letter under ${MAX_LETTER_BODY_CHARS} characters.
7. The letter is a DRAFT for attorney review. Include a header: "DRAFT — FOR ATTORNEY REVIEW ONLY — NOT LEGAL ADVICE"

ISSUE LIST:
${issueList}

${input.userInstruction ? `ADDITIONAL INSTRUCTION FROM USER (max 500 chars): ${input.userInstruction.slice(0, 500)}` : ""}

Respond with valid JSON only:
{
  "title": "string — descriptive letter title",
  "body": "string — full letter body",
  "placeholders": ["array of placeholder strings used, e.g. [PLACEHOLDER: Company Name]"]
}`;

  const userContent = `SOURCE TEXT:\n${input.originalText}`;

  const result = await input.callModelWithFallback(
    systemPrompt,
    userContent,
    "OpenClaw Draft Letter",
    1200,
    input.modelChain,
  );

  const parsed = result.parsed ?? {};
  const body: string = typeof parsed.body === "string" ? parsed.body : "";
  const title: string = typeof parsed.title === "string" ? parsed.title : "Draft Letter";
  const placeholders: string[] = Array.isArray(parsed.placeholders)
    ? parsed.placeholders.filter((p: unknown) => typeof p === "string")
    : [];

  return {
    artifact: { title, body, placeholders },
    model_used: result.model_used,
    fallback_used: result.fallback_used,
    latency_ms: result.latency_ms,
  };
}

// ── Clause pack ───────────────────────────────────────────────────────────────

export async function generateClausePack(input: ActionInput): Promise<{
  artifact: ClausePackArtifact;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const issues = extractIssues(input.receipt.specialist_output);
  const issueList = issues
    .map((i, idx) => `${idx + 1}. [${i.source.toUpperCase()}] ${i.id}: ${i.description}`)
    .join("\n");

  const systemPrompt = `You are a legal clause drafter. You produce clause packs for attorney review only.

RULES:
1. For each REMEDIABLE issue in the ISSUE LIST, produce one clause entry.
   REMEDIABLE = can be addressed by inserting or replacing contract language.
   NON-REMEDIABLE = requires attorney action, court filing, IRS election, or facts not in the source text.
2. For NON-REMEDIABLE issues, produce a clause entry with source "human_only" and a note explaining why.
3. Never silently omit an issue. Every issue must appear in the output.
4. Use [PLACEHOLDER: description] wherever a specific name, date, or number is needed but not present.
5. Do not cite statutes or cases not already referenced in the issue list.
6. Maximum ${MAX_CLAUSE_COUNT} clauses. If more issues exist, prioritize blocking_issues first, then high/critical risk flags.
7. Each clause must be specific to the source text context (governing law, party structure, clause type).
   If a clause cannot be made specific, set source to "template_only" and add a note.

ISSUE LIST:
${issueList}

${input.userInstruction ? `ADDITIONAL INSTRUCTION FROM USER (max 500 chars): ${input.userInstruction.slice(0, 500)}` : ""}

Respond with valid JSON only:
{
  "clauses": [
    {
      "clause_id": "string — short unique id, e.g. CL-001",
      "issue_id": "string — matches issue id from list above",
      "title": "string — clause title",
      "body": "string — full clause text",
      "source": "generated | template_only | human_only",
      "note": "string (optional) — explanation for template_only or human_only"
    }
  ]
}`;

  const userContent = `SOURCE TEXT:\n${input.originalText}`;

  const result = await input.callModelWithFallback(
    systemPrompt,
    userContent,
    "OpenClaw Clause Pack",
    1500,
    input.modelChain,
  );

  const parsed = result.parsed ?? {};
  let clauses: ClausePackArtifact["clauses"] = Array.isArray(parsed.clauses)
    ? parsed.clauses
        .filter((c: any) => typeof c === "object" && c !== null)
        .map((c: any, idx: number) => ({
          clause_id: typeof c.clause_id === "string" ? c.clause_id : `CL-${String(idx + 1).padStart(3, "0")}`,
          issue_id: typeof c.issue_id === "string" ? c.issue_id : "UNKNOWN",
          title: typeof c.title === "string" ? c.title : "Untitled Clause",
          body: typeof c.body === "string" ? c.body : "",
          source: (["generated", "template_only", "human_only"].includes(c.source) ? c.source : "generated") as "generated" | "template_only",
          note: typeof c.note === "string" ? c.note : undefined,
        }))
    : [];

  // Enforce max clause count — truncate, log in trace
  if (clauses.length > MAX_CLAUSE_COUNT) {
    clauses = clauses.slice(0, MAX_CLAUSE_COUNT);
  }

  return {
    artifact: { clauses },
    model_used: result.model_used,
    fallback_used: result.fallback_used,
    latency_ms: result.latency_ms,
  };
}

// ── Verification (two-source) ─────────────────────────────────────────────────

export async function verifyDraft(
  draft: string,
  originalText: string,
  issues: NormalizedIssue[],
  actionType: ActionType,
  callModelWithFallback: ActionInput["callModelWithFallback"],
  modelChain: unknown[],
): Promise<VerificationResult> {
  const issueList = issues
    .map((i, idx) => `${idx + 1}. [${i.source.toUpperCase()}] ${i.id}: ${i.description}`)
    .join("\n");

  const systemPrompt = `You are a legal document verifier. You check draft artifacts for completeness, accuracy, and safety.

You are given:
1. A draft artifact (letter or clause pack)
2. The original source text (contract/agreement)
3. An issue list (blocking issues + high/critical risk flags) from prior analysis

CHECK 1 — Issue coverage:
For each issue in the issue list, determine:
- "addressed": draft explicitly addresses this issue with specific language
- "partially_addressed": draft mentions the issue but does not fully resolve it
- "unresolved": draft does not address this issue at all
- "human_only_blocker": this issue cannot be addressed by a draft artifact (requires attorney action, court filing, etc.)

CHECK 2 — No contradiction with original text:
Does the draft contradict any clause or fact in the original source text?
(e.g., draft says "30-day notice" but original says "60-day notice")
List any contradictions.

CHECK 3 — No unsupported legal claims:
Does the draft cite statutes, cases, or legal rules NOT already referenced in the issue list?
List any unsupported citations.

CHECK 4 — Placeholder discipline:
Does the draft invent specific facts (names, dates, amounts) that are not in the source text?
(Invented facts without a [PLACEHOLDER] marker are a risk.)
List any invented facts.

${actionType === "generate_clause_pack" ? `CHECK 5 — Clause usability:
For each clause, is it specific enough to be usable in context (not a generic template)?
List any clauses that are too generic.` : ""}

ISSUE LIST:
${issueList}

Respond with valid JSON only:
{
  "issue_coverage": [
    { "issue_id": "string", "status": "addressed|partially_addressed|unresolved|human_only_blocker", "evidence": "string" }
  ],
  "contradictions": ["string — describe each contradiction"],
  "unsupported_citations": ["string — describe each unsupported citation"],
  "invented_facts": ["string — describe each invented fact without placeholder"],
  "generic_clauses": ["string — clause_id of each overly generic clause (clause pack only)"],
  "passed": true|false
}

Set "passed" to true only if:
- All issues are "addressed" or "human_only_blocker" (none "unresolved")
- No contradictions
- No unsupported citations
- No invented facts`;

  const userContent = `DRAFT ARTIFACT:\n${draft}\n\n---\n\nORIGINAL SOURCE TEXT:\n${originalText}`;

  const result = await callModelWithFallback(
    systemPrompt,
    userContent,
    "OpenClaw Draft Verifier",
    1200,
    modelChain,
  );

  const parsed = result.parsed ?? {};

  // Extract structured results
  const coverage: Array<{ issue_id: string; status: string; evidence: string }> =
    Array.isArray(parsed.issue_coverage) ? parsed.issue_coverage : [];

  const unresolved = coverage
    .filter((c) => c.status === "unresolved")
    .map((c) => c.issue_id);

  const partiallyAddressed = coverage
    .filter((c) => c.status === "partially_addressed")
    .map((c) => c.issue_id);

  const humanOnly = coverage
    .filter((c) => c.status === "human_only_blocker")
    .map((c) => c.issue_id);

  const contradictions: string[] = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  const unsupportedCitations: string[] = Array.isArray(parsed.unsupported_citations) ? parsed.unsupported_citations : [];
  const inventedFacts: string[] = Array.isArray(parsed.invented_facts) ? parsed.invented_facts : [];
  const genericClauses: string[] = Array.isArray(parsed.generic_clauses) ? parsed.generic_clauses : [];

  const newRisks: string[] = [
    ...contradictions.map((c) => `contradiction: ${c}`),
    ...unsupportedCitations.map((c) => `unsupported_citation: ${c}`),
    ...inventedFacts.map((f) => `invented_fact: ${f}`),
    ...genericClauses.map((g) => `generic_clause: ${g}`),
  ];

  // passed is deterministic — model's "passed" field is advisory only
  const passed =
    unresolved.length === 0 &&
    contradictions.length === 0 &&
    unsupportedCitations.length === 0 &&
    inventedFacts.length === 0;

  return {
    passed,
    unresolved_issues: unresolved,
    partially_addressed_issues: partiallyAddressed,
    new_risks_detected: newRisks,
    human_only_blockers: humanOnly,
    contradiction_notes: contradictions,
    model_used: result.model_used,
    fallback_used: result.fallback_used,
    latency_ms: result.latency_ms,
  };
}

// ── Issue resolution map builder ──────────────────────────────────────────────

export function buildIssueResolutionMap(
  issues: NormalizedIssue[],
  verificationCoverage: Array<{ issue_id: string; status: string; evidence: string }>,
): IssueResolution[] {
  return issues.map((issue) => {
    const coverage = verificationCoverage.find(
      (c) => c.issue_id === issue.id || c.issue_id.toUpperCase() === issue.id.toUpperCase(),
    );
    const status: IssueStatus = coverage
      ? (["addressed", "partially_addressed", "unresolved", "human_only_blocker"].includes(coverage.status)
          ? (coverage.status as IssueStatus)
          : "unresolved")
      : "unresolved";
    return {
      issue_id: issue.id,
      issue_source: issue.source,
      status,
      evidence: coverage?.evidence ?? "Not evaluated by verifier",
    };
  });
}

// ── Governance state machine ──────────────────────────────────────────────────

/**
 * Deterministic state machine. Never model-decided.
 *
 * Priority order:
 *   1. privilege_detected → blocked
 *   2. human_only_blockers.length > 0 → blocked
 *   3. verification.passed === false → needs_revision
 *   4. verification.passed === true, no blockers → draft_pending_approval
 */
export function buildActionGovernance(
  verification: VerificationResult,
  actionType: ActionType,
  privilegeDetected: boolean,
): ActionGovernance {
  let artifactStatus: ArtifactStatus;
  let escalationRequired: boolean;

  if (privilegeDetected || verification.human_only_blockers.length > 0) {
    artifactStatus = "blocked";
    escalationRequired = true;
  } else if (!verification.passed) {
    artifactStatus = "needs_revision";
    escalationRequired = true;
  } else {
    artifactStatus = "draft_pending_approval";
    escalationRequired = false;
  }

  return {
    artifact_status: artifactStatus,
    impact_tier: actionType === "generate_clause_pack" ? "action_triggering" : "decision_support",
    approval_required: true,
    escalation_required: escalationRequired,
    human_review_required: true,
    not_legal_advice: true,
    privilege_warning: PRIVILEGE_WARNING,
  };
}

// ── Internal helper: extract issues (re-exported for route use) ───────────────
export { extractIssues };
export type { NormalizedIssue };

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2B: generate_revision_plan
//
// Semantics: a structured plan of proposed edits derived from verified issues
// and the original source text. NOT a diff against the prior Phase 2A draft —
// the server does not have the prior draft body, only its hash. The name
// "revision plan" is intentionally honest about this constraint.
//
// Trust chain: MatterReceipt → ActionReceipt → RevisionPlanArtifact
// The ActionReceipt (from Commit C) is the trust anchor. The route verifies
// both tokens and confirms lineage before any model call.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Phase 2B types ────────────────────────────────────────────────────────────

export type RevisionEditType = "insert" | "replace" | "delete" | "flag_for_attorney";

export interface RevisionEdit {
  issue_id: string;
  issue_status: IssueStatus;       // from Phase 2A issue_resolution_map
  edit_type: RevisionEditType;
  location_hint: string;           // e.g. "paragraph 3, sentence 2" or "equity clause"
  proposed_text: string;           // new language to insert or replace with; "" for delete
  rationale: string;               // why this edit addresses the issue
  requires_attorney: boolean;      // true iff edit_type === "flag_for_attorney"
}

export interface RevisionPlanArtifact {
  summary: string;                 // 1–3 sentence plain-language summary of proposed changes
  edits: RevisionEdit[];
  unaddressable_issues: string[];  // issue_ids with human_only_blocker status — no edit generated
  total_edits: number;
}

export interface RevisionVerificationResult {
  passed: boolean;
  missing_edits: string[];         // issue_ids (unresolved/partially_addressed) with no edit
  invented_facts: string[];        // edits that introduce facts not in original text
  misrouted_blockers: string[];    // human_only_blocker issues that appeared in edits (not unaddressable)
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}

export interface RevisionActionInput {
  matterReceipt: MatterReceipt;
  actionReceipt: ActionReceipt;
  originalText: string;
  userInstruction?: string;
  callModelWithFallback: (
    systemPrompt: string,
    userContent: string,
    title: string,
    maxTokens: number,
    chain: unknown[],
  ) => Promise<{ parsed: any; model_used: string; fallback_used: boolean; latency_ms: number }>;
  modelChain: unknown[];
}

// ── generateRevisionPlan ──────────────────────────────────────────────────────

/**
 * Generate a structured revision plan from verified Phase 2A artifacts.
 *
 * The model receives:
 *   - The original source text (re-verified against ActionReceipt.original_text_hash)
 *   - The list of unresolved/partially_addressed issues from Phase 2A
 *   - The artifact_status from Phase 2A (context for severity)
 *
 * The model does NOT receive the prior draft body — only its hash is in the
 * ActionReceipt. Edits are generated from first principles against the source
 * text and issue list, not as a diff of the prior draft.
 */
export async function generateRevisionPlan(input: RevisionActionInput): Promise<{
  artifact: RevisionPlanArtifact;
  model_used: string;
  fallback_used: boolean;
  latency_ms: number;
}> {
  const issues = extractIssues(input.matterReceipt.specialist_output);

  // Separate issues by Phase 2A status (from ActionReceipt metadata context).
  // We re-extract from specialist_output because the ActionReceipt carries only
  // the hash of the issue_resolution_map, not its content. The specialist_output
  // is trusted (it's inside the signed MatterReceipt).
  // The revision plan targets unresolved and partially_addressed issues.
  // human_only_blocker issues go into unaddressable_issues.
  const actionableIssues = issues.filter((i) =>
    // We don't know per-issue status from the ActionReceipt alone (only the map hash).
    // Generate edits for all issues; the verifier will flag misrouted blockers.
    // This is conservative: better to generate an edit the verifier rejects than
    // to silently omit an issue.
    true,
  );

  const issueList = actionableIssues
    .map((i, idx) => `${idx + 1}. [${i.source.toUpperCase()}] ${i.id}: ${i.description}`)
    .join("\n");

  const systemPrompt = `You are a legal revision planner. You produce structured revision plans for attorney review only.

A prior analysis identified issues in a legal document. A draft artifact was generated and verified (Phase 2A).
Your task is to produce a structured plan of proposed edits to address the identified issues.

IMPORTANT CONSTRAINTS:
1. You do NOT have the prior draft. Generate edits based on the ORIGINAL SOURCE TEXT and ISSUE LIST below.
2. For each issue, produce one RevisionEdit entry.
3. If an issue CANNOT be addressed by a document edit (requires attorney action, court filing, regulatory approval, etc.),
   set edit_type to "flag_for_attorney" and add the issue_id to unaddressable_issues.
4. Do NOT invent specific facts (names, dates, amounts, entity names) not present in the source text.
   Use descriptive placeholders like "[INSERT: vesting schedule terms]" instead.
5. location_hint should reference the relevant section of the source text (e.g. "equity clause", "termination section").
6. proposed_text should be specific, actionable language — not generic boilerplate.
7. The plan is for attorney review. Include only edits you can ground in the source text and issue list.

ARTIFACT STATUS FROM PRIOR ANALYSIS: ${input.actionReceipt.artifact_status}
(draft_pending_approval = clean pass; needs_revision = unresolved issues; blocked = human-only blockers present)

ISSUE LIST:
${issueList}

${input.userInstruction ? `ADDITIONAL INSTRUCTION FROM USER (max 500 chars): ${input.userInstruction.slice(0, 500)}` : ""}

Respond with valid JSON only:
{
  "summary": "string — 1-3 sentence plain-language summary of proposed changes",
  "edits": [
    {
      "issue_id": "string",
      "issue_status": "unresolved|partially_addressed|addressed|human_only_blocker",
      "edit_type": "insert|replace|delete|flag_for_attorney",
      "location_hint": "string — where in the document this edit applies",
      "proposed_text": "string — new language (empty string for delete or flag_for_attorney)",
      "rationale": "string — why this edit addresses the issue",
      "requires_attorney": true|false
    }
  ],
  "unaddressable_issues": ["issue_id — issues that require attorney action, not document edits"]
}`;

  const userContent = `ORIGINAL SOURCE TEXT:\n${input.originalText}`;

  const result = await input.callModelWithFallback(
    systemPrompt,
    userContent,
    "OpenClaw Revision Plan",
    1400,
    input.modelChain,
  );

  const parsed = result.parsed ?? {};
  const summary: string = typeof parsed.summary === "string" ? parsed.summary : "Revision plan generated.";
  const rawEdits: unknown[] = Array.isArray(parsed.edits) ? parsed.edits : [];
  const unaddressable: string[] = Array.isArray(parsed.unaddressable_issues)
    ? parsed.unaddressable_issues.filter((x: unknown) => typeof x === "string")
    : [];

  const edits: RevisionEdit[] = rawEdits
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      issue_id: typeof e.issue_id === "string" ? e.issue_id : "UNKNOWN",
      issue_status: (["addressed", "partially_addressed", "unresolved", "human_only_blocker"].includes(e.issue_status as string)
        ? e.issue_status
        : "unresolved") as IssueStatus,
      edit_type: (["insert", "replace", "delete", "flag_for_attorney"].includes(e.edit_type as string)
        ? e.edit_type
        : "flag_for_attorney") as RevisionEditType,
      location_hint: typeof e.location_hint === "string" ? e.location_hint : "",
      proposed_text: typeof e.proposed_text === "string" ? e.proposed_text : "",
      rationale: typeof e.rationale === "string" ? e.rationale : "",
      requires_attorney: e.edit_type === "flag_for_attorney" || e.requires_attorney === true,
    }));

  return {
    artifact: {
      summary,
      edits,
      unaddressable_issues: unaddressable,
      total_edits: edits.length,
    },
    model_used: result.model_used,
    fallback_used: result.fallback_used,
    latency_ms: result.latency_ms,
  };
}

// ── verifyRevisionPlan ────────────────────────────────────────────────────────

/**
 * Verify a revision plan artifact. Distinct contract from verifyDraft().
 *
 * Checks:
 *   1. Every issue has a corresponding edit OR appears in unaddressable_issues.
 *   2. No edit introduces facts not present in the original text.
 *   3. human_only_blocker issues appear in unaddressable_issues, not in edits.
 *
 * Does NOT check prose coverage (that's verifyDraft's job).
 * Does NOT check contradictions with a prior draft (no prior draft available).
 */
export async function verifyRevisionPlan(
  artifact: RevisionPlanArtifact,
  originalText: string,
  issues: NormalizedIssue[],
  callModelWithFallback: RevisionActionInput["callModelWithFallback"],
  modelChain: unknown[],
): Promise<RevisionVerificationResult> {
  const editIssueIds = new Set(artifact.edits.map((e) => e.issue_id));
  const unaddressableSet = new Set(artifact.unaddressable_issues);

  // Structural check (no model needed): every issue must be in edits OR unaddressable
  const missingEdits: string[] = issues
    .filter((i) => !editIssueIds.has(i.id) && !unaddressableSet.has(i.id))
    .map((i) => i.id);

  // Structural check: flag_for_attorney edits should be in unaddressable_issues
  const misroutedBlockers: string[] = artifact.edits
    .filter((e) => e.edit_type === "flag_for_attorney" && !unaddressableSet.has(e.issue_id))
    .map((e) => e.issue_id);

  // Model check: invented facts in proposed_text
  const editSummary = artifact.edits
    .filter((e) => e.proposed_text.length > 0)
    .map((e, idx) => `${idx + 1}. [${e.issue_id}] ${e.edit_type} at "${e.location_hint}": ${e.proposed_text.slice(0, 200)}`)
    .join("\n");

  let inventedFacts: string[] = [];
  let modelUsed = "structural-only";
  let fallbackUsed = false;
  let latencyMs = 0;

  if (editSummary.length > 0) {
    const systemPrompt = `You are a legal document verifier checking a revision plan for invented facts.

A revision plan proposes edits to a legal document. Your task:
For each proposed edit, check whether it introduces specific facts (names, dates, amounts, entity names, jurisdiction-specific rules)
that are NOT present in the original source text.

Respond with valid JSON only:
{
  "invented_facts": ["string — describe each invented fact with the issue_id it came from"]
}

If no invented facts are found, return: { "invented_facts": [] }`;

    const userContent = `PROPOSED EDITS:\n${editSummary}\n\n---\n\nORIGINAL SOURCE TEXT:\n${originalText}`;

    const t0 = Date.now();
    const result = await callModelWithFallback(
      systemPrompt,
      userContent,
      "OpenClaw Revision Verifier",
      400,
      modelChain,
    );
    latencyMs = Date.now() - t0;
    modelUsed = result.model_used;
    fallbackUsed = result.fallback_used;

    const parsed = result.parsed ?? {};
    inventedFacts = Array.isArray(parsed.invented_facts)
      ? parsed.invented_facts.filter((x: unknown) => typeof x === "string")
      : [];
  }

  const passed =
    missingEdits.length === 0 &&
    misroutedBlockers.length === 0 &&
    inventedFacts.length === 0;

  return {
    passed,
    missing_edits: missingEdits,
    invented_facts: inventedFacts,
    misrouted_blockers: misroutedBlockers,
    model_used: modelUsed,
    fallback_used: fallbackUsed,
    latency_ms: latencyMs,
  };
}

// ── Governance for revision plan ──────────────────────────────────────────────

/**
 * Governance state machine for revision plans.
 * Same priority order as buildActionGovernance, adapted for RevisionVerificationResult.
 */
export function buildRevisionGovernance(
  verification: RevisionVerificationResult,
  privilegeDetected: boolean,
): ActionGovernance {
  let artifactStatus: ArtifactStatus;
  let escalationRequired: boolean;

  if (privilegeDetected || verification.misrouted_blockers.length > 0) {
    artifactStatus = "blocked";
    escalationRequired = true;
  } else if (!verification.passed) {
    artifactStatus = "needs_revision";
    escalationRequired = true;
  } else {
    artifactStatus = "draft_pending_approval";
    escalationRequired = false;
  }

  return {
    artifact_status: artifactStatus,
    impact_tier: "action_triggering",  // revision plans always action_triggering
    approval_required: true,
    escalation_required: escalationRequired,
    human_review_required: true,
    not_legal_advice: true,
    privilege_warning: PRIVILEGE_WARNING,
  };
}
