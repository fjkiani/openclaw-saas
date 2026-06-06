/**
 * Deterministic company-side leverage analysis (no LLM).
 * Surfaces negotiation wins, counterparty gifts, and company exposure from contract + version diff.
 */

import type { ContractSignals } from "./contractSignals.js";
import type { VersionDiffItem } from "./diffVersions.js";
import type { GroundedFinding, InferredFinding } from "./grounding.js";
import type { LegalCorpusHit } from "../legalCorpus/retrieve.js";

export interface CompanyOpportunity {
  type: "loophole_for_company" | "negotiation_leverage" | "tax_optimization" | "compliance_fix" | "missing_protective_clause";
  title: string;
  description: string;
  suggested_language?: string;
  corpus_slugs?: string[];
}

export function buildCompanyLeverageFindings(
  text: string,
  signals: ContractSignals,
  versionDiffs: VersionDiffItem[] | undefined,
  perspective: "company" | "counterparty" | "neutral",
): { inferred: InferredFinding[]; opportunities: CompanyOpportunity[]; blocking: string[] } {
  if (perspective !== "company") {
    return { inferred: [], opportunities: [], blocking: [] };
  }

  const inferred: InferredFinding[] = [];
  const opportunities: CompanyOpportunity[] = [];
  const blocking: string[] = [];

  if (signals.has_mutual_dependency) {
    inferred.push({
      lens: "company_leverage",
      severity: "critical",
      issue:
        "Mutual Dependency lets milestones be deemed 'Satisfied' when Company lacks eng/data/API — vests equity without objective proof.",
      reason: "Contract text — counterparty-favorable vesting escape hatch; tighten before signing.",
    });
    blocking.push(
      "Mutual Dependency: cap 'deemed Satisfied' with written notice, cure period, and objective acceptance criteria on Schedule B.",
    );
  }

  if (signals.has_acceleration && /100%|double trigger|six months/i.test(text)) {
    inferred.push({
      lens: "vesting_economics",
      severity: "high",
      issue:
        "Acceleration package (single/double-trigger and/or without-Cause vesting boost) increases dilution cost on exit or termination.",
      reason: "Contract acceleration clauses — model cap table impact before accepting.",
    });
    opportunities.push({
      type: "negotiation_leverage",
      title: "Cap acceleration economics",
      description:
        "Trade double-trigger-only (no single-trigger) and cap without-Cause acceleration at 3 months instead of 6.",
      suggested_language:
        "Acceleration applies only on a Qualifying Termination within 12 months following a Change of Control (double-trigger). No single-trigger acceleration.",
    });
  }

  if (signals.has_cause_only_company_termination) {
    opportunities.push({
      type: "negotiation_leverage",
      title: "Retain Cause-only company termination",
      description:
        "Counterparty draft removed Company without-Cause termination — preserve this; do not reintroduce 30-day without-Cause.",
      corpus_slugs: ["cuad-termination-for-cause"],
    });
  }

  if (signals.has_schedule_c_blank) {
    inferred.push({
      lens: "company_leverage",
      severity: "critical",
      issue: "Schedule C (Pre-Existing IP) is blank — broad assignment may sweep clinical/prior work improperly or leave gaps.",
      reason: "Placeholder schedule — close blocker until completed and scoped assignment confirmed.",
    });
    blocking.push("Schedule C and C-1 must be completed before signing — no blank pre-existing IP schedule.");
  }

  if (signals.has_employee_classification) {
    inferred.push({
      lens: "classification",
      severity: "high",
      issue:
        "Full-time employee classification triggers withholding, benefits, workers' comp, and misclassification risk if treated as contractor.",
      reason: "Section 3.3 employee language — align payroll, 409A, and RSPA with W-2 employment.",
    });
  }

  const statusDiff = versionDiffs?.find((d) =>
    /status|employee|contractor/i.test(d.section_heading + d.version_a_excerpt + d.version_b_excerpt),
  );
  if (statusDiff && /independent contractor/i.test(statusDiff.version_a_excerpt) && /employee/i.test(statusDiff.version_b_excerpt)) {
    inferred.push({
      lens: "classification",
      severity: "critical",
      issue: "Version delta: Independent Contractor (company draft) → Full Time Employee (counterparty draft).",
      reason: `Version diff section ${statusDiff.section_key} — major employment/tax posture change.`,
    });
  }

  if (/cash compensation shall be \$0|\$0 during/i.test(text)) {
    opportunities.push({
      type: "loophole_for_company",
      title: "Zero cash compensation pre-revenue",
      description: "Counterparty accepted $0 cash until financing milestone — preserves runway.",
    });
  }

  if (signals.has_ip_moat_rep) {
    blocking.push(
      "Verify IP Moat rep is true: confirm Fahad Kiani and Dr. Rahima Nayeem IP assignments are executed and match Kim grant scope.",
    );
  }

  return { inferred, opportunities, blocking };
}

