/**
 * recon/reconcile.ts — reconciliation harness (the GAP-1 method, on real code).
 *
 * Question interviewers wanted reached: "how do you prove a NEW pipeline produces the SAME output
 * as the OLD one?" This harness answers it concretely.
 *
 * OLD = the current draft assembler: buildDraft(intake).full_text (source of truth today).
 * NEW = assembleFullTextV2(sections): a behavior-preserving reimplementation of the section→text
 *       join, written independently. We PROVE it matches OLD across all intake fixtures using the
 *       five-rung ladder — not by trusting it.
 *
 * Ladder:
 *   1. shadow-run OLD and NEW on the same inputs (no cutover)
 *   2. diff + bucket: exactly_equal | equivalent_formatted_differently | genuinely_different
 *   3. reconcile genuine diffs against ground truth (here: the OLD text is ground truth for the
 *      join; a genuine diff means NEW is wrong and must be fixed before cutover)
 *   4. gate cutover on an agreement threshold held over the whole fixture set
 *   5. (in production) keep verifying — the gate never turns off
 */

import { buildDraft } from "../../draftEngine.js";
import type { DraftIntake } from "../../draftReceiptEngine.js";
import type { DraftSection } from "../../draftReceiptEngine.js";

export type DiffBucket = "exactly_equal" | "equivalent_formatted_differently" | "genuinely_different";

export interface ReconItem {
  id: string;
  bucket: DiffBucket;
  detail?: string;
}
export interface ReconReport {
  generated_at: string;
  n: number;
  buckets: Record<DiffBucket, number>;
  agreement_rate: number; // (exact + equivalent) / n
  exact_rate: number; // exact / n
  cutover_recommended: boolean;
  cutover_threshold: number;
  items: ReconItem[];
  genuine_diffs: ReconItem[];
}

/**
 * NEW implementation of the section→full_text join, written to REPRODUCE the OLD behavior.
 * (The OLD join lives inside buildDraft; here we reconstruct it from the section list.)
 */
export function assembleFullTextV2(sections: DraftSection[]): string {
  // OLD format (observed): each section is "## <Title>\n\n<body>", joined by "\n\n---\n\n".
  return sections.map((s) => `## ${s.title}\n\n${s.body}`).join("\n\n---\n\n");
}

/** Normalizer for "equivalent formatted differently" detection: collapse whitespace runs. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function classify(oldText: string, newText: string): { bucket: DiffBucket; detail?: string } {
  if (oldText === newText) return { bucket: "exactly_equal" };
  if (normalize(oldText) === normalize(newText)) {
    return { bucket: "equivalent_formatted_differently", detail: "identical after whitespace normalization" };
  }
  // find first divergence for a helpful, specific detail
  let i = 0;
  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) i++;
  return { bucket: "genuinely_different", detail: `first divergence at char ${i}: OLD=${JSON.stringify(oldText.slice(i, i + 40))} NEW=${JSON.stringify(newText.slice(i, i + 40))}` };
}

export function reconcile(intakes: DraftIntake[], cutoverThreshold = 1.0): ReconReport {
  const items: ReconItem[] = [];
  const buckets: Record<DiffBucket, number> = { exactly_equal: 0, equivalent_formatted_differently: 0, genuinely_different: 0 };

  intakes.forEach((intake, idx) => {
    const draft = buildDraft(intake);
    const oldText = draft.full_text; // OLD path (ground truth for the join)
    const newText = assembleFullTextV2(draft.sections); // NEW path
    const { bucket, detail } = classify(oldText, newText);
    buckets[bucket]++;
    items.push({ id: `intake_${idx}_${intake.doc_class}_${intake.jurisdiction}`, bucket, detail });
  });

  const n = items.length;
  const agree = buckets.exactly_equal + buckets.equivalent_formatted_differently;
  const agreement_rate = n ? agree / n : 1;
  const exact_rate = n ? buckets.exactly_equal / n : 1;
  const genuine_diffs = items.filter((i) => i.bucket === "genuinely_different");

  return {
    generated_at: new Date().toISOString(),
    n,
    buckets,
    agreement_rate,
    exact_rate,
    cutover_recommended: agreement_rate >= cutoverThreshold && genuine_diffs.length === 0,
    cutover_threshold: cutoverThreshold,
    items,
    genuine_diffs,
  };
}
