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
export { DRAFT_PROMPT_VERSION, VERIFY_PROMPT_VERSION, ACTION_POLICY_VERSION, CORPUS_VERSION };

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
