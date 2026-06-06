/**
 * Detect and split multi-version contract pastes (e.g. company draft + counterparty redline).
 */

export interface ContractVersion {
  label: string;
  text: string;
  line_start: number;
}

const BOUNDARY_PATTERNS: Array<{ pattern: RegExp; labelFromMatch?: (m: RegExpMatchArray) => string }> =
  [
    {
      pattern: /^Dr Kim version\s+(.+)$/im,
      labelFromMatch: (m) => `Dr Kim version ${m[1]?.trim() ?? ""}`.trim(),
    },
    {
      pattern: /^Counterparty (?:version|draft)\s*[:\-]?\s*(.+)$/im,
      labelFromMatch: (m) => `Counterparty ${m[1]?.trim() ?? "draft"}`.trim(),
    },
    {
      pattern: /^Company (?:version|draft)\s*[:\-]?\s*(.+)$/im,
      labelFromMatch: (m) => `Company ${m[1]?.trim() ?? "draft"}`.trim(),
    },
    {
      pattern: /^-{5,}\s*VERSION\s+2\s*-{5,}$/im,
      labelFromMatch: () => "Version 2",
    },
  ];

/** Second occurrence of agreement title after substantial content → new version. */
function findSecondAgreementTitle(lines: string[]): number | null {
  const titleRe =
    /Co-Founder Services and Restricted Stock Agreement|RESTRICTED STOCK PURCHASE AGREEMENT/i;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!titleRe.test(lines[i])) continue;
    seen++;
    if (seen === 2 && i > 40) return i;
  }
  return null;
}

export function splitContractVersions(fullText: string): {
  versions: ContractVersion[];
  single: boolean;
} {
  const lines = fullText.split(/\n/);
  const boundaries: Array<{ line: number; label: string }> = [];

  for (const { pattern, labelFromMatch } of BOUNDARY_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pattern);
      if (m) {
        boundaries.push({
          line: i,
          label: labelFromMatch?.(m) ?? lines[i].trim(),
        });
        break;
      }
    }
  }

  const secondTitle = findSecondAgreementTitle(lines);
  if (secondTitle !== null && !boundaries.some((b) => Math.abs(b.line - secondTitle) < 3)) {
    boundaries.push({ line: secondTitle, label: "Version 2" });
  }

  boundaries.sort((a, b) => a.line - b.line);

  // Deduplicate boundaries within 5 lines
  const unique: typeof boundaries = [];
  for (const b of boundaries) {
    if (unique.some((u) => Math.abs(u.line - b.line) < 5)) continue;
    unique.push(b);
  }

  if (unique.length === 0) {
    return {
      versions: [{ label: "document", text: fullText.trim(), line_start: 1 }],
      single: true,
    };
  }

  const versions: ContractVersion[] = [];
  const starts = [0, ...unique.map((b) => b.line)];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const chunk = lines.slice(start, end).join("\n").trim();
    if (chunk.length < 200) continue;

    const label =
      i === 0
        ? "Version 1 (company / earlier draft)"
        : unique[i - 1]?.label ?? `Version ${i + 1}`;

    versions.push({ label, text: chunk, line_start: start + 1 });
  }

  if (versions.length < 2) {
    return {
      versions: [{ label: "document", text: fullText.trim(), line_start: 1 }],
      single: true,
    };
  }

  return { versions, single: false };
}
