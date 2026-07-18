import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";

export type EvidenceRole = "VIEWER" | "ANNOTATOR" | "ADJUDICATOR" | "ADMIN";
export type EvidenceStatusChip =
  | "VERIFIED_REGISTRY_FACT" | "LINKAGE_UNVERIFIED" | "CONFLICT_REQUIRES_REVIEW"
  | "HUMAN_QC_VERIFIED" | "QUARANTINED";

export interface EvidenceIdentity { userId: string; roles: EvidenceRole[]; authType: "CLERK_JWT" | "SERVICE_TOKEN"; }

declare global { namespace Express { interface Request { evidenceIdentity?: EvidenceIdentity; } } }

function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export async function requireEvidenceIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  const clerkUser = getAuth(req)?.userId;
  let userId: string | undefined = clerkUser ?? undefined;
  let authType: EvidenceIdentity["authType"] = "CLERK_JWT";
  if (!userId) {
    const expected = process.env.EVIDENCE_SERVICE_TOKEN ?? "";
    const auth = req.headers.authorization ?? "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (expected.length >= 32 && secureEqual(supplied, expected)) {
      userId = "service:evidence-explorer";
      authType = "SERVICE_TOKEN";
    }
  }
  // X-User-Id/body userId are intentionally not accepted on Evidence Explorer routes.
  if (!userId) { res.status(401).json({ error: "STRICT_AUTH_REQUIRED", message: "Clerk JWT or Evidence service token required" }); return; }
  try {
    const result = await pool.query<{ role: EvidenceRole }>(
      `SELECT role FROM aacr_reviewer_roles WHERE user_id=$1 AND active=true`, [userId],
    );
    const roles = result.rows.map((r: { role: EvidenceRole }) => r.role);
    if (authType === "SERVICE_TOKEN" && !roles.includes("ADMIN")) roles.push("ADMIN");
    req.evidenceIdentity = { userId, roles: roles.length ? roles : ["VIEWER"], authType };
    next();
  } catch (error) {
    res.status(503).json({ error: "EVIDENCE_AUTH_STORE_UNAVAILABLE" });
  }
}

export function requireEvidenceRole(...allowed: EvidenceRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.evidenceIdentity?.roles.some((r) => allowed.includes(r))) {
      res.status(403).json({ error: "INSUFFICIENT_EVIDENCE_ROLE", required: allowed }); return;
    }
    next();
  };
}

const PROHIBITED_ASSERTION_PATTERNS = [
  /\bwhite[ -]?space\b/i, /\bclinically actionable\b/i, /\bproven\b/i,
  /\bopportunit(?:y|ies)\s*(?:score|rank|ranking)?\b/i, /\bfirst[- ]in[- ]class\b/i,
];
const PROHIBITED_FIELDS = new Set(["opportunity_score", "commercial_rank", "clinical_utility", "bd_assertion", "white_space"]);

export function claimEligible(claim: {
  field_name?: string; fieldName?: string; value_json?: unknown; value?: unknown;
  source_state?: string; sourceState?: string; lifecycle_status?: string; lifecycleStatus?: string;
  permitted_use?: string; permittedUse?: string; claim_eligible?: boolean; claimEligible?: boolean;
}): boolean {
  const field = claim.field_name ?? claim.fieldName ?? "";
  const value = claim.value_json ?? claim.value;
  const state = claim.source_state ?? claim.sourceState ?? "";
  const lifecycle = claim.lifecycle_status ?? claim.lifecycleStatus ?? "";
  const use = claim.permitted_use ?? claim.permittedUse ?? "";
  const stored = claim.claim_eligible ?? claim.claimEligible ?? false;
  if (PROHIBITED_FIELDS.has(field)) return false;
  if (PROHIBITED_ASSERTION_PATTERNS.some((p) => p.test(JSON.stringify(value)))) return false;
  if (state === "MODEL_EXTRACTION" || state === "QUERY_RETRIEVAL_ONLY_LINKAGE_UNVERIFIED") return false;
  if (lifecycle === "QUARANTINED" || use === "EXTERNAL_NOT_AUTHORIZED") return false;
  return Boolean(stored);
}

export function evidenceEnvelope(row: Record<string, any>) {
  return {
    value: row.value_json,
    source_state: row.source_state,
    evidence_tier: row.evidence_tier,
    lifecycle_status: row.lifecycle_status,
    receipt_id: row.receipt_id,
    source_excerpt: row.source_excerpt,
    source_hash: row.source_hash,
    permitted_use: row.permitted_use,
    claim_eligible: claimEligible(row),
  };
}

export function suppressIneligible(rows: Record<string, any>[]) {
  return rows.filter(claimEligible).map(evidenceEnvelope);
}

export function forbiddenDistributionRoute(channel: string) {
  return (_req: Request, res: Response): void => {
    res.status(403).json({
      error: "DISTRIBUTION_DISABLED",
      channel,
      lifecycle_status: "EXTERNAL_NOT_AUTHORIZED",
      reason: "Unvalidated AACR claims cannot leave the governed Evidence Explorer.",
    });
  };
}
