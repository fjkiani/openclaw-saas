/**
 * domains/legalDraft.ts — legal-draft domain adapter.
 *
 * Plugs the co-founder / advisor / IP-assignment draft pipeline (draftEngine + draftVerifier) into
 * the domain-agnostic verification core. Defense-in-depth panel:
 *   materiality — wraps the repo's deterministic verifyDraft() (real structural/legal checks)
 *   numerical   — parses the assembled draft text and checks vesting years, cliff months, the
 *                 83(b) 30-day window, and effective date against the trusted intake
 *   hedge       — a definitive legal document should not hedge
 *   rubric      — LLM-judge (live via modelRouter, else dry+degraded → fail-closed)
 *
 * The materiality guardian REUSES existing repo logic rather than reinventing it — that is the
 * whole point: the framework unifies checks that already exist into one fail-closed verdict.
 */

import type { DomainAdapter, Guardian } from "../verificationCore.js";
import {
  makeMaterialityGuardian,
  makeNumericalGuardian,
  makeHedgeGuardian,
  makeRubricGuardian,
  makeSelfConsistencyGuardian,
  makeRequiredEntitiesGuardian,
  type NumericClaim,
  type RequiredEntity,
} from "../guardians.js";
import { verifyDraft } from "../../draftVerifier.js";
import type { BuildDraftResult } from "../../draftEngine.js";
import type { DraftIntake } from "../../draftReceiptEngine.js";

export const LEGAL_DRAFT_DOMAIN = "legal_draft";

/** Raw input to this domain: a built draft + the intake it was built from. */
export interface LegalDraftRaw {
  result: BuildDraftResult;
  intake: DraftIntake;
}

/** Prepared input the guardians consume. */
export interface LegalDraftInput {
  text: string;
  result: BuildDraftResult;
  intake: DraftIntake;
}

