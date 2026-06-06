/**
 * legalCounsel/diffNarrative.ts — LLM-free version delta bullet builder.
 *
 * Takes raw diff_items and returns max 5 bullets summarizing the most significant changes.
 * Never embeds the full 20-item diff in the default response.
 */

import type { VersionDiffItem } from "./diffVersions.js";

export function buildVersionDeltaBullets(
  diffItems: VersionDiffItem[],
  max = 5,
): string[] {
  if (!diffItems || diffItems.length === 0) return [];

  const sigRank = { critical: 3, material: 2, minor: 1 };
  const ranked = [...diffItems].sort(
    (a, b) =>
      (sigRank[b.significance as keyof typeof sigRank] ?? 0) -
      (sigRank[a.significance as keyof typeof sigRank] ?? 0),
  );

  return ranked.slice(0, max).map((d) => {
    const icon =
      d.significance === "critical" ? "🔴" : d.significance === "material" ? "🟡" : "⚪";
    const aSnip = d.version_a_excerpt?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "(removed)";
    const bSnip = d.version_b_excerpt?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "(added)";
    return `${icon} ${d.section_heading} [${d.change_type}]: "${aSnip}" → "${bSnip}"`;
  });
}
