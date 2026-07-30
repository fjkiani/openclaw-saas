/**
 * legalCounsel/orchestrator.ts — 4 parallel lens agents + reconciliation + compliance.
 *
 * Flow:
 *   prep (shared RAG hits, digest, signals)
 *   → Promise.all([taxSecurities, delawareCorp, ipAssignment, regulatoryEmployment])
 *   → reconcile (dedup, perspective fix, redline conflict filter)
 *   → compliance (demote fake grounded, compute grounded_ratio)
 *   → return OrchestratorResult
 *
 * The orchestrator does NOT call the monolith LLM. Each lens is a separate LLM call.
 */

import { runTaxSecuritiesLens } from "./agents/taxSecuritiesLens.js";
import { runDelawareCorpLens } from "./agents/delawareCorpLens.js";
import { runIpAssignmentLens } from "./agents/ipAssignmentLens.js";
import { runRegulatoryEmploymentLens } from "./agents/regulatoryEmploymentLens.js";
import { reconcileLensOutputs } from "./agents/reconciliationAgent.js";
import { runComplianceCheck } from "./agents/complianceChecker.js";
import { buildCompanyLeverageFindings, enrichGroundedStatuteFindings } from "./companyLeverage.js";
import { logger } from "../logger.js";
import type { LensInput, LensOutput, OrchestratorResult } from "./types.js";
import type { LegalCorpusHit } from "../legalCorpus/retrieve.js";
import type { ContractSignals } from "./contractSignals.js";
import type { VersionDiffItem } from "./diffVersions.js";

export interface OrchestratorInput {
  contractText: string;
  digest: string;
  ragHits: LegalCorpusHit[];
  signals: ContractSignals;
  perspective: "company" | "counterparty" | "neutral";
  versionDiffs?: VersionDiffItem[];
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const { contractText, digest, ragHits, signals, perspective, versionDiffs } = input;

  const lensInput: LensInput = { contractText, digest, ragHits, signals, perspective, versionDiffs };

  // ── Run 4 lens agents sequentially to avoid rate-limit storms ────────────
  // Running all 4 in parallel via Promise.all causes up to 16 concurrent API calls
  // (4 lenses × 4-model fallback chains), which blows through Groq's 12K TPM limit
  // and Gemini's free-tier 20 req/min limit. Sequential execution with a small
  // inter-lens delay keeps us under both limits.
  logger.info({ perspective }, "orchestrator: starting 4 lens agents (sequential)");

  const lensResults: LensOutput[] = [];
  const lensRunners = [
    { name: "tax_securities", fn: () => runTaxSecuritiesLens(lensInput) },
    { name: "delaware_corp", fn: () => runDelawareCorpLens(lensInput) },
    { name: "ip_assignment", fn: () => runIpAssignmentLens(lensInput) },
    { name: "regulatory_employment", fn: () => runRegulatoryEmploymentLens(lensInput) },
  ];

  for (const runner of lensRunners) {
    const result = await runner.fn();
    lensResults.push(result);
    // Small delay between lenses to let rate-limit windows recover
    if (runner.name !== "regulatory_employment") {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const [taxResult, delawareResult, ipResult, regResult] = lensResults;

  const parallelMs = Date.now() - t0;
  logger.info(
    {
      tax_findings: taxResult.findings.length,
      delaware_findings: delawareResult.findings.length,
      ip_findings: ipResult.findings.length,
      reg_findings: regResult.findings.length,
      parallel_ms: parallelMs,
    },
    "orchestrator: lens agents complete",
  );

  const lensOutputs = [taxResult, delawareResult, ipResult, regResult];

  // ── Reconcile ─────────────────────────────────────────────────────────────
  const reconciled = reconcileLensOutputs({ lensOutputs, ragHits, perspective });

  // ── Deterministic enrichment (company leverage + statute enrichment) ──────
  const leverage = buildCompanyLeverageFindings(contractText, signals, versionDiffs, perspective);

  // Merge leverage inferred findings (dedup by fingerprint)
  const inferredFingerprints = new Set(
    reconciled.findings_inferred.map(f => f.issue.toLowerCase().slice(0, 60))
  );
  for (const lf of leverage.inferred) {
    const fp = lf.issue.toLowerCase().slice(0, 60);
    if (!inferredFingerprints.has(fp)) {
      reconciled.findings_inferred.push(lf);
      inferredFingerprints.add(fp);
    }
  }

  // Merge leverage opportunities
  const opTitles = new Set(reconciled.opportunities.map(o => o.title));
  for (const op of leverage.opportunities) {
    if (!opTitles.has(op.title)) {
      reconciled.opportunities.push(op);
      opTitles.add(op.title);
    }
  }

  // Merge blocking issues
  const blockingSet = new Set(reconciled.blocking_issues);
  for (const b of leverage.blocking) {
    if (!blockingSet.has(b)) {
      reconciled.blocking_issues.push(b);
      blockingSet.add(b);
    }
  }

  // Statute enrichment on grounded findings
  const enrichedGrounded = enrichGroundedStatuteFindings(
    reconciled.findings_grounded,
    ragHits,
    signals,
  );

  // ── Compliance check ──────────────────────────────────────────────────────
  const compliance = runComplianceCheck(enrichedGrounded, reconciled.findings_inferred, ragHits);

  const lensModels = lensOutputs
    .filter(l => l.model_used && l.model_used !== "skipped" && l.model_used !== "failed")
    .map(l => `${l.lens}:${l.model_used}`);

  logger.info(
    {
      grounded: compliance.findings_grounded.length,
      inferred: compliance.findings_inferred.length,
      grounded_ratio: compliance.grounded_ratio,
      compliance_passed: compliance.compliance_passed,
      compliance_flags: compliance.compliance_flags,
    },
    "orchestrator: compliance check complete",
  );

  return {
    lens_outputs: lensOutputs,
    reconciled_findings_grounded: compliance.findings_grounded,
    reconciled_findings_inferred: compliance.findings_inferred,
    reconciled_redlines: reconciled.redlines,
    reconciled_opportunities: reconciled.opportunities,
    blocking_issues: reconciled.blocking_issues,
    compliance_passed: compliance.compliance_passed,
    compliance_flags: compliance.compliance_flags,
    meta: {
      orchestrator_mode: true,
      lens_models: lensModels,
      grounded_ratio: compliance.grounded_ratio,
      parallel_ms: parallelMs,
    },
  };
}
