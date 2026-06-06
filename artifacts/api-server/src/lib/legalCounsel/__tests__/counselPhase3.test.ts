/**
 * Phase 3 counsel unit tests — version split, diff, digest, grounding.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitContractVersions } from "../splitVersions.js";
import { diffContractVersions, buildVersionRedlines } from "../diffVersions.js";
import { buildFullContractDigest, buildMultiRetrievalQueries } from "../buildDigest.js";
import { chunkContractSections } from "../chunkContract.js";
import { partitionAndValidateFindings } from "../grounding.js";
import { runLegalCounselDiff } from "../pipeline.js";
import { counselGovernanceBlock } from "../disclaimer.js";
import { detectContractSignals, buildStatuteRetrievalQueries } from "../contractSignals.js";
import { buildCompanyLeverageFindings, enrichGroundedStatuteFindings } from "../companyLeverage.js";
import { COFOUNDER_STATUTE_SLUGS } from "../../legalCorpus/cofounderSlugs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRISPRO_FIXTURE = resolve(__dirname, "../../legalCorpus/__tests__/fixtures/crispro-v3.1.txt");

describe("legalCounsel Phase 3 — splitVersions", () => {
  it("splits CrisPRO fixture into two versions", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions, single } = splitContractVersions(text);
    expect(single).toBe(false);
    expect(versions.length).toBe(2);
    expect(versions[0]!.text).toMatch(/Independent Contractor|Dr\. Robin Kim/i);
    expect(versions[1]!.text).toMatch(/Full Time Employee|Robin Kim, MD/i);
  });

  it("returns single for one agreement", () => {
    const one = "1. Purpose\nThis is a test agreement with enough text to pass validation.\n".repeat(20);
    const { single, versions } = splitContractVersions(one);
    expect(single).toBe(true);
    expect(versions).toHaveLength(1);
  });
});

describe("legalCounsel Phase 3 — diffVersions", () => {
  it("flags contractor vs employee classification change", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions } = splitContractVersions(text);
    const diffs = diffContractVersions(versions[0]!, versions[1]!);
    expect(diffs.length).toBeGreaterThan(5);
    const statusDiff = diffs.find((d) => /Status|Services|3/i.test(d.section_heading));
    expect(statusDiff).toBeDefined();
    const redlines = buildVersionRedlines(diffs);
    expect(redlines.some((r) => /classification|employee|contractor/i.test(r.negotiation_note + r.change_summary))).toBe(true);
  });

  it("runLegalCounselDiff returns governance disclaimer", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions } = splitContractVersions(text);
    const out = runLegalCounselDiff(versions[0]!.text, versions[1]!.text);
    expect(out.governance.not_legal_advice).toBe(true);
    expect(out.summary.critical).toBeGreaterThan(0);
  });
});

describe("legalCounsel Phase 3 — full document digest", () => {
  it("includes all sections within budget for CrisPRO v2", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions } = splitContractVersions(text);
    const sections = chunkContractSections(versions[1]!.text);
    const digest = buildFullContractDigest(sections);
    expect(digest.sections_included).toBe(sections.length);
    expect(digest.coverage_pct).toBe(1);
    expect(digest.chars_sent).toBeGreaterThan(10_000);
  });

  it("buildMultiRetrievalQueries samples start/middle/end", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const sections = chunkContractSections(text);
    const queries = buildMultiRetrievalQueries(sections, "CrisPRO cofounder", 500, text);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries[0]).toContain("CrisPRO");
  });
});

describe("legalCounsel Phase 3 — grounding", () => {
  it("drops invalid chunk_id and keeps valid slug match", () => {
    const partitioned = partitionAndValidateFindings(
      {
        findings_grounded: [
          {
            lens: "tax",
            severity: "high",
            issue: "83b window",
            chunk_id: 999999,
            slug: "irc-83b",
            recommendation: "File within 30 days",
          },
          {
            lens: "tax",
            severity: "high",
            issue: "valid hit",
            chunk_id: 42,
            slug: "irc-83b",
            recommendation: "File on time",
          },
        ],
        findings_inferred: [],
        lens_findings: [],
      },
      [
        {
          chunk_id: 42,
          document_id: 1,
          slug: "irc-83b",
          title: "IRC 83b",
          citation: "IRC §83(b)",
          domain: "cofounder",
          priority: "critical",
          rank: 0.9,
          content: "Section 83(b) election must be filed within 30 days of grant.",
        },
      ],
    );
    expect(partitioned.findings_grounded).toHaveLength(1);
    expect(partitioned.findings_grounded[0]!.chunk_id).toBe(42);
    expect(partitioned.findings_inferred.some((i) => i.reason.includes("not in retrieval"))).toBe(true);
  });
});

describe("legalCounsel Phase 3 — governance", () => {
  it("includes not_legal_advice disclaimer", () => {
    const g = counselGovernanceBlock();
    expect(g.not_legal_advice).toBe(true);
    expect(g.disclaimer.toLowerCase()).toContain("not legal advice");
  });
});

describe("legalCounsel Phase 3 — contract signals & company leverage", () => {
  it("COFOUNDER_STATUTE_SLUGS use ingested corpus names (not boot seeds)", () => {
    expect(COFOUNDER_STATUTE_SLUGS).toContain("irc-83b");
    expect(COFOUNDER_STATUTE_SLUGS).toContain("dgcl-144");
    expect(COFOUNDER_STATUTE_SLUGS).not.toContain("qsbs-post-obbba");
    expect(COFOUNDER_STATUTE_SLUGS).not.toContain("irc-83b-election");
  });

  it("detects CrisPRO v2 signals and statute queries", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions } = splitContractVersions(text);
    const signals = detectContractSignals(versions[1]!.text);
    expect(signals.has_83b).toBe(true);
    expect(signals.has_mutual_dependency).toBe(true);
    expect(signals.has_schedule_c_blank).toBe(true);
    expect(signals.has_employee_classification).toBe(true);
    const statuteQs = buildStatuteRetrievalQueries(signals);
    expect(statuteQs.some((q) => /83b/i.test(q))).toBe(true);
  });

  it("company leverage flags Mutual Dependency for company perspective", () => {
    const text = readFileSync(CRISPRO_FIXTURE, "utf-8");
    const { versions } = splitContractVersions(text);
    const signals = detectContractSignals(versions[1]!.text);
    const { inferred, blocking } = buildCompanyLeverageFindings(
      versions[1]!.text,
      signals,
      undefined,
      "company",
    );
    expect(inferred.some((i) => /mutual dependency/i.test(i.issue))).toBe(true);
    expect(blocking.some((b) => /mutual dependency/i.test(b))).toBe(true);
  });

  it("enrichGroundedStatuteFindings adds irc-83b when signal + hit present", () => {
    const signals = detectContractSignals("Section 83(b) election within 30 days");
    const hits = [
      {
        chunk_id: 7,
        document_id: 1,
        slug: "irc-83b",
        title: "IRC 83b",
        citation: "IRC §83(b)",
        domain: "tax",
        priority: "critical",
        rank: 1,
        content: "File within 30 days of transfer.",
      },
    ];
    const enriched = enrichGroundedStatuteFindings([], hits, signals);
    expect(enriched.some((g) => g.slug === "irc-83b")).toBe(true);
    expect(enriched.length).toBeGreaterThanOrEqual(1);
  });
});
