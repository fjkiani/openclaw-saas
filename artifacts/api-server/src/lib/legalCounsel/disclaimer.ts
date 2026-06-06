/** Standard governance block for counsel analyze responses (not legal advice). */

export const COUNSEL_NOT_LEGAL_ADVICE_DISCLAIMER =
  "This output is automated pattern-matching, retrieval-augmented generation, and LLM reasoning — not legal advice. " +
  "It does not create an attorney-client relationship. Have a licensed attorney review before signing or relying on any finding.";

export const COUNSEL_PRIVILEGE_WARNING =
  "Do not paste privileged or highly confidential material unless your deployment policy allows it. " +
  "Model providers may process submitted text per their terms.";

export function counselGovernanceBlock() {
  return {
    not_legal_advice: true as const,
    disclaimer: COUNSEL_NOT_LEGAL_ADVICE_DISCLAIMER,
    privilege_warning: COUNSEL_PRIVILEGE_WARNING,
    method: "hybrid_rag_plus_llm" as const,
  };
}
