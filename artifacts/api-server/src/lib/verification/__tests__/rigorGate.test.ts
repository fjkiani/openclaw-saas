/**
 * rigorGate.test.ts — tests for the domain-agnostic anti-slop verification core.
 *
 * Four things this suite pins down:
 *   1. The FAIL-CLOSED law: a degraded guardian can NEVER produce a trustworthy PASS, an uncaught
 *      throw becomes degraded (not a silent pass), and an unknown domain fails.
 *   2. Each reusable guardian's behavior, including the two calibration fixes
 *      (bidirectional numeric parse; hedge absolute-count trigger).
 *   3. Reconciliation (GAP-1): the NEW assembleFullTextV2 path reproduces the OLD buildDraft
 *      output exactly — no case is "genuinely different".
 *   4. Extensibility (GAP-2): a from-scratch domain (sql_gen) plugs in through the same adapter
 *      contract with zero core changes, and the multi-domain benchmark meets its targets.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  runGate,
  verify,
  registerDomain,
  getDomain,
  listDomains,
  clearDomains,
  type Guardian,
  type GateContext,
  type GuardianResult,
} from "../verificationCore.js";
import {
  makeMaterialityGuardian,
  makeNumericalGuardian,
  makeHedgeGuardian,
  makeSelfConsistencyGuardian,
  makeRequiredEntitiesGuardian,
  extractQuantities,
  splitSections,
  JUDGE_CHAIN,
  makeRubricGuardian,
} from "../guardians.js";
import { registerAllDomains } from "../registerAll.js";
import { LEGAL_DRAFT_DOMAIN } from "../domains/legalDraft.js";
import { MCP_SERVER_DOMAIN } from "../domains/mcpServer.js";
import { GENERIC_LLM_DOMAIN, genericLlmAdapter } from "../domains/genericLlm.js";
import { SQL_GEN_DOMAIN } from "../domains/sqlGen.js";
import { reconcile, assembleFullTextV2 } from "../recon/reconcile.js";
import { runBenchmark } from "../bench/runBenchmark.js";
import { deriveReport } from "../bench/rubricCalibration.js";
import { auditReasons, jurisdictionPresent } from "../bench/judgeBaseline.js";
import { scorePanel, runAudit } from "../bench/rigorAudit.js";
import { RECON_INTAKES } from "../bench/reconIntakes.js";
import { buildDraft } from "../../draftEngine.js";

const CTX: GateContext = { domain: "test", live: false };

// small guardian factories for the core-law tests
const passG = (name: string): Guardian<unknown> => ({
  name,
  run: () => ({ guardian: name, status: "pass", live: true, reasons: ["ok"] }),
});
const failG = (name: string): Guardian<unknown> => ({
  name,
  run: () => ({ guardian: name, status: "fail", live: true, reasons: ["nope"] }),
});
const degradedG = (name: string): Guardian<unknown> => ({
  name,
  run: () => ({ guardian: name, status: "degraded", live: false, reasons: ["could not check"] }),
});
const throwG = (name: string): Guardian<unknown> => ({
  name,
  run: () => {
    throw new Error("boom");
  },
});

// ── 1. FAIL-CLOSED LAW ────────────────────────────────────────────────────────
describe("runGate — fail-closed law", () => {
  it("all guardians pass ⇒ PASS + verified", async () => {
    const v = await runGate({}, [passG("a"), passG("b")], CTX);
    expect(v.verdict).toBe("PASS");
    expect(v.verified).toBe(true);
    expect(v.n_verified).toBe(2);
    expect(v.n_total).toBe(2);
  });

  it("any fail ⇒ FAIL (still verified, because it was actually checked)", async () => {
    const v = await runGate({}, [passG("a"), failG("b")], CTX);
    expect(v.verdict).toBe("FAIL");
    expect(v.verified).toBe(true); // nothing was degraded; the failure is a real, checked failure
  });

  it("a degraded guardian can NEVER yield a trustworthy PASS", async () => {
    const v = await runGate({}, [passG("a"), degradedG("b")], CTX);
    expect(v.verdict).toBe("FAIL");
    expect(v.verified).toBe(false); // the crux: could-not-check forces FAIL and verified=false
    expect(v.reasons.join(" ")).toMatch(/fail-closed/i);
  });

  it("an uncaught throw becomes degraded, not a silent pass", async () => {
    const v = await runGate({}, [passG("a"), throwG("b")], CTX);
    expect(v.verdict).toBe("FAIL");
    expect(v.verified).toBe(false);
    expect(v.per_guardian.find((g) => g.guardian === "b")?.status).toBe("degraded");
    expect(v.per_guardian.find((g) => g.guardian === "b")?.reasons.join(" ")).toMatch(/threw/i);
  });

  it("n_verified counts only guardians that actually ran live", async () => {
    // one live pass + one dry/degraded ⇒ n_verified = 1
    const v = await runGate({}, [passG("a"), degradedG("b")], CTX);
    expect(v.n_verified).toBe(1);
  });
});

// ── 2. REGISTRY + unknown-domain fail-closed ─────────────────────────────────
describe("registry + verify()", () => {
  beforeEach(() => clearDomains());

  it("registerDomain rejects an empty guardian panel", () => {
    expect(() =>
      registerDomain({ domain: "x", prepare: (r: unknown) => r, guardians: [] } as any),
    ).toThrow(/at least one guardian/i);
  });

  it("registerDomain rejects a missing domain id", () => {
    expect(() =>
      registerDomain({ domain: "", prepare: (r: unknown) => r, guardians: [passG("a")] } as any),
    ).toThrow(/domain is required/i);
  });

  it("verify() on an UNKNOWN domain is fail-closed", async () => {
    const v = await verify("does_not_exist", {}, { live: false });
    expect(v.verdict).toBe("FAIL");
    expect(v.verified).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/no adapter registered/i);
  });

  it("registerAllDomains registers exactly the four shipped domains", () => {
    registerAllDomains();
    expect(listDomains()).toEqual(
      [GENERIC_LLM_DOMAIN, LEGAL_DRAFT_DOMAIN, MCP_SERVER_DOMAIN, SQL_GEN_DOMAIN].sort(),
    );
    expect(getDomain(SQL_GEN_DOMAIN)).toBeDefined();
  });

  it("verify() honors exclude to drop a guardian from the panel", async () => {
    registerAllDomains();
    const raw = { text: "short", required_numbers: {} };
    const full = await verify(GENERIC_LLM_DOMAIN, raw, { live: false });
    const trimmed = await verify(GENERIC_LLM_DOMAIN, raw, { live: false, exclude: ["rubric"] });
    expect(trimmed.n_total).toBe(full.n_total - 1);
  });
});

// ── 3. GUARDIAN UNITS ─────────────────────────────────────────────────────────
describe("materiality guardian", () => {
  const g = makeMaterialityGuardian({ getText: (i: any) => i.text, minLength: 40 });

  it("fails empty / too-short output", async () => {
    const r = (await g.run({ text: "N/A" }, CTX)) as GuardianResult;
    expect(r.status).toBe("fail");
  });

  it("fails on placeholder markers", async () => {
    const r = (await g.run(
      { text: "This is a long enough answer but it still contains a TODO marker inside it here." },
      CTX,
    )) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/placeholder|TODO/i);
  });

  it("passes substantive, finished text with no unfinished markers", async () => {
    const r = (await g.run(
      { text: "This answer is comfortably longer than the minimum length and is a complete, finished statement." },
      CTX,
    )) as GuardianResult;
    expect(r.status).toBe("pass");
  });
});

describe("numerical guardian", () => {
  it("fails when a claimed number contradicts the source of truth", async () => {
    const g = makeNumericalGuardian({
      extractClaims: () => [{ label: "revenue", claimed: 999, expected: 1200000 }],
    });
    const r = (await g.run({}, CTX)) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/revenue/);
  });

  it("fails when a required number is missing (claimed=null)", async () => {
    const g = makeNumericalGuardian({
      extractClaims: () => [{ label: "revenue", claimed: null, expected: 1200000 }],
    });
    const r = (await g.run({}, CTX)) as GuardianResult;
    expect(r.status).toBe("fail");
  });

  it("passes when claims match within tolerance", async () => {
    const g = makeNumericalGuardian({
      extractClaims: () => [{ label: "pi", claimed: 3.14, expected: 3.14159, tol: 0.01 }],
    });
    const r = (await g.run({}, CTX)) as GuardianResult;
    expect(r.status).toBe("pass");
  });
});

describe("numerical guardian — bidirectional parse fix (gen_clean_1 regression)", () => {
  // The generic adapter's default parser must read a value that PRECEDES its label
  // ("3 phases"), not only one that follows it ("revenue was 999").
  const prep = genericLlmAdapter.prepare;
  const panel = genericLlmAdapter.guardians;
  const numerical = panel.find((g) => g.name === "numerical")!;

  it("parses a pre-nominal number: 'completed in 3 phases' with required {phases:3} ⇒ pass", async () => {
    const input = prep({
      text: "The migration completed in 3 phases with zero downtime.",
      required_numbers: { phases: 3 },
    });
    const r = (await numerical.run(input, { domain: GENERIC_LLM_DOMAIN, live: false })) as GuardianResult;
    expect(r.status).toBe("pass");
  });

  it("still parses a post-nominal number: 'revenue was 999' with required {revenue:1200000} ⇒ fail", async () => {
    const input = prep({
      text: "Revenue was 999 dollars in FY24.",
      required_numbers: { revenue: 1200000 },
    });
    const r = (await numerical.run(input, { domain: GENERIC_LLM_DOMAIN, live: false })) as GuardianResult;
    expect(r.status).toBe("fail");
  });

  it("chooses the NEAREST number to the label when both sides have digits", async () => {
    // "5 reports were sent; phases were 3" — label 'phases' should bind to the nearer 3, not the 5.
    const input = prep({
      text: "5 reports were sent and the phases were 3 in total.",
      required_numbers: { phases: 3 },
    });
    const r = (await numerical.run(input, { domain: GENERIC_LLM_DOMAIN, live: false })) as GuardianResult;
    expect(r.status).toBe("pass");
  });
});

describe("hedge guardian", () => {
  it("passes committal text", async () => {
    const g = makeHedgeGuardian({ getText: (i: any) => i.text });
    const r = (await g.run({ text: "The party shall deliver the goods on 2025-01-01. Payment is due on receipt." }, CTX)) as GuardianResult;
    expect(r.status).toBe("pass");
  });

  it("fails hedge-dense text by density", async () => {
    const g = makeHedgeGuardian({ getText: (i: any) => i.text, maxPer1k: 3 });
    const r = (await g.run(
      { text: "It depends, possibly, it seems, arguably, perhaps, hard to say, may or may not." },
      CTX,
    )) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/hedg|weasel/i);
  });

  it("maxCount fix: a handful of hedges in a LONG doc still fails (density would dilute)", async () => {
    // ~4000 chars of committal filler + 4 hedge phrases: density is under 2/1k but count is >= 3.
    const filler = "The party shall perform the obligation without exception. ".repeat(70); // ~4000 chars
    const hedged = filler + " it depends on interpretation; possibly the parties may or may not be bound, and it seems arguably unclear.";
    const g = makeHedgeGuardian({ getText: (i: any) => i.text, maxPer1k: 2, maxCount: 3 });
    const r = (await g.run({ text: hedged }, CTX)) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/absolute count/i);
    expect((r.evidence as any)?.countFail).toBe(true);
    expect((r.evidence as any)?.densityFail).toBe(false); // proves the density gate alone would have missed it
  });
});

describe("rubric guardian — dry-run is degraded (fail-closed)", () => {
  it("with no live intent, the LLM judge degrades rather than fake-passing", async () => {
    const g = makeRubricGuardian({ getText: (i: any) => i.text });
    const r = (await g.run({ text: "some output" }, { domain: "test", live: false })) as GuardianResult;
    expect(r.status).toBe("degraded");
    expect(r.live).toBe(false);
  });
});

// ── 4. RECONCILIATION (GAP-1) ─────────────────────────────────────────────────
describe("reconciliation — NEW assembleFullTextV2 reproduces OLD buildDraft (GAP-1)", () => {
  it("assembleFullTextV2 equals buildDraft.full_text for every real intake", () => {
    for (const intake of RECON_INTAKES) {
      const built = buildDraft(intake);
      const rebuilt = assembleFullTextV2(built.sections);
      expect(rebuilt).toBe(built.full_text);
    }
  });

  it("reconcile() reports 100% exact and recommends cutover, no genuinely-different case", () => {
    const rep = reconcile(RECON_INTAKES, 1.0);
    expect(rep.n).toBe(RECON_INTAKES.length);
    expect(rep.items.every((i) => i.bucket === "exactly_equal")).toBe(true);
    expect(rep.buckets.exactly_equal).toBe(RECON_INTAKES.length);
    expect(rep.buckets.genuinely_different).toBe(0);
    expect(rep.genuine_diffs).toHaveLength(0);
    expect(rep.exact_rate).toBe(1);
    expect(rep.agreement_rate).toBe(1);
    expect(rep.cutover_recommended).toBe(true);
  });
});

// ── 5. NEW-DOMAIN SMOKE + BENCHMARK INTEGRITY (GAP-2) ─────────────────────────
describe("sql_gen — from-scratch domain plugs in with zero core changes", () => {
  beforeEach(() => {
    clearDomains();
    registerAllDomains();
  });

  it("a safe, bounded SELECT passes the deterministic panel", async () => {
    const v = await verify(
      SQL_GEN_DOMAIN,
      { sql: "SELECT id, name FROM users WHERE active = true LIMIT 100;", request: "list up to 100 active users", requestedLimit: 100 },
      { live: false, exclude: ["rubric"] },
    );
    expect(v.verdict).toBe("PASS");
  });

  it("a destructive statement is rejected on safety", async () => {
    const v = await verify(
      SQL_GEN_DOMAIN,
      { sql: "DROP TABLE users;", request: "list users", requestedLimit: 100 },
      { live: false, exclude: ["rubric"] },
    );
    expect(v.verdict).toBe("FAIL");
    expect(v.per_guardian.find((g) => g.guardian === "safety")?.status).toBe("fail");
  });

  it("a tautology injection (OR 1=1) is rejected on safety", async () => {
    const v = await verify(
      SQL_GEN_DOMAIN,
      { sql: "SELECT * FROM users WHERE name = '' OR 1=1 LIMIT 100;", request: "find a user", requestedLimit: 100 },
      { live: false, exclude: ["rubric"] },
    );
    expect(v.verdict).toBe("FAIL");
  });
});

describe("multi-domain benchmark — meets targets on the deterministic panel", () => {
  it("overall recall = 100%, false-reject = 0%, and self-grade baseline is far worse", async () => {
    const rep = await runBenchmark({ live: false });
    expect(rep.rubric_mode).toBe("excluded_offline");
    // panel catches every seeded slop and rejects no clean fixture
    expect(rep.overall.recall).toBe(1);
    expect(rep.overall.false_reject_rate).toBe(0);
    // the self-grade figure is a hand-written lower-bound stub, NOT a measured LLM judge; it is
    // kept only as a floor, and its own note must say so (see the disclosure test below)
    expect(rep.self_grade_baseline.recall).toBeLessThan(0.2);
    expect(rep.self_grade_baseline.recall).toBeLessThan(rep.overall.recall);
    // all four domains present
    expect(rep.by_domain.map((d) => d.domain).sort()).toEqual(
      [GENERIC_LLM_DOMAIN, LEGAL_DRAFT_DOMAIN, MCP_SERVER_DOMAIN, SQL_GEN_DOMAIN].sort(),
    );
  });

  it("every domain reaches 100% recall with 0% false-reject on the deterministic panel", async () => {
    const rep = await runBenchmark({ live: false });
    for (const d of rep.by_domain) {
      expect(d.recall, `${d.domain} recall`).toBe(1);
      expect(d.false_reject_rate, `${d.domain} FRR`).toBe(0);
    }
  });
});

// ── 5. AUDIT INVARIANTS (methodology, not just outcomes) ──────────────────────
// These lock down the three audit findings in RESULTS.md so a future change cannot quietly
// reintroduce the weaknesses: the rubric exclusion must stay justified by measurement, every
// guardian must keep earning its place, and the panel must not claim depth it does not have.
describe("audit — the rubric exclusion is justified by measurement, not convenience", () => {
  beforeEach(() => { clearDomains(); registerAllDomains(); });

  it("with the rubric INCLUDED and no model key, false-reject is severe while deterministic is 0", async () => {
    const withRubric = await scorePanel([]);
    const deterministic = await scorePanel(["rubric"]);
    expect(deterministic.false_reject_rate).toBe(0);
    // a keyless rubric makes the benchmark degenerate: clean output is rejected en masse
    expect(withRubric.false_reject_rate).toBeGreaterThan(0.5);
    // recall stays 100% only because EVERYTHING fails, so recall alone is not evidence
    expect(withRubric.recall).toBe(1);
    expect(withRubric.conf.fp).toBeGreaterThan(0);
  });

  it("the gate signals its own blindness: more fixtures unverifiable than substantively defective", async () => {
    const withRubric = await scorePanel([]);
    // it says "I could not check this" rather than inventing a rubric score or passing silently
    expect(withRubric.n_unverifiable).toBeGreaterThan(withRubric.n_substantive_fail);
    const deterministic = await scorePanel(["rubric"]);
    expect(deterministic.n_unverifiable).toBe(0);
  });

  it("only rubric-bearing domains go unverifiable without a key; mcp_server has no rubric", async () => {
    const withRubric = await scorePanel([]);
    const clean = withRubric.outcomes.filter((o) => o.label === "clean");
    for (const o of clean) {
      if (o.domain === MCP_SERVER_DOMAIN) {
        // no rubric in this panel, so nothing degrades and the clean fixture still passes
        expect(o.verified, `${o.id} verified`).toBe(true);
        expect(o.verdict, `${o.id} verdict`).toBe("PASS");
      } else {
        expect(o.degraded_guardians, `${o.id} degraded`).toContain("rubric");
        expect(o.verified, `${o.id} verified`).toBe(false);
      }
    }
  });
});

describe("audit — ablation: what each guardian is actually worth", () => {
  // The first version of this suite asserted that removing ANY guardian must cost recall. That held
  // only while every slop fixture had exactly one defect. Once the corpus contained real generator
  // output with TWO independent defects in the same document, guardians began covering for each
  // other and the assertion became false — not because a guardian became worthless, but because
  // "individually necessary" was never the right property to demand. What is required is that no
  // guardian is dead weight (each one catches something) and that none buys recall by rejecting
  // clean output. Necessity is measured and reported in the artifact, not asserted here.
  it("no guardian is dead weight: every one catches at least one slop fixture", async () => {
    const audit = await runAudit();
    expect(audit.deterministic_panel.recall).toBe(1);
    expect(audit.ablation.length).toBeGreaterThanOrEqual(10);
    const rep = await runBenchmark({ live: false });
    const caught = new Set<string>();
    for (const d of rep.by_domain) {
      for (const [name, g] of Object.entries(d.per_guardian_recall)) if (g.caught > 0) caught.add(name);
    }
    for (const a of audit.ablation) {
      expect(caught.has(a.removed), `${a.removed} never caught anything`).toBe(true);
    }
  });

  it("removing a guardian never lowers the false-reject rate, so none is buying recall with false rejects", async () => {
    const audit = await runAudit();
    for (const a of audit.ablation) {
      expect(a.false_reject_rate, `removing ${a.removed} FRR`).toBe(0);
      expect(a.recall_drop, `removing ${a.removed} cannot increase recall`).toBeGreaterThanOrEqual(0);
      // drop and newly-missed must agree: a positive drop implies named escapees, and vice versa.
      expect(a.recall_drop > 0).toBe(a.newly_missed.length > 0);
    }
  });

  it("the guardians added after adjudication are each the sole catcher of at least one real defect", async () => {
    const audit = await runAudit();
    const sole = audit.redundancy.sole_catch_by_guardian;
    expect((sole.self_consistency ?? []).length).toBeGreaterThan(0);
    expect((sole.required_entities ?? []).length).toBeGreaterThan(0);
    // and those sole catches are unmutated generator output, not seeded mutations
    const soleIds = [...(sole.self_consistency ?? []), ...(sole.required_entities ?? [])];
    expect(soleIds.some((id) => id.includes("baseline"))).toBe(true);
  });

  // The first version of this test hardcoded `numerical` as the top contributor. That is a property
  // of one fixture mix, not of the framework — relabelling one mislabeled baseline moved the top
  // slot to `hedge`. Assert the invariant (the panel is not flat, and no guardian buys recall with
  // false rejects) and let the artifact report which guardian currently leads.
  // The ablation is FLAT, and that is the finding: on 36 slop fixtures the largest single-guardian
  // removal costs about 8 points of recall. No guardian is close to carrying the panel, which also
  // means no single guardian's calibration can be trusted to hold the line on its own.
  it("no single guardian carries the panel: the largest removal costs under 20 points of recall", async () => {
    const audit = await runAudit();
    const sorted = [...audit.ablation].sort((x, y) => y.recall_drop - x.recall_drop);
    expect(sorted[0]!.recall_drop).toBeGreaterThan(0);
    expect(sorted[0]!.recall_drop).toBeLessThan(0.2);
    expect(sorted.every((a) => a.false_reject_rate === 0)).toBe(true);
  });
});

describe("audit — the panel is breadth, not redundancy (documented weakness)", () => {
  it("most slop is caught by exactly one guardian, so per-guardian calibration is load-bearing", async () => {
    const audit = await runAudit();
    const r = audit.redundancy;
    // This asserts the CURRENT, honestly-reported shape of the panel. If real redundancy is added
    // later this test should be updated deliberately, not silently.
    expect(r.n_slop_with_single_catcher).toBeGreaterThan(0);
    expect(r.n_slop_with_single_catcher).toBeLessThan(r.n_slop);
    expect(r.depth_histogram_slop["1"]).toBe(r.n_slop_with_single_catcher);
    // the histogram must account for every slop fixture, with no fixture caught by zero guardians
    const hist = r.depth_histogram_slop as Record<string, number>;
    expect(Object.values(hist).reduce((a, b) => a + b, 0)).toBe(r.n_slop);
    expect(hist["0"] ?? 0).toBe(0);
    // every guardian that is a sole catcher is a single point of failure for those fixtures
    const soleTotal = Object.values(r.sole_catch_by_guardian).reduce((n, ids) => n + ids.length, 0);
    expect(soleTotal).toBe(r.n_slop_with_single_catcher);
  });
});

describe("audit — the self-grade stub discloses what it is", () => {
  // Re-grounded. The original assertion required the note to say the LLM-judge comparison was
  // "unmeasured", which was true only while no model key existed. A real judge baseline has since
  // been measured (bench/judgeBaseline.ts), and it beat this stub by a wide margin, so demanding
  // the word "unmeasured" would now force the artifact to carry a false statement. The invariant
  // that actually matters is unchanged: the stub must not be presentable as the judge comparison,
  // and it must name where the measured baseline lives.
  it("its note refuses the judge comparison and points at the measured baseline", async () => {
    const rep = await runBenchmark({ live: false });
    const note = rep.self_grade_baseline.note.toLowerCase();
    expect(note).toContain("not a measured llm judge");
    expect(note).toContain("judgebaseline");
    expect(note).toContain("do not cite this stub");
  });

  it("offline runs carry no live_rubric block, live-mode fields stay absent when nothing ran live", async () => {
    const rep = await runBenchmark({ live: false });
    expect(rep.live).toBe(false);
    expect(rep.rubric_mode).toBe("excluded_offline");
    expect(rep.live_rubric).toBeUndefined();
    expect(rep.fixtures.every((f) => f.rubric === undefined)).toBe(true);
  });
});

// ── new guardians: self-consistency and required entities ────────────────────
// Both were added because a live LLM judge rejected a document this benchmark had labeled clean,
// and adjudication showed the judge was right. These tests pin the behaviour that was missing.
describe("self_consistency guardian — the artifact against itself", () => {
  const g = makeSelfConsistencyGuardian({ getText: (i: any) => i.text });
  const ctx: GateContext = { domain: "t", live: false };

  it("fails when a heading quantity contradicts its own section body", () => {
    const text = "## Vesting Schedule — 4yr/1yr cliff\n\nEquity shall vest over 2 years, with a cliff of 3 months.";
    const r = g.run({ text }, ctx) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toContain("4yr");
    expect((r.evidence!.contradictions as unknown[]).length).toBe(2);
  });

  it("normalises units, so a 1yr heading is satisfied by a 12 month body", () => {
    const text = "## Vesting Schedule — 4yr/1yr cliff\n\nEquity shall vest over 4 years, with a cliff of 12 months.";
    const r = g.run({ text }, ctx) as GuardianResult;
    expect(r.status).toBe("pass");
  });

  it("does not compare across dimensions: a 30 day window never contradicts a month figure", () => {
    const text = "## Election Window — 30 days\n\nThe election must be filed within 30 days of the grant date. Vesting runs 48 months.";
    const r = g.run({ text }, ctx) as GuardianResult;
    expect(r.status).toBe("pass");
  });

  it("ignores unit-less numbers so section references do not fire", () => {
    const text = "## Section 83(b) Election\n\nThe holder may file an election under Section 83(b) within 30 days.";
    const r = g.run({ text }, ctx) as GuardianResult;
    expect(r.status).toBe("pass");
  });

  it("treats an under-specified heading as unsupported, not as a contradiction, by default", () => {
    const text = "## Term — 12 months\n\nThis agreement continues until terminated by either party.";
    const dflt = g.run({ text }, ctx) as GuardianResult;
    expect(dflt.status).toBe("pass");
    expect((dflt.evidence!.unsupported as string[]).length).toBe(1);
    const strict = makeSelfConsistencyGuardian({ getText: (i: any) => i.text, failOnUnsupported: true }).run({ text }, ctx) as GuardianResult;
    expect(strict.status).toBe("fail");
  });

  it("extractQuantities and splitSections are usable on their own", () => {
    expect(extractQuantities("4yr/1yr").map((q) => q.base)).toEqual([48, 12]);
    expect(extractQuantities("$1,200 and 0.5%").map((q) => q.unit)).toEqual(["percent", "dollars"]);
    expect(splitSections("## A\n\nbody a\n\n## B\n\nbody b").map((s) => s.title)).toEqual(["A", "B"]);
  });
});

describe("required_entities guardian — the artifact names its own subject", () => {
  const g = makeRequiredEntitiesGuardian({
    getText: (i: any) => i.text,
    getEntities: (i: any) => i.entities,
  });
  const ctx: GateContext = { domain: "t", live: false };

  it("fails when a required entity never appears", () => {
    const r = g.run({ text: "The parties agree as set out below.", entities: [{ label: "party:advisor", any: ["Dr. Ada Wells", "Wells"] }] }, ctx) as GuardianResult;
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toContain("party:advisor");
  });

  it("accepts any one alternate, case- and whitespace-insensitively", () => {
    const r = g.run({ text: "Signed by   WELLS on behalf of the advisor.", entities: [{ label: "party:advisor", any: ["Dr. Ada Wells", "Wells"] }] }, ctx) as GuardianResult;
    expect(r.status).toBe("pass");
    expect(r.evidence!.present).toEqual(["party:advisor"]);
  });
});

describe("legal panel — the two new guardians are wired in, in order", () => {
  beforeEach(() => { clearDomains(); registerAllDomains(); });
  it("exposes six guardians with self_consistency and required_entities present", () => {
    const names = getDomain(LEGAL_DRAFT_DOMAIN)!.guardians.map((g) => g.name);
    expect(names).toEqual(["materiality", "numerical", "hedge", "self_consistency", "required_entities", "rubric"]);
  });
});

// ── live-judge wiring invariants ─────────────────────────────────────────────
// Each of these encodes a defect that was only visible once the rubric actually ran against a live
// model. They are cheap guards against silently regressing back to a dead configuration.
describe("rubric live path — wiring invariants found by running it", () => {
  it("JUDGE_CHAIN is non-empty, has no blank slugs, and spreads OpenRouter entries across key slots", () => {
    expect(JUDGE_CHAIN.length).toBeGreaterThanOrEqual(2);
    for (const e of JUDGE_CHAIN) {
      expect(e.id.trim().length).toBeGreaterThan(0);
      expect(e.apiKeyEnv.trim().length).toBeGreaterThan(0);
      expect(e.maxTokens).toBeGreaterThan(0);
      expect(e.timeoutMs).toBeGreaterThan(0);
    }
    const orKeys = JUDGE_CHAIN.filter((e) => e.provider === "openrouter").map((e) => e.apiKeyEnv);
    expect(new Set(orKeys).size).toBe(orKeys.length);
  });

  it("the retired free llama-3.3 slug is not back in the chain", () => {
    // meta-llama/llama-3.3-70b-instruct:free returns HTTP 404 upstream; it silently exhausted the
    // whole chain and made the rubric look permanently degraded.
    expect(JUDGE_CHAIN.map((e) => e.id)).not.toContain("meta-llama/llama-3.3-70b-instruct:free");
  });

  it("a live judge that returns only {overall, axes} is accepted, not discarded as unusable", async () => {
    // The router's default clause-shape check demands rationale_summary + recommended_action, so
    // every valid judge response was thrown away. The guardian must accept the judge's real shape.
    const g = makeRubricGuardian({
      getText: (i: any) => i.text,
      axes: ["a", "b"],
      invoke: async () => ({ overall: 0.95, axisScores: { a: 0.9, b: 0.9 }, model_used: "stub" }),
    });
    const r = (await g.run({ text: "x".repeat(300) }, { domain: "t", live: true })) as GuardianResult;
    expect(r.status).toBe("pass");
    expect(r.live).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The calibration report is the artifact most likely to be over-read: a threshold sweep computed on
// four surviving fixtures looks exactly like a sweep computed on forty. These tests hold the report
// to the same standard the framework applies to everything else — a number that cannot be supported
// must be withheld, and an outage must never be reported as agreement.
describe("rubric calibration report — coverage honesty", () => {
  type S = Parameters<typeof deriveReport>[0][number];
  const score = (fixture: string, label: "clean" | "slop", overall: number | null, rep = 0, attempts = 1): S => ({
    fixture, domain: "generic_llm", label, rep, overall,
    min_axis: overall, axes: {}, model: overall == null ? "none" : "stub",
    status: overall == null ? "degraded" : "pass", reason: overall == null ? "All 6 model entries exhausted" : "",
    latency_ms: 1, attempts,
  });
  const meta = (n_fixtures_scored: number, reps = 1) => ({
    mode: "rescored" as const, source_artifact: "test", reps, max_attempts: 3,
    n_fixtures_scored, coverage_floor: 0.9,
  });

  it("withholds best_cut and flags the sweep when most fixtures never returned a score", () => {
    // 4 usable out of 40 — the shape of the real quota-blocked run.
    const scores = [
      score("a", "slop", 0.2), score("b", "slop", 0.2), score("c", "slop", 0.0), score("d", "clean", 0.7),
      ...Array.from({ length: 36 }, (_, i) => score(`deg${i}`, "slop", null, 0, 3)),
    ];
    const r = deriveReport(scores, meta(40));
    expect(r.n_scored_rep0).toBe(4);
    expect(r.sweep_coverage).toBeLessThan(0.9);
    expect(r.sweep_underpowered).toBe(true);
    // A zero-false-reject cut DOES exist in the residue; it must still be withheld.
    expect(r.best_cut).toBeNull();
    expect(r.best_cut_suppressed_reason).toContain("coverage floor");
    expect(r.findings.some((f) => f.includes("SWEEP UNDERPOWERED"))).toBe(true);
    // first-attempt failures are reconstructed from the attempts counter, not carried over
    expect(r.n_first_attempt_failures).toBe(36);
    expect(r.n_degraded).toBe(36);
  });

  it("reports a best_cut only when coverage clears the floor", () => {
    const scores = [
      ...Array.from({ length: 8 }, (_, i) => score(`s${i}`, "slop", 0.2)),
      ...Array.from({ length: 2 }, (_, i) => score(`c${i}`, "clean", 0.9)),
    ];
    const r = deriveReport(scores, meta(10));
    expect(r.sweep_coverage).toBe(1);
    expect(r.sweep_underpowered).toBe(false);
    expect(r.best_cut_suppressed_reason).toBeNull();
    expect(r.best_cut).not.toBeNull();
    expect(r.best_cut!.recall).toBe(1);
    expect(r.best_cut!.false_reject_rate).toBe(0);
  });

  it("calls variance UNMEASURED when no fixture returned two usable scores, never agreement", () => {
    // rep 1 was scheduled but degraded — the failure mode that previously printed
    // "all 0 fixtures returned an identical score".
    const scores = [
      score("a", "slop", 0.2, 0), score("b", "clean", 0.9, 0),
      score("a", "slop", null, 1, 3), score("b", "clean", null, 1, 3),
    ];
    const r = deriveReport(scores, meta(2, 2));
    expect(r.variance.unmeasured).toBe(true);
    expect(r.variance.n_fixtures_with_repeats).toBe(0);
    const v = r.findings.find((f) => f.startsWith("temperature-0 reproducibility"))!;
    expect(v).toContain("UNMEASURED");
    expect(v).toContain("availability failure");
    expect(v.toLowerCase()).not.toContain("identical score");
  });

  it("measures spread over fixtures with >= 2 usable scores and records verdict flips", () => {
    const scores = [
      score("a", "clean", 0.9, 0), score("a", "clean", 0.7, 1),
      score("b", "slop", 0.2, 0), score("b", "slop", 0.2, 1),
    ];
    const r = deriveReport(scores, meta(2, 2));
    expect(r.variance.unmeasured).toBe(false);
    expect(r.variance.n_fixtures_with_repeats).toBe(2);
    expect(r.variance.max_spread).toBeCloseTo(0.2, 6);
    // 0.9 passes the shipped 0.8 floor and 0.7 does not, so the verdict flipped on model noise alone
    expect(r.variance.flipped).toEqual(["a"]);
  });

  it("availability finding quotes upstream accounts, not key count", () => {
    // Four OpenRouter keys resolve to one account and one shared per-day budget, so describing the
    // chain by key count overstates independence.
    const r = deriveReport([score("a", "slop", null, 0, 3)], meta(1));
    const avail = r.findings[0]!;
    expect(avail).toContain("upstream accounts");
    expect(avail).not.toContain("4-key");
  });
});

/**
 * The verdict-level confusion matrix scores WHETHER a judge rejected, never WHY. These tests pin
 * down the reason audit that closes that gap, including the substring bug it was first written with.
 */