/** Ensure statute chunks retrieved are reflected in grounded findings when contract triggers them. */
export function enrichGroundedStatuteFindings(
  grounded: GroundedFinding[],
  hits: LegalCorpusHit[],
  signals: ContractSignals,
): GroundedFinding[] {
  const out = [...grounded];
  const hasSlug = (slug: string) => out.some((g) => g.slug === slug);
  const hitBySlug = (slug: string) => hits.find((h) => h.slug === slug);

  if (signals.has_83b) {
    const hit = hitBySlug("irc-83b");
    if (hit && !hasSlug("irc-83b")) {
      out.push({
        lens: "tax_and_securities",
        severity: "high",
        issue: "Section 83(b) election required within 30 days of restricted stock grant — non-waivable IRS deadline.",
        chunk_id: hit.chunk_id,
        slug: hit.slug,
        corpus_excerpt: hit.content.slice(0, 400).replace(/\s+/g, " ").trim(),
        contract_excerpt: "Co-Founder shall file a Section 83(b) election via certified mail within 30 days of the grant.",
        recommendation: "Ship 83(b) kit at signing; define grant date; retain certified-mail proof; pair with RSPA and 409A FMV.",
      });
    }
  }

  if (signals.has_restricted_stock) {
    const hit144 = hitBySlug("dgcl-144");
    if (hit144 && !hasSlug("dgcl-144")) {
      out.push({
        lens: "tax_and_securities",
        severity: "high",
        issue: "Restricted stock to interested director/officer may require DGCL §144 safe-harbor approval path.",
        chunk_id: hit144.chunk_id,
        slug: hit144.slug,
        corpus_excerpt: hit144.content.slice(0, 400).replace(/\s+/g, " ").trim(),
        recommendation: "Add disinterested board (and stockholder if needed) approval for issuance to CMO/board-affiliated grantee.",
      });
    }
    const hit1202 = hitBySlug("irc-1202");
    if (hit1202 && !hasSlug("irc-1202")) {
      out.push({
        lens: "tax_optimization",
        severity: "medium",
        issue: "QSBS (IRC §1202) eligibility should be confirmed at issuance — post-OBBBA $75M gross asset ceiling.",
        chunk_id: hit1202.chunk_id,
        slug: hit1202.slug,
        corpus_excerpt: hit1202.content.slice(0, 400).replace(/\s+/g, " ").trim(),
        recommendation: "Document QSBS eligibility at grant; monitor gross assets; use original-issue stock language in RSPA.",
      });
    }
    const hit409 = hitBySlug("irc-409a");
    if (hit409 && !hasSlug("irc-409a")) {
      out.push({
        lens: "tax_and_securities",
        severity: "high",
        issue: "Equity grant should comply with IRC §409A — FMV at grant required for restricted stock purchase price.",
        chunk_id: hit409.chunk_id,
        slug: hit409.slug,
        corpus_excerpt: hit409.content.slice(0, 400).replace(/\s+/g, " ").trim(),
        recommendation: "Obtain 409A valuation before grant; set purchase price at FMV; board consent with valuation date.",
      });
    }
  }

  if (signals.has_ruo) {
    const hit = hits.find((h) => /ruo|research use|clinical decision/i.test(h.content));
    if (hit && !out.some((g) => g.chunk_id === hit.chunk_id)) {
      out.push({
        lens: "regulatory",
        severity: "high",
        issue: "RUO / clinical decision support scope must stay out of unauthorized diagnostic use.",
        chunk_id: hit.chunk_id,
        slug: hit.slug,
        corpus_excerpt: hit.content.slice(0, 400).replace(/\s+/g, " ").trim(),
        recommendation: "Board policy: no patient-facing diagnostic claims without clearance; CMO public statements require compliance review.",
      });
    }
  }

  return out;
}
