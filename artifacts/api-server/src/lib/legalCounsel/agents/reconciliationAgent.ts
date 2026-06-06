/**
 * reconciliationAgent.ts — Merge lens outputs, fix perspective errors, filter contradictory redlines.
 *
 * Rules (deterministic — no LLM):
 * 1. Deduplicate findings by (slug, issue_fingerprint).
 * 2. Perspective fix: if perspective=company, any finding that labels Mutual Dependency
 *    as "company-favorable" → flip to counterparty-favorable.
 * 3. Redline conflict filter: if perspective=company and a redline suggests adding
 *    without-Cause termination for company → drop it (company wants Cause-only).
 * 4. Merge opportunities, deduplicate by title.
 */

import type { LensOutput } from "../types.js";
import type { GroundedFinding, InferredFinding } from "../grounding.js";
import type { CompanyOpportunity } from "../companyLeverage.js";
import type { LegalCorpusHit } from "../../legalCorpus/retrieve.js";

export interface ReconciliationInput {
  lensOutputs: LensOutput[];
  ragHits: LegalCorpusHit[];
  perspective: "company" | "counterparty" | "neutral";
}

export interface ReconciliationOutput {
  findings_grounded: GroundedFinding[];
  findings_inferred: InferredFinding[];
  redlines: Array<{
    section: string;
    original_excerpt: string;
    suggested_text: string;
    rationale: string;
    favors: "company" | "balanced" | "counterparty";
  }>;
  opportunities: CompanyOpportunity[];
  blocking_issues: string[];
}

function issueFingerprint(issue: string): string {
  return issue.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
}

/** Mutual Dependency perspective fix: if company perspective, ensure it's labeled counterparty-favorable */
function fixMutualDependencyPerspective(
  issue: string,
  recommendation: string,
  perspective: "company" | "counterparty" | "neutral",
): { issue: string; recommendation: string } {
  if (perspective !== "company") return { issue, recommendation };
  const isMutualDep = /mutual.depend/i.test(issue);
  if (!isMutualDep) return { issue, recommendation };

  // If it says "company-favorable" or "company wins" — flip it
  const badFraming = /company.favor|company.win|benefit.*company|company.*benefit/i.test(issue + recommendation);
  if (badFraming) {
    return {
      issue: issue.replace(/company.favor\w*/gi, "counterparty-favorable").replace(/company.win\w*/gi, "counterparty-favorable"),
      recommendation: recommendation + " [PERSPECTIVE CORRECTED: Mutual Dependency favors counterparty — push back, do not accept as company win.]",
    };
  }
  return { issue, recommendation };
}

/** Drop redlines that contradict company perspective (e.g. adding without-Cause for company) */
function isContradictsCompanyPerspective(
  redline: { suggested_text: string; rationale: string; favors: string },
  perspective: "company" | "counterparty" | "neutral",
): boolean {
  if (perspective !== "company") return false;
  // Redline that adds without-Cause termination right for company is a company giveaway
  const addingWithoutCause = /without.cause/i.test(redline.suggested_text) &&
    /company.*terminat|terminat.*company/i.test(redline.suggested_text + redline.rationale);
  return addingWithoutCause && redline.favors !== "company";
}

export function reconcileLensOutputs(input: ReconciliationInput): ReconciliationOutput {
  const { lensOutputs, ragHits, perspective } = input;

  const byChunkId = new Map(ragHits.map(h => [h.chunk_id, h]));
  const bySlug = new Map<string, LegalCorpusHit>();
  for (const h of ragHits) {
    if (!bySlug.has(h.slug)) bySlug.set(h.slug, h);
  }

  const groundedSeen = new Set<string>();
  const inferredSeen = new Set<string>();
  const findings_grounded: GroundedFinding[] = [];
  const findings_inferred: InferredFinding[] = [];
  const redlines: ReconciliationOutput["redlines"] = [];
  const redlineSeen = new Set<string>();
  const opportunities: CompanyOpportunity[] = [];
  const opSeen = new Set<string>();
  const blocking_issues: string[] = [];

  for (const lens of lensOutputs) {
    for (const f of lens.findings) {
      const fp = issueFingerprint(f.issue);

      if (f.is_inferred || (!f.chunk_id && !f.slug)) {
        // Inferred finding
        if (inferredSeen.has(fp)) continue;
        inferredSeen.add(fp);
        const { issue, recommendation } = fixMutualDependencyPerspective(f.issue, f.recommendation, perspective);
        findings_inferred.push({
          lens: f.lens,
          severity: f.severity,
          issue,
          reason: f.inferred_reason ?? "model inference — no corpus chunk matched",
        });
      } else {
        // Attempt to ground
        let hit = f.chunk_id ? byChunkId.get(f.chunk_id) : undefined;
        if (!hit && f.slug) hit = bySlug.get(f.slug);

        if (hit) {
          const key = `${hit.chunk_id}:${fp}`;
          if (groundedSeen.has(key)) continue;
          groundedSeen.add(key);
          const { issue, recommendation } = fixMutualDependencyPerspective(f.issue, f.recommendation, perspective);
          findings_grounded.push({
            lens: f.lens,
            severity: f.severity,
            issue,
            chunk_id: hit.chunk_id,
            slug: hit.slug,
            corpus_excerpt: hit.content.slice(0, 400).replace(/\s+/g, " ").trim(),
            contract_excerpt: f.contract_excerpt,
            recommendation,
          });
        } else {
          // Claimed grounded but chunk not in hits → demote
          if (inferredSeen.has(fp)) continue;
          inferredSeen.add(fp);
          const { issue } = fixMutualDependencyPerspective(f.issue, f.recommendation, perspective);
          findings_inferred.push({
            lens: f.lens,
            severity: f.severity,
            issue,
            reason: `claimed chunk_id=${f.chunk_id}/slug=${f.slug} not in retrieval hits — demoted to inferred`,
          });
        }
      }
    }

    // Redlines — filter contradictory ones
    for (const r of lens.redlines) {
      if (isContradictsCompanyPerspective(r, perspective)) continue;
      const key = issueFingerprint(r.section + r.suggested_text);
      if (redlineSeen.has(key)) continue;
      redlineSeen.add(key);
      redlines.push(r);
    }

    // Opportunities
    for (const op of lens.opportunities) {
      const key = issueFingerprint(op.title ?? "");
      if (opSeen.has(key)) continue;
      opSeen.add(key);
      opportunities.push(op as CompanyOpportunity);
    }
  }

  return { findings_grounded, findings_inferred, redlines, opportunities, blocking_issues };
}