describe("judge reason audit — a correct verdict on a false reason", () => {
  const fixture = (id: string, label: "clean" | "slop", jurisdiction: string, text: string) =>
    ({ id, domain: "legal_draft", label, raw: { result: { full_text: text }, intake: { jurisdiction } } }) as any;

  it("two-letter state codes are matched as whole tokens, not substrings", () => {
    // The first version of this check lowercased both sides and used includes(), so "DE" matched
    // inside "under", "defer" and "provided" and every document looked like it named Delaware.
    expect(jurisdictionPresent("This Agreement is governed by DE law.", "DE")).toBe(true);
    expect(jurisdictionPresent("under the provisions defined herein", "DE")).toBe(false);
    expect(jurisdictionPresent("the State of Delaware", "Delaware")).toBe(true);
    expect(jurisdictionPresent("the state of delaware", "Delaware")).toBe(true); // names are case-insensitive
    expect(jurisdictionPresent("Delawarean law", "Delaware")).toBe(false); // still a whole token
  });

  it("flags a rejection whose stated jurisdiction ground is contradicted by the artifact", () => {
    const fixtures = [
      fixture("a", "slop", "DE", "Governed by the laws of the State of Delaware."),
      fixture("b", "clean", "DE", "Governed by the laws of the State of Delaware."),
    ];
    const items = [
      { id: "a", label: "slop", judge: "FAIL", reason: "Wrong jurisdiction", model: "m" },
      { id: "b", label: "clean", judge: "FAIL", reason: "Jurisdiction mismatch", model: "m" },
    ];
    const ra = auditReasons(items, fixtures);
    expect(ra.n_reasons_citing_jurisdiction).toBe(2);
    expect(ra.n_jurisdiction_reasons_contradicted_by_artifact).toBe(2);
    // The slop verdict is still counted a true positive by the confusion matrix, on a false ground.
    expect(ra.n_true_positives).toBe(1);
    expect(ra.n_true_positives_on_contradicted_reason).toBe(1);
    expect(ra.share_of_true_positives_on_contradicted_reason).toBeCloseTo(1, 6);
    expect(ra.n_false_positives_on_contradicted_reason).toBe(1);
    expect(ra.contradicted.map((c) => c.matched_alternate)).toEqual(["Delaware", "Delaware"]);
  });

  it("does not flag a jurisdiction reason when the artifact really does omit it", () => {
    // legal_slop_truncated_* is sliced to 120 chars, so the governing-law clause is genuinely gone
    // and the judge's complaint is sound. The audit must not manufacture a hallucination here.
    const fixtures = [fixture("t", "slop", "DE", "THIS AGREEMENT is entered into as of 2025-01-15 by and between the parties identified below.")];
    const ra = auditReasons([{ id: "t", label: "slop", judge: "FAIL", reason: "Missing jurisdiction", model: "m" }], fixtures);
    expect(ra.n_reasons_citing_jurisdiction).toBe(1);
    expect(ra.n_jurisdiction_reasons_contradicted_by_artifact).toBe(0);
    expect(ra.n_true_positives_on_contradicted_reason).toBe(0);
  });

  it("ignores reasons on domains that carry no intake, and never reads absence as soundness", () => {
    const noIntake = [{ id: "s", domain: "sql_gen", label: "slop", raw: { sql: "DROP TABLE t" } } as any];
    const ra = auditReasons([{ id: "s", label: "slop", judge: "FAIL", reason: "Destructive statement", model: "m" }], noIntake);
    expect(ra.n_items_with_checkable_reason).toBe(0);
    expect(ra.n_jurisdiction_reasons_contradicted_by_artifact).toBe(0);
    expect(ra.note).toContain("not that the reasons");
  });
});
