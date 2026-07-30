/**
 * bench/baselineIntegrity.ts — audit the BENCHMARK'S OWN GROUND TRUTH.
 *
 * Every accuracy number in this project is conditional on the fixture labels being right. A judge
 * disagreeing with one of our "clean" labels turned out to be correct, so this file stops assuming
 * and measures: it runs the two source-of-truth-free guardians (self_consistency,
 * required_entities) over the unmutated buildDraft output for every legal intake and reports what
 * the baseline documents actually contain.
 *
 * Output: baseline_integrity.json — per-document verdicts plus the two systemic findings.
 *
 * Run: RIGOR_OUT=/path node_modules/.bin/tsx src/lib/verification/bench/baselineIntegrity.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildDraft } from "../../draftEngine.js";
import type { DraftIntake } from "../../draftReceiptEngine.js";
import { makeSelfConsistencyGuardian, makeRequiredEntitiesGuardian, splitSections } from "../guardians.js";
import { legalEntities } from "../domains/legalDraft.js";
import { LEGAL_INTAKES } from "./fixtures.js";

interface ProvenanceCheck {
  section_id: string;
  variant_used: string | null;
  condition_matched: string;
  verdict: "true" | "false" | "not_evaluated";
  actual: number | null;
}

interface DocAudit {
  index: number;
  doc_class: string;
  jurisdiction: string;
  chars: number;
  sections: string[];
  self_consistency: { status: string; reasons: string[]; contradictions: unknown[] };
  required_entities: { status: string; reasons: string[]; present: string[]; n_missing: number };
  clause_provenance: { n_false: number; checks: ProvenanceCheck[] };
}

/**
 * Every section receipt records `condition_matched`, which reads like the predicate that caused the
 * variant to be selected. Evaluate those predicates against the intake and see whether they hold.
 * Only the numeric equality form is evaluated; anything else is reported as not_evaluated rather
 * than guessed.
 */
export function checkClauseProvenance(result: { sections: Array<{ section_id: string; variant_used?: string; rationale?: { condition_matched: string } }> }, intake: DraftIntake): ProvenanceCheck[] {
  const fields: Record<string, number | null | undefined> = {
    vesting_years: intake.equity?.vesting_years,
    cliff_months: intake.equity?.cliff_months,
    equity_pct: intake.advisory?.equity_pct,
    cash_fee: intake.advisory?.cash_fee,
  };
  const out: ProvenanceCheck[] = [];
  for (const s of result.sections) {
    const cond = s.rationale?.condition_matched;
    if (!cond) continue;
    const m = cond.match(/^\s*(\w+)\s*===\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m || !(m[1] in fields)) {
      out.push({ section_id: s.section_id, variant_used: s.variant_used ?? null, condition_matched: cond, verdict: "not_evaluated", actual: null });
      continue;
    }
    const actual = fields[m[1]];
    const expected = Number(m[2]);
    out.push({
      section_id: s.section_id,
      variant_used: s.variant_used ?? null,
      condition_matched: cond,
      verdict: actual != null && actual === expected ? "true" : "false",
      actual: actual ?? null,
    });
  }
  return out;
}

export interface BaselineIntegrityReport {
  generated_at: string;
  n_documents: number;
  n_self_consistency_fail: number;
  n_required_entities_fail: number;
  n_false_provenance_claims: number;
  documents: DocAudit[];
  findings: string[];
}


