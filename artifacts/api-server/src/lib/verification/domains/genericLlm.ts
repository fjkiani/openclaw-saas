/**
 * domains/genericLlm.ts — generic LLM text-output domain adapter.
 *
 * The "default" domain for any free-text model output (summaries, analyses, answers) where the
 * source of truth is a set of required facts/numbers the caller supplies. Reuses the four
 * text-oriented guardians directly. This is the adapter most new text use-cases start from.
 */

import type { DomainAdapter, Guardian } from "../verificationCore.js";
import {
  makeMaterialityGuardian,
  makeNumericalGuardian,
  makeHedgeGuardian,
  makeRubricGuardian,
  type NumericClaim,
} from "../guardians.js";

export const GENERIC_LLM_DOMAIN = "generic_llm";

export interface GenericRaw {
  text: string;
  /** Numbers the output MUST assert correctly, e.g. {revenue: 1200000}. Optional. */
  required_numbers?: Record<string, number>;
  /** Parse the claimed value of a required number from the text. Default: nearest number to the label. */
  parseClaim?: (text: string, label: string) => number | null;
  minLength?: number;
}
export interface GenericInput extends GenericRaw {}

function defaultParseClaim(text: string, label: string): number | null {
  // Crude but explainable: locate the label, then take the number NEAREST the label,
  // searching both directions. Natural language puts the value on either side of the noun
  // ("3 phases" vs "revenue was 999"), so a forward-only scan misses the pre-nominal form.
  const clean = text.replace(/,/g, "");
  const lc = clean.toLowerCase();
  const label_lc = label.toLowerCase();
  const idx = lc.indexOf(label_lc);
  if (idx === -1) return null;
  const label_end = idx + label_lc.length;
  const WINDOW = 60;

  // forward: first number in [label_end, label_end+WINDOW]
  const fwd = clean.slice(label_end, label_end + WINDOW).match(/-?\d+(?:\.\d+)?/);
  const fwdDist = fwd ? (fwd.index ?? 0) : Infinity;

  // backward: last number in [idx-WINDOW, idx]
  const beforeText = clean.slice(Math.max(0, idx - WINDOW), idx);
  const backMatches = [...beforeText.matchAll(/-?\d+(?:\.\d+)?/g)];
  const back = backMatches.length ? backMatches[backMatches.length - 1] : null;
  const backDist = back ? beforeText.length - ((back.index ?? 0) + back[0].length) : Infinity;

  if (fwdDist === Infinity && backDist === Infinity) return null;
  const chosen = backDist < fwdDist ? back : fwd;
  return chosen ? Number(chosen[0]) : null;
}

function buildGuardians(): Guardian<unknown>[] {
  const materiality = makeMaterialityGuardian({ getText: (i) => (i as GenericInput).text, minLength: 40 });
  const numerical = makeNumericalGuardian({
    extractClaims: (i): NumericClaim[] => {
      const inp = i as GenericInput;
      const parse = inp.parseClaim ?? defaultParseClaim;
      return Object.entries(inp.required_numbers ?? {}).map(([label, expected]) => ({
        label,
        claimed: parse(inp.text, label),
        expected,
      }));
    },
  });
  const hedge = makeHedgeGuardian({ getText: (i) => (i as GenericInput).text });
  const rubric = makeRubricGuardian({ getText: (i) => (i as GenericInput).text });
  return [materiality, numerical, hedge, rubric];
}

export const genericLlmAdapter: DomainAdapter<GenericRaw, GenericInput> = {
  domain: GENERIC_LLM_DOMAIN,
  prepare: (raw) => ({ ...raw, minLength: raw.minLength ?? 40 }),
  guardians: buildGuardians(),
};
