/**
 * Full-document section digest — all sections included within a char budget.
 */

import type { ContractSection } from "./chunkContract.js";

export interface DigestResult {
  digest: string;
  sections_total: number;
  sections_included: number;
  chars_sent: number;
  coverage_pct: number;
}

export function buildFullContractDigest(
  sections: ContractSection[],
  options: { maxTotalChars?: number; minSectionChars?: number } = {},
): DigestResult {
  const maxTotalChars = options.maxTotalChars ?? 28_000;
  const minSectionChars = options.minSectionChars ?? 400;

  if (sections.length === 0) {
    return {
      digest: "",
      sections_total: 0,
      sections_included: 0,
      chars_sent: 0,
      coverage_pct: 0,
    };
  }

  const perSectionBudget = Math.max(
    minSectionChars,
    Math.floor(maxTotalChars / sections.length),
  );

  const parts: string[] = [];
  let charsSent = 0;

  for (const s of sections) {
    const header = `### ${s.heading}\n`;
    const bodyBudget = Math.min(perSectionBudget, maxTotalChars - charsSent - header.length - 2);
    if (bodyBudget < minSectionChars) break;

    const body = s.text.length <= bodyBudget ? s.text : `${s.text.slice(0, bodyBudget)}…`;
    const block = header + body;
    parts.push(block);
    charsSent += block.length + 2;
    if (charsSent >= maxTotalChars) break;
  }

  return {
    digest: parts.join("\n\n"),
    sections_total: sections.length,
    sections_included: parts.length,
    chars_sent: charsSent,
    coverage_pct: Math.round((parts.length / sections.length) * 1000) / 1000,
  };
}

/** Build retrieval queries from start, middle, and end of document. */
export function buildMultiRetrievalQueries(
  sections: ContractSection[],
  docHint?: string,
  fullTextPrefixLen = 1500,
  fullText?: string,
): string[] {
  const n = sections.length;
  const picks = [
    ...sections.slice(0, 4),
    ...(n > 8 ? sections.slice(Math.floor(n / 2) - 1, Math.floor(n / 2) + 3) : []),
    ...sections.slice(-4),
  ];

  const seen = new Set<string>();
  const queries: string[] = [];

  const add = (q: string) => {
    const k = q.slice(0, 200);
    if (seen.has(k)) return;
    seen.add(k);
    queries.push(q);
  };

  if (docHint) add(docHint);

  for (const s of picks) {
    add(`${s.heading}: ${s.text.slice(0, 350)}`);
  }

  if (fullText) add(fullText.slice(0, fullTextPrefixLen));

  return queries.slice(0, 5);
}
