/**
 * legalCounsel/dealMemo.ts — Deterministic deal memo builder (no LLM).
 *
 * Takes reconciled findings + signals + leverage and produces the user-facing deal memo:
 *   sign_blockers   — must fix before signature (critical findings + blocking_issues)
 *   negotiate       — company-unfavorable terms to push back on (high severity, counterparty-favorable)
 *   accept_or_monitor — acceptable or watch-only (low/info)
 *   tax_equity_checklist — 83(b), 409A, QSBS, DGCL 144, RSPA action items
 *   version_delta_bullets — max 5 bullets summarizing A→B changes (not 20 diffs inline)
 */

import type { GroundedFinding, InferredFinding } from "./grounding.js";
import type { ContractSignals } from "./contractSignals.js";
import type { VersionDiffItem } from "./diffVersions.js";

export interface SignBlocker {
  issue: string;
  slug?: string;
  action_required: string;
  source: "grounded" | "inferred" | "deterministic";
}

export interface NegotiateItem {
  issue: string;
  company_ask: string;
  trade?: string;
  slug?: string;
}

export interface MonitorItem {
  issue: string;
  note: string;
}

export interface DealMemo {
  perspective: "company" | "counterparty" | "neutral";
  overall_risk: "critical" | "high" | "medium" | "low";
  executive_summary: string;
  sign_blockers: SignBlocker[];
  negotiate: NegotiateItem[];
  accept_or_monitor: MonitorItem[];
  tax_equity_checklist: string[];
  version_delta_bullets?: string[];
}

function severityRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s] ?? 0;
}

export function buildDealMemo(opts: {
  perspective: "company" | "counterparty" | "neutral";
  overall_risk: "critical" | "high" | "medium" | "low";
  executive_summary: string;
  findings_grounded: GroundedFinding[];
  findings_inferred: InferredFinding[];
  blocking_issues: string[];
  signals: ContractSignals;
  versionDiffs?: VersionDiffItem[];
}): DealMemo {
  const {
    perspective,
    overall_risk,
    executive_summary,
    findings_grounded,
    findings_inferred,
    blocking_issues,
    signals,
    versionDiffs,
  } = opts;

  // ── sign_blockers ─────────────────────────────────────────────────────────
  const sign_blockers: SignBlocker[] = [];
  const blockerSeen = new Set<string>();

  // From critical grounded findings
  for (const f of findings_grounded.filter(f => f.severity === "critical")) {
    const key = f.issue.slice(0, 60);
    if (blockerSeen.has(key)) continue;
    blockerSeen.add(key);
    sign_blockers.push({
      issue: f.issue,
      slug: f.slug,
      action_required: f.recommendation,
      source: "grounded",
    });
  }

  // From critical inferred findings
  for (const f of findings_inferred.filter(f => f.severity === "critical")) {
    const key = f.issue.slice(0, 60);
    if (blockerSeen.has(key)) continue;
    blockerSeen.add(key);
    sign_blockers.push({
      issue: f.issue,
      action_required: f.reason,
      source: "inferred",
    });
  }

  // From deterministic blocking_issues
  for (const b of blocking_issues) {
    const key = b.slice(0, 60);
    if (blockerSeen.has(key)) continue;
    blockerSeen.add(key);
    sign_blockers.push({
      issue: b,
      action_required: b,
      source: "deterministic",
    });
  }

  // ── negotiate ─────────────────────────────────────────────────────────────
  const negotiate: NegotiateItem[] = [];
  const negSeen = new Set<string>();

  const highFindings = [
    ...findings_grounded.filter(f => f.severity === "high"),
    ...findings_inferred.filter(f => f.severity === "high"),
  ].sort((a, b) => severityRank(b.severity ?? "low") - severityRank(a.severity ?? "low"));

  for (const f of highFindings) {
    const key = f.issue.slice(0, 60);
    if (negSeen.has(key)) continue;
    negSeen.add(key);
    const rec = "recommendation" in f ? f.recommendation : f.reason;
    negotiate.push({
      issue: f.issue,
      company_ask: rec,
      slug: "slug" in f ? f.slug : undefined,
    });
  }

  // ── accept_or_monitor ─────────────────────────────────────────────────────
  const accept_or_monitor: MonitorItem[] = [];
  const monSeen = new Set<string>();

  for (const f of [...findings_grounded, ...findings_inferred].filter(
    f => f.severity === "low" || f.severity === "info" || f.severity === "medium"
  )) {
    const key = f.issue.slice(0, 60);
    if (monSeen.has(key) || negSeen.has(key) || blockerSeen.has(key)) continue;
    monSeen.add(key);
    accept_or_monitor.push({
      issue: f.issue,
      note: "recommendation" in f ? f.recommendation : f.reason,
    });
  }

  // ── tax_equity_checklist ──────────────────────────────────────────────────
  const tax_equity_checklist: string[] = [];

  if (signals.has_83b) {
    tax_equity_checklist.push(
      "§83(b) election: file via certified mail within 30 days of grant date — non-waivable IRS deadline. Retain proof of mailing.",
    );
  }
  if (signals.has_restricted_stock) {
    tax_equity_checklist.push(
      "IRC §1202 QSBS: confirm gross assets < $75M at issuance (post-OBBBA ceiling). Document original-issue stock.",
    );
    tax_equity_checklist.push(
      "IRC §409A: obtain 409A valuation before grant; set purchase price at FMV; board consent with valuation date.",
    );
    tax_equity_checklist.push(
      "DGCL §144: obtain disinterested board (and stockholder if needed) approval for issuance to CMO/board-affiliated grantee.",
    );
    tax_equity_checklist.push(
      "RSPA mechanics: confirm grant date, share count, purchase price, and vesting schedule match board consent.",
    );
  }
  if (signals.has_schedule_c_blank) {
    tax_equity_checklist.push(
      "Schedule C (Pre-Existing IP): complete before signing — blank schedule is a sign blocker.",
    );
  }
  if (signals.has_acceleration) {
    tax_equity_checklist.push(
      "Acceleration: model single-trigger and without-Cause acceleration cost on cap table before accepting.",
    );
  }

  // ── version_delta_bullets ─────────────────────────────────────────────────
  let version_delta_bullets: string[] | undefined;
  if (versionDiffs && versionDiffs.length > 0) {
    // Sort by significance: critical > material > minor
    const ranked = [...versionDiffs].sort((a, b) => {
      const rank = { critical: 3, material: 2, minor: 1 };
      return (rank[b.significance as keyof typeof rank] ?? 0) - (rank[a.significance as keyof typeof rank] ?? 0);
    });
    version_delta_bullets = ranked.slice(0, 5).map(d => {
      const sig = d.significance === "critical" ? "🔴" : d.significance === "material" ? "🟡" : "⚪";
      return `${sig} ${d.section_heading}: ${d.change_type} — ${d.version_a_excerpt?.slice(0, 80) ?? "removed"} → ${d.version_b_excerpt?.slice(0, 80) ?? "added"}`;
    });
  }

  return {
    perspective,
    overall_risk,
    executive_summary,
    sign_blockers,
    negotiate,
    accept_or_monitor,
    tax_equity_checklist,
    version_delta_bullets,
  };
}