export function runBaselineIntegrity(): BaselineIntegrityReport {
  const sc = makeSelfConsistencyGuardian({ getText: (i) => (i as { text: string }).text });
  const re = makeRequiredEntitiesGuardian({
    getText: (i) => (i as { text: string }).text,
    getEntities: (i) => legalEntities((i as { intake: DraftIntake }).intake),
  });

  const documents: DocAudit[] = [];
  for (let i = 0; i < LEGAL_INTAKES.length; i++) {
    const intake = LEGAL_INTAKES[i];
    const draft = buildDraft(intake);
    const input = { text: draft.full_text, intake };
    const scr = sc.run(input, { live: false, domain: "legal_draft" }) as { status: string; reasons: string[]; evidence?: Record<string, unknown> };
    const rer = re.run(input, { live: false, domain: "legal_draft" }) as { status: string; reasons: string[]; evidence?: Record<string, unknown> };
    const prov = checkClauseProvenance(draft, intake);
    documents.push({
      index: i,
      doc_class: intake.doc_class,
      jurisdiction: intake.jurisdiction,
      chars: draft.full_text.length,
      sections: splitSections(draft.full_text).map((s) => s.title),
      self_consistency: {
        status: scr.status,
        reasons: scr.reasons,
        contradictions: (scr.evidence?.contradictions as unknown[]) ?? [],
      },
      required_entities: {
        status: rer.status,
        reasons: rer.reasons,
        present: (rer.evidence?.present as string[]) ?? [],
        n_missing: Number(rer.evidence?.n_missing ?? 0),
      },
      clause_provenance: { n_false: prov.filter((p) => p.verdict === "false").length, checks: prov },
    });
  }

  const nSc = documents.filter((d) => d.self_consistency.status === "fail").length;
  const nRe = documents.filter((d) => d.required_entities.status === "fail").length;
  const nProv = documents.reduce((a, d) => a + d.clause_provenance.n_false, 0);
  const findings: string[] = [];
  if (nRe > 0) {
    findings.push(
      `entity presence: ${nRe}/${documents.length} unmutated buildDraft documents never name at least one intake party. ` +
        `The Preamble defers identification to "the parties identified in the signature block below" in ALL ${documents.length} documents ` +
        `and no signature-block section is ever emitted. The two co-founder documents recover the names only because the Equity Split ` +
        `section serialises the split map into the contract body as raw JSON — each party is named exactly once, inside that blob. ` +
        `The advisor document has no split map, so it names nobody. Entity naming in this generator is incidental, not designed.`,
    );
  }
  if (nSc > 0) {
    findings.push(
      `heading/body self-consistency: ${nSc}/${documents.length} unmutated documents contradict themselves. ` +
        `The four vesting variants in clauseLibrary.ts carry conditions ("vesting_years === 4", "cliff_months === 12", ...) ` +
        `that the selector never evaluates — variantMatchesIntake() special-cases only IP-001 and IP-003 and returns true ` +
        `for everything else, and the tie-break sort is on doc_class then risk_level, both identical across VS-001..VS-004. ` +
        `So every document takes VS-001 and inherits its literal heading "Vesting Schedule — 4yr/1yr cliff", ` +
        `while the body substitutes the real intake numbers. Documents that happen to be 4yr/12mo look correct by luck.`,
    );
  }
  if (nProv > 0) {
    findings.push(
      `clause provenance: ${nProv} section receipts across ${documents.length} documents record a condition_matched ` +
        `predicate that is FALSE for their own intake. draftEngine.ts sets condition_matched = variant.conditions[0], ` +
        `and ClauseVariant.conditions is annotated "documentation only" in the type. The receipt therefore asserts a ` +
        `selection rule that was never executed, which is the audit-trail form of the same defect.`,
    );
  }
  if (!findings.length) findings.push("no baseline integrity defects detected");

  return {
    generated_at: new Date().toISOString(),
    n_documents: documents.length,
    n_self_consistency_fail: nSc,
    n_required_entities_fail: nRe,
    n_false_provenance_claims: nProv,
    documents,
    findings,
  };
}

if (process.argv[1] && process.argv[1].includes("baselineIntegrity")) {
  const outDir = process.env.RIGOR_OUT ?? "/tmp/rigor_out";
  mkdirSync(outDir, { recursive: true });
  const report = runBaselineIntegrity();
  writeFileSync(join(outDir, "baseline_integrity.json"), JSON.stringify(report, null, 2));
  console.log(`baseline integrity: ${report.n_documents} docs | self_consistency fail ${report.n_self_consistency_fail} | required_entities fail ${report.n_required_entities_fail} | false provenance claims ${report.n_false_provenance_claims}`);
  for (const d of report.documents) {
    console.log(`  [${d.index}] ${d.doc_class}/${d.jurisdiction} ${d.chars}c  sc=${d.self_consistency.status} re=${d.required_entities.status} missing=${d.required_entities.n_missing} prov_false=${d.clause_provenance.n_false}`);
    for (const p of d.clause_provenance.checks.filter((c) => c.verdict === "false")) console.log(`      PROV: ${p.section_id} (${p.variant_used}) claims "${p.condition_matched}" but actual=${p.actual}`);
    for (const r of d.self_consistency.reasons.slice(0, 3)) if (d.self_consistency.status === "fail") console.log(`      SC: ${r}`);
    for (const r of d.required_entities.reasons.slice(0, 4)) if (d.required_entities.status === "fail") console.log(`      RE: ${r}`);
  }
  for (const f of report.findings) console.log(`FINDING: ${f}`);
}
