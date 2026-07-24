/**
 * correction.ts — turn a failed guardian panel into a CorrectionPayload.
 *
 * The advice string is injected as the executor "hint" on the next attempt.
 * It is intentionally specific and imperative (the anti-slop principle applied
 * to our own feedback): name the failing guardian, quote the evidence, and tell
 * the executor exactly what to change. For SEARCH/REPLACE failures we surface
 * the failed blocks verbatim so the executor can re-emit a matching diff.
 */
import type { CorrectionPayload, GuardianId, PanelResult } from "./types.js";

export function buildCorrection(panel: PanelResult): CorrectionPayload {
  const failing = panel.verdicts.filter((v) => !v.pass);
  const failing_guardians: GuardianId[] = failing.map((v) => v.guardian);
  const reasons = failing.map((v) => `[${v.guardian}] ${v.reason}`);
  const evidence = failing.flatMap((v) => v.evidence.map((e) => `[${v.guardian}] ${e}`));

  // Pull failed SEARCH/REPLACE blocks out of the materiality detail, if present.
  const failed_edit_blocks: string[] = [];
  for (const v of failing) {
    const sr = v.detail?.searchReplace as { failures?: string[] } | undefined;
    if (sr?.failures) failed_edit_blocks.push(...sr.failures);
  }

  const adviceLines: string[] = [
    "Your previous attempt was REJECTED by the Rigor-Gate guardians. Fix EXACTLY these problems:",
  ];
  for (const v of failing) {
    adviceLines.push(`- ${v.guardian.toUpperCase()}: ${v.reason}`);
    for (const e of v.evidence.slice(0, 3)) adviceLines.push(`    evidence: ${e}`);
    adviceLines.push(...guardianSpecificAdvice(v.guardian));
  }
  if (failed_edit_blocks.length > 0) {
    adviceLines.push(
      "The following SEARCH block(s) did not match the file content — re-copy the EXACT current text into SEARCH:",
    );
    for (const f of failed_edit_blocks.slice(0, 3)) adviceLines.push(`    ${f}`);
  }

  return {
    failing_guardians,
    reasons,
    evidence,
    failed_edit_blocks: failed_edit_blocks.length > 0 ? failed_edit_blocks : undefined,
    advice: adviceLines.join("\n"),
  };
}

function guardianSpecificAdvice(g: GuardianId): string[] {
  switch (g) {
    case "materiality":
      return [
        "    → Produce the actual artifact (code/file/data) that backs your claim, or supply a SEARCH/REPLACE block that applies cleanly. Remove any swallowed exceptions, `as any`, dead code, or TODO stubs.",
      ];
    case "numerical":
      return [
        "    → Every number in answer_text must match the value in the artifact it came from. Recompute from the artifact and quote it exactly, or fix the artifact.",
      ];
    case "hedge":
      return [
        "    → State the decision plainly. Remove hedging ('it's important to note', 'could be interpreted as', 'arguably'). If a binary gate fails, say it fails.",
      ];
    case "rubric":
      return [
        "    → Raise materiality, numerical grounding, decisiveness, methodological completeness, and actionability. Address the rubric reasons above directly.",
      ];
    default:
      return [];
  }
}
