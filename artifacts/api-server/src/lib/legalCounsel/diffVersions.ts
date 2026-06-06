/**
 * Section-aligned diff between two contract versions (deterministic redline base).
 */

import { chunkContractSections, type ContractSection } from "./chunkContract.js";

export interface VersionDiffItem {
  section_key: string;
  section_heading: string;
  change_type: "modified" | "added_in_b" | "removed_from_b";
  significance: "critical" | "material" | "minor";
  version_a_label: string;
  version_b_label: string;
  version_a_excerpt: string;
  version_b_excerpt: string;
}

export interface VersionRedline {
  section: string;
  change_summary: string;
  version_a_excerpt: string;
  version_b_excerpt: string;
  favors: "company" | "counterparty" | "balanced" | "unclear";
  negotiation_note: string;
}

const CRITICAL_HEADING_RE =
  /ip|assignment|vesting|equity|indemn|termination|cause|good reason|83\s*\(\s*b|classification|employee|contractor|acceleration|change of control|non-?solicit|reserved field|mutual dependency/i;

function sectionKey(section: ContractSection): string {
  const num = section.heading.match(/^(\d+(?:\.\d+)?)/);
  if (num) return num[1];
  return section.id;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function excerpt(s: string, max = 480): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function classifySignificance(heading: string, a: string, b: string): VersionDiffItem["significance"] {
  if (CRITICAL_HEADING_RE.test(heading)) return "critical";
  const ratio =
    Math.abs(normalizeText(a).length - normalizeText(b).length) /
    Math.max(normalizeText(a).length, normalizeText(b).length, 1);
  if (ratio > 0.35) return "material";
  return "minor";
}

function indexSections(sections: ContractSection[]): Map<string, ContractSection> {
  const map = new Map<string, ContractSection>();
  for (const s of sections) {
    const key = sectionKey(s);
    if (!map.has(key)) map.set(key, s);
  }
  return map;
}

export function diffContractVersions(
  versionA: { label: string; text: string },
  versionB: { label: string; text: string },
): VersionDiffItem[] {
  const aSections = indexSections(chunkContractSections(versionA.text));
  const bSections = indexSections(chunkContractSections(versionB.text));
  const allKeys = new Set([...aSections.keys(), ...bSections.keys()]);
  const diffs: VersionDiffItem[] = [];

  for (const key of [...allKeys].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
    const a = aSections.get(key);
    const b = bSections.get(key);

    if (a && !b) {
      diffs.push({
        section_key: key,
        section_heading: a.heading,
        change_type: "removed_from_b",
        significance: CRITICAL_HEADING_RE.test(a.heading) ? "critical" : "material",
        version_a_label: versionA.label,
        version_b_label: versionB.label,
        version_a_excerpt: excerpt(a.text),
        version_b_excerpt: "",
      });
      continue;
    }

    if (!a && b) {
      diffs.push({
        section_key: key,
        change_type: "added_in_b",
        section_heading: b.heading,
        significance: CRITICAL_HEADING_RE.test(b.heading) ? "critical" : "material",
        version_a_label: versionA.label,
        version_b_label: versionB.label,
        version_a_excerpt: "",
        version_b_excerpt: excerpt(b.text),
      });
      continue;
    }

    if (a && b && normalizeText(a.text) !== normalizeText(b.text)) {
      diffs.push({
        section_key: key,
        section_heading: a.heading,
        change_type: "modified",
        significance: classifySignificance(a.heading, a.text, b.text),
        version_a_label: versionA.label,
        version_b_label: versionB.label,
        version_a_excerpt: excerpt(a.text),
        version_b_excerpt: excerpt(b.text),
      });
    }
  }

  return diffs.sort((x, y) => {
    const rank = { critical: 0, material: 1, minor: 2 };
    return rank[x.significance] - rank[y.significance];
  });
}

/** Deterministic negotiation redlines from structural diff (no LLM). */
export function buildVersionRedlines(diffs: VersionDiffItem[]): VersionRedline[] {
  return diffs
    .filter((d) => d.significance !== "minor")
    .slice(0, 24)
    .map((d) => ({
      section: `${d.section_key} ${d.section_heading}`,
      change_summary: `${d.change_type.replace(/_/g, " ")} between ${d.version_a_label} and ${d.version_b_label}`,
      version_a_excerpt: d.version_a_excerpt,
      version_b_excerpt: d.version_b_excerpt,
      favors: inferFavors(d),
      negotiation_note: negotiationNote(d),
    }));
}

function inferFavors(d: VersionDiffItem): VersionRedline["favors"] {
  const b = d.version_b_excerpt.toLowerCase();
  const a = d.version_a_excerpt.toLowerCase();
  if (/independent contractor/.test(a) && /full time employee|employee/.test(b)) return "counterparty";
  if (/without cause|30 days/.test(a) && !/without cause/.test(b) && d.change_type === "modified") return "company";
  if (/mutual dependency|deemed satisfied/.test(b) && !/mutual dependency/.test(a)) return "counterparty";
  if (/present assignment|assigns to the company/.test(b)) return "company";
  return "unclear";
}

function negotiationNote(d: VersionDiffItem): string {
  if (/independent contractor/i.test(d.version_a_excerpt) && /employee/i.test(d.version_b_excerpt)) {
    return "Classification shift affects tax withholding, benefits, and misclassification risk — counsel review required.";
  }
  if (/83\s*\(\s*b/i.test(d.section_heading + d.version_b_excerpt)) {
    return "Confirm 83(b) mechanics, RSPA timing, and certified-mail process match grant date.";
  }
  if (/termination|cause/i.test(d.section_heading)) {
    return "Compare termination for Cause / Good Reason / without Cause paths and acceleration interaction.";
  }
  return "Review whether this change is intentional and which party it favors before signing.";
}