// ── number parsing from the assembled draft text ────────────────────────────
// The draft engine writes concrete phrasing we can parse (verified against real output):
//   "Equity shall vest over 4 years, with a cliff of 12 months."
//   "...file an election under Section 83(b) ... within 30 days of the grant date."
//   "This Agreement is entered into as of 2025-01-15 ..."
function parseVestingYears(text: string): number | null {
  const m = text.match(/vest over\s+(\d+)\s+years?/i) || text.match(/(\d+)\s*yr\//i);
  return m ? Number(m[1]) : null;
}
function parseCliffMonths(text: string): number | null {
  const m = text.match(/cliff of\s+(\d+)\s+months?/i) || text.match(/(\d+)\s+month cliff/i);
  return m ? Number(m[1]) : null;
}
function parse83bWindow(text: string): number | null {
  const m = text.match(/within\s+(\d+)\s+days of the grant date/i);
  return m ? Number(m[1]) : null;
}
function parseEffectiveDatePresent(text: string, date?: string): boolean {
  if (!date) return true;
  return text.includes(date);
}

/** The 83(b) window is a legal constant: 30 days in all US jurisdictions. Source of truth. */
const IRS_83B_WINDOW_DAYS = 30;

function extractLegalClaims(input: unknown): NumericClaim[] {
  const { text, intake } = input as LegalDraftInput;
  const claims: NumericClaim[] = [];

  // vesting years: intake is source of truth (engine defaults to 4 if absent — but the text should
  // reflect whatever the intake/engine settled on; we compare text vs intake's effective value).
  const expectedYears = intake.equity?.vesting_years ?? null;
  if (expectedYears != null) {
    claims.push({ label: "vesting_years", claimed: parseVestingYears(text), expected: expectedYears });
  }
  const expectedCliff = intake.equity?.cliff_months ?? null;
  if (expectedCliff != null) {
    claims.push({ label: "cliff_months", claimed: parseCliffMonths(text), expected: expectedCliff });
  }
  // 83(b) window is a hard legal constant — a wrong number here is a serious slop signal.
  if (/83\(b\)/i.test(text)) {
    claims.push({ label: "irs_83b_window_days", claimed: parse83bWindow(text), expected: IRS_83B_WINDOW_DAYS });
  }
  return claims;
}

// ── build the guardians ──────────────────────────────────────────────────────
function buildGuardians(): Guardian<unknown>[] {
  const materiality = makeMaterialityGuardian({
    getText: (i) => (i as LegalDraftInput).text,
    minLength: 400, // a real agreement is not 3 sentences
    structural: (i) => {
      const { result, intake, text } = i as LegalDraftInput;
      const v = verifyDraft(result, intake);
      const reasons: string[] = [];
      if (!v.passed) {
        for (const f of v.template_failures) reasons.push(`template_failure[${f.severity}] ${f.section}: ${f.detail}`);
        for (const c of v.legal_conflicts) reasons.push(`legal_conflict[${c.severity}] ${c.conflict_id}: ${c.description}`);
        for (const md of v.missing_data) reasons.push(`missing_data ${md.field}: ${md.impact}`);
      }
      // Effective-date presence is a materiality signal (did it actually fill the field?).
      if (!parseEffectiveDatePresent(text, intake.effective_date)) {
        reasons.push(`effective_date '${intake.effective_date}' not present in the draft text`);
      }
      return { passed: reasons.length === 0, reasons };
    },
  });

  const numerical = makeNumericalGuardian({ extractClaims: extractLegalClaims });

  const hedge = makeHedgeGuardian({
    getText: (i) => (i as LegalDraftInput).text,
    maxPer1k: 2, // legal drafts should be especially committal
    // Absolute-count trigger: a long contract dilutes density, so a handful of weasel
    // phrases can slip under a per-1k threshold. A definitive agreement should carry
    // essentially none; fail at 3+ regardless of document length.
    maxCount: 3,
  });

  // Added after an LLM judge disagreed with one of this benchmark's own "clean" labels and was
  // right. The numerical guardian compares BODY vs INTAKE and passed the document, because the
  // body was correct — the contradiction was between the section HEADING and that same body.
  // Nothing in the panel was looking at the artifact against itself.
  const selfConsistency = makeSelfConsistencyGuardian({
    getText: (i) => (i as LegalDraftInput).text,
  });

  // An agreement that never names its own parties is not executable, however well-formed it reads.
  const requiredEntities = makeRequiredEntitiesGuardian({
    getText: (i) => (i as LegalDraftInput).text,
    getEntities: (i) => legalEntities((i as LegalDraftInput).intake),
  });

  const rubric = makeRubricGuardian({
    getText: (i) => (i as LegalDraftInput).text,
    axes: ["legal_completeness", "numerical_grounding", "decisiveness", "clause_coverage", "actionability"],
  });

  return [materiality, numerical, hedge, selfConsistency, requiredEntities, rubric];
}

const JURISDICTION_NAMES: Record<string, string> = { DE: "Delaware", NY: "New York", CA: "California" };

/** Parties and jurisdiction are the entities a legal draft is ABOUT; all must be named in it. */
export function legalEntities(intake: DraftIntake): RequiredEntity[] {
  const ents: RequiredEntity[] = intake.parties.map((p) => ({
    label: `party:${p.role}:${p.name}`,
    // A surname-only or company-shortname reference still counts as naming the party.
    any: [p.name, ...p.name.split(/\s+/).filter((tok) => tok.length > 3 && !/^(dr|mr|ms|mrs|inc|llc|corp)\.?$/i.test(tok))],
  }));
  ents.push({
    label: `jurisdiction:${intake.jurisdiction}`,
    any: [intake.jurisdiction, JURISDICTION_NAMES[intake.jurisdiction] ?? intake.jurisdiction],
  });
  return ents;
}

export const legalDraftAdapter: DomainAdapter<LegalDraftRaw, LegalDraftInput> = {
  domain: LEGAL_DRAFT_DOMAIN,
  prepare: (raw) => ({ text: raw.result.full_text, result: raw.result, intake: raw.intake }),
  guardians: buildGuardians(),
};

// convenience parsers exported for tests/benchmark
export const _parsers = { parseVestingYears, parseCliffMonths, parse83bWindow, IRS_83B_WINDOW_DAYS };
