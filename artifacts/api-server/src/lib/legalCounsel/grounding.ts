/**
 * Phase 3: split findings into corpus-grounded vs model-inferred; post-validate chunk_ids.
 */

import type { LegalCorpusHit } from "../legalCorpus/retrieve.js";

export interface GroundedFinding {
  lens: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  issue: string;
  chunk_id: number;
  slug: string;
  corpus_excerpt: string;
  contract_excerpt?: string;
  recommendation: string;
}

export interface InferredFinding {
  lens: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  issue: string;
  reason: string;
}

export interface RawCounselFindings {
  findings_grounded?: Array<{
    lens: string;
    severity: string;
    issue: string;
    chunk_id?: number;
    slug?: string;
    corpus_excerpt?: string;
    contract_excerpt?: string;
    recommendation: string;
  }>;
  findings_inferred?: Array<{
    lens: string;
    severity?: string;
    issue: string;
    reason: string;
  }>;
  lens_findings?: Array<{
    lens: string;
    severity: string;
    issue: string;
    contract_excerpt?: string;
    statutory_basis?: string;
    corpus_slugs?: string[];
    recommendation: string;
  }>;
}

function excerpt(content: string, max = 400): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function partitionAndValidateFindings(
  raw: RawCounselFindings,
  ragHits: LegalCorpusHit[],
): {
  findings_grounded: GroundedFinding[];
  findings_inferred: InferredFinding[];
  lens_findings: RawCounselFindings["lens_findings"];
} {
  const byChunkId = new Map(ragHits.map((h) => [h.chunk_id, h]));
  const bySlug = new Map<string, LegalCorpusHit>();
  for (const h of ragHits) {
    if (!bySlug.has(h.slug)) bySlug.set(h.slug, h);
  }

  const grounded: GroundedFinding[] = [];
  const inferred: InferredFinding[] = [...(raw.findings_inferred ?? [])];

  for (const f of raw.findings_grounded ?? []) {
    let hit: LegalCorpusHit | undefined;
    if (f.chunk_id != null) hit = byChunkId.get(f.chunk_id);
    if (!hit && f.slug) hit = bySlug.get(f.slug);

    if (hit) {
      grounded.push({
        lens: f.lens,
        severity: f.severity as GroundedFinding["severity"],
        issue: f.issue,
        chunk_id: hit.chunk_id,
        slug: hit.slug,
        corpus_excerpt: excerpt(hit.content),
        contract_excerpt: f.contract_excerpt,
        recommendation: f.recommendation,
      });
    } else {
      inferred.push({
        lens: f.lens,
        severity: f.severity,
        issue: f.issue,
        reason: "claimed grounded finding but chunk_id/slug not in retrieval hits",
      });
    }
  }

  // Promote lens_findings with corpus_slugs into grounded/inferred
  for (const lf of raw.lens_findings ?? []) {
    const slug = lf.corpus_slugs?.[0];
    if (slug && bySlug.has(slug)) {
      const hit = bySlug.get(slug)!;
      if (grounded.some((g) => g.chunk_id === hit.chunk_id && g.issue === lf.issue)) continue;
      grounded.push({
        lens: lf.lens,
        severity: lf.severity,
        issue: lf.issue,
        chunk_id: hit.chunk_id,
        slug: hit.slug,
        corpus_excerpt: excerpt(hit.content),
        contract_excerpt: lf.contract_excerpt,
        recommendation: lf.recommendation,
      });
    } else if (lf.corpus_slugs?.length) {
      inferred.push({
        lens: lf.lens,
        severity: lf.severity,
        issue: lf.issue,
        reason: `corpus_slugs [${lf.corpus_slugs.join(", ")}] not in retrieval hits`,
      });
    } else {
      inferred.push({
        lens: lf.lens,
        severity: lf.severity,
        issue: lf.issue,
        reason: "no corpus slug — model inference only",
      });
    }
  }

  return {
    findings_grounded: grounded,
    findings_inferred: inferred,
    lens_findings: raw.lens_findings,
  };
}
