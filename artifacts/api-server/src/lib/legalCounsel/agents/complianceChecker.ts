/**
 * complianceChecker.ts — Post-reconciliation compliance pass.
 *
 * Deterministic (no LLM):
 * 1. Demote any findings_grounded entry where chunk_id is not in actual RAG hits.
 * 2. Compute grounded_ratio = grounded / (grounded + inferred).
 * 3. Flag if grounded_ratio < 0.5.
 */

import type { GroundedFinding, InferredFinding } from "../grounding.js";
import type { LegalCorpusHit } from "../../legalCorpus/retrieve.js";

export interface ComplianceResult {
  findings_grounded: GroundedFinding[];
  findings_inferred: InferredFinding[];
  grounded_ratio: number;
  compliance_passed: boolean;
  compliance_flags: string[];
}

export function runComplianceCheck(
  findings_grounded: GroundedFinding[],
  findings_inferred: InferredFinding[],
  ragHits: LegalCorpusHit[],
): ComplianceResult {
  const validChunkIds = new Set(ragHits.map(h => h.chunk_id));
  const validSlugs = new Set(ragHits.map(h => h.slug));

  const verified_grounded: GroundedFinding[] = [];
  const demoted: InferredFinding[] = [];

  for (const f of findings_grounded) {
    if (validChunkIds.has(f.chunk_id) || validSlugs.has(f.slug)) {
      verified_grounded.push(f);
    } else {
      demoted.push({
        lens: f.lens,
        severity: f.severity,
        issue: f.issue,
        reason: `compliance check: chunk_id=${f.chunk_id}/slug=${f.slug} not in retrieval hits — demoted`,
      });
    }
  }

  const all_inferred = [...findings_inferred, ...demoted];
  const total = verified_grounded.length + all_inferred.length;
  const grounded_ratio = total > 0 ? verified_grounded.length / total : 0;

  const compliance_flags: string[] = [];
  if (grounded_ratio < 0.5) {
    compliance_flags.push(
      `grounded_ratio=${grounded_ratio.toFixed(2)} < 0.50 — fewer than half of findings are corpus-grounded`,
    );
  }
  if (demoted.length > 0) {
    compliance_flags.push(
      `${demoted.length} finding(s) demoted from grounded to inferred (chunk_id not in retrieval hits)`,
    );
  }

  return {
    findings_grounded: verified_grounded,
    findings_inferred: all_inferred,
    grounded_ratio: Math.round(grounded_ratio * 100) / 100,
    compliance_passed: compliance_flags.length === 0,
    compliance_flags,
  };
}
