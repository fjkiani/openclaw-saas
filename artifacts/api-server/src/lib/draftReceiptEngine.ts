import crypto from "crypto";

// ── Doc classes ───────────────────────────────────────────────────────────────
export type DocClass =
  | "co_founder_agreement"
  | "contractor_ip_assignment"
  | "advisor_agreement";

// ── Artifact status ───────────────────────────────────────────────────────────
export type ArtifactStatus =
  | "draft_pending_approval"
  | "needs_revision"
  | "blocked";

// ── ReviewThreshold (v0.5) ────────────────────────────────────────────────────
// Exported from this shared type hub so all files import from one place.
// Aggregate rule: blocked > counsel_review_required > business_review_required > self_review_ok
export type ReviewThreshold =
  | "self_review_ok"
  | "business_review_required"
  | "counsel_review_required"
  | "blocked";

// ── Intake ────────────────────────────────────────────────────────────────────
// DraftIntake is the INTERNAL trusted type — used after the route handler
// has validated and coerced the raw request body.
// allow_model_clause_rewrite is locked to false | undefined here.
export interface DraftIntake {
  doc_class: DocClass;
  jurisdiction: string;
  parties: Array<{ name: string; role: string; entity_type?: string }>;
  effective_date?: string;
  equity?: {
    split?: Record<string, number>;
    vesting_years?: number;
    cliff_months?: number;
    acceleration?: "single" | "double" | "none";
  };
  ip?: {
    prior_inventions?: string[];
    scope?: "broad" | "work_product_only";
  };
  advisory?: {
    equity_pct?: number;
    services_description?: string;
    cash_fee?: number;
  };
  user_instruction?: string;
}

/** Raw POST body — allows the rewrite flag before coercion to DraftIntake. */
export type DraftRequestBody = DraftIntake & {
  allow_model_clause_rewrite?: boolean;
};

// ── Verifier flag types ───────────────────────────────────────────────────────
// review_threshold is optional on all flag interfaces (v0.5 addition — backward-compatible)
export interface MissingDataFlag {
  field: string;
  impact: string;
  review_threshold?: ReviewThreshold;   // v0.5
}

export interface LegalConflictFlag {
  conflict_id: string;
  description: string;
  sections_involved: string[];
  severity: "blocking" | "warning";
  review_threshold?: ReviewThreshold;   // v0.5
}

export interface TemplateFailureFlag {
  failure_id: string;
  section: string;
  detail: string;
  severity: "blocking" | "warning";
  review_threshold?: ReviewThreshold;   // v0.5
}

export interface JurisdictionFlag {
  flag_id: string;
  jurisdiction: string;
  section: string;
  description: string;
  severity: "blocking" | "warning";
  recommended_action: string;
  review_threshold?: ReviewThreshold;   // v0.5
}

export interface VerifierResult {
  passed: boolean;
  missing_data: MissingDataFlag[];
  legal_conflicts: LegalConflictFlag[];
  template_failures: TemplateFailureFlag[];
  jurisdiction_escalations: JurisdictionFlag[];
}

// ── SectionRationale (v0.5) ───────────────────────────────────────────────────
// Defined here alongside DraftSection to avoid a circular import.
// draftEngine.ts imports this type and re-exports it for convenience.
export interface SectionRationale {
  selection_reason: string;
  condition_matched: string;
  jurisdiction_note_applied: string | null;   // null = no note; never ""
  review_threshold: ReviewThreshold;
  assumptions_applied: string[];
}

// ── DraftSection ──────────────────────────────────────────────────────────────
// rationale is optional (v0.5 addition — backward-compatible)
export interface DraftSection {
  section_id: string;
  title: string;
  body: string;
  variant_used?: string;
  rationale?: SectionRationale;   // v0.5 — optional
}

// ── Receipt ───────────────────────────────────────────────────────────────────
export interface DraftReceipt {
  receipt_id: string;
  draft_id: string;
  doc_class: DocClass;
  draft_hash: string;
  intake_hash: string;
  template_version: string;
  clause_library_version: string;
  verifier_version: string;
  governance_artifact_status: ArtifactStatus;
  issued_at: string;
  expires_at: string;
  parent_receipt_id: string | null;
}

// ── Stored artifact ───────────────────────────────────────────────────────────
export interface StoredDraftArtifact {
  draft_id: string;
  parent_draft_id: string | null;
  receipt_id: string;
  doc_class: DocClass;
  intake: DraftIntake;
  sections: DraftSection[];
  full_text: string;
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  verifier_result: VerifierResult;
  governance_artifact_status: ArtifactStatus;
  revision_number: number;
  created_at: string;
}

// ── Artifact store ────────────────────────────────────────────────────────────
export interface IDraftArtifactStore {
  put(artifact: StoredDraftArtifact): void;
  get(draft_id: string): StoredDraftArtifact | undefined;
}

class InProcessDraftArtifactStore implements IDraftArtifactStore {
  private readonly store = new Map<string, StoredDraftArtifact>();
  put(artifact: StoredDraftArtifact): void {
    this.store.set(artifact.draft_id, artifact);
  }
  get(draft_id: string): StoredDraftArtifact | undefined {
    return this.store.get(draft_id);
  }
}

// Module-level singleton — same instance for the lifetime of the process
export const DraftArtifactStore: IDraftArtifactStore = new InProcessDraftArtifactStore();

// ── Helpers ───────────────────────────────────────────────────────────────────
export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// ── Receipt TTL ───────────────────────────────────────────────────────────────
const RECEIPT_TTL_HOURS = 4;

// ── issueDraftReceipt ─────────────────────────────────────────────────────────
// Single opts object — NOT two positional arguments
export function issueDraftReceipt(opts: {
  draft_id: string;
  doc_class: DocClass;
  full_text: string;
  intake: DraftIntake;
  template_version: string;
  clause_library_version: string;
  verifier_version: string;
  governance_artifact_status: ArtifactStatus;
  parent_receipt_id: string | null;
  secret: string;
}): string {
  const now = new Date();
  const receipt: DraftReceipt = {
    receipt_id: crypto.randomUUID(),
    draft_id: opts.draft_id,
    doc_class: opts.doc_class,
    draft_hash: hashText(opts.full_text),
    intake_hash: hashText(JSON.stringify(opts.intake)),
    template_version: opts.template_version,
    clause_library_version: opts.clause_library_version,
    verifier_version: opts.verifier_version,
    governance_artifact_status: opts.governance_artifact_status,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RECEIPT_TTL_HOURS * 3600 * 1000).toISOString(),
    parent_receipt_id: opts.parent_receipt_id,
  };
  const payload = JSON.stringify(receipt);
  const sig = signPayload(payload, opts.secret);
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64");
}

// ── verifyDraftReceipt ────────────────────────────────────────────────────────
export function verifyDraftReceipt(
  token: string,
  secret: string,
): { valid: true; receipt: DraftReceipt } | { valid: false; reason: string } {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as {
      payload: string;
      sig: string;
    };
    const expected = signPayload(decoded.payload, secret);
    if (!safeEqual(expected, decoded.sig)) {
      return { valid: false, reason: "signature_mismatch" };
    }
    const receipt = JSON.parse(decoded.payload) as DraftReceipt;
    if (new Date(receipt.expires_at) < new Date()) {
      return { valid: false, reason: "expired" };
    }
    return { valid: true, receipt };
  } catch {
    return { valid: false, reason: "malformed_token" };
  }
}
