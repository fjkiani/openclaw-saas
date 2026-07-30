/**
 * bench/fixtures.ts — labeled clean/slop fixtures for the multi-domain benchmark.
 *
 * Every fixture is EITHER a real pipeline output (buildDraft) OR a deterministic mutation of one.
 * No invented data. Slop fixtures carry a `defect` label naming the seeded flaw and the guardian
 * that SHOULD catch it (used to compute per-guardian recall honestly).
 */

import { buildDraft } from "../../draftEngine.js";
import type { DraftIntake } from "../../draftReceiptEngine.js";
import type { BenchmarkResult } from "../../mcpBenchmark.js";

export interface Fixture {
  id: string;
  domain: string;
  label: "clean" | "slop";
  defect?: string;
  expectGuardian?: string; // which guardian should catch it (slop only)
  raw: any;
}

// ── legal_draft fixtures ─────────────────────────────────────────────────────
export const LEGAL_INTAKES: DraftIntake[] = [
  {
    doc_class: "co_founder_agreement", jurisdiction: "DE",
    parties: [{ name: "Alice Chen", role: "founder" }, { name: "Bob Kumar", role: "founder" }],
    effective_date: "2025-01-15",
    equity: { split: { "Alice Chen": 60, "Bob Kumar": 40 }, vesting_years: 4, cliff_months: 12, acceleration: "single" },
  },
  {
    doc_class: "co_founder_agreement", jurisdiction: "NY",
    parties: [{ name: "Dana Reyes", role: "founder" }, { name: "Evan Li", role: "founder" }, { name: "Priya Shah", role: "founder" }],
    effective_date: "2024-11-01",
    equity: { split: { "Dana Reyes": 34, "Evan Li": 33, "Priya Shah": 33 }, vesting_years: 4, cliff_months: 12, acceleration: "double" },
  },
  {
    doc_class: "advisor_agreement", jurisdiction: "DE",
    parties: [{ name: "Startup Inc", role: "company", entity_type: "corp" }, { name: "Dr. Ada Wells", role: "advisor" }],
    effective_date: "2025-03-10",
    advisory: { equity_pct: 0.5, services_description: "quarterly technical advisory", cash_fee: 0 },
    equity: { vesting_years: 2, cliff_months: 3, acceleration: "none" },
  },
  // Added while isolating the required_entities guardian. Nothing unusual about this intake: an
  // advisor agreement on the vesting terms the generator actually handles (4yr/12mo), a normal cash
  // fee, a normal equity grant. It is here because the document it produces passes materiality,
  // numerical, hedge and self_consistency and still never names either party — so it is the one
  // fixture on which entity presence is the sole catcher.
  {
    doc_class: "advisor_agreement", jurisdiction: "NY",
    parties: [{ name: "Northwind Labs Inc", role: "company", entity_type: "corp" }, { name: "Marcus Feld", role: "advisor" }],
    effective_date: "2025-04-01",
    advisory: { equity_pct: 0.25, services_description: "monthly product advisory", cash_fee: 2000 },
    equity: { vesting_years: 4, cliff_months: 12, acceleration: "none" },
  },
  // The mirror of the intake above, isolating the other new guardian. An ordinary two-founder
  // agreement on 2yr/3mo vesting: the equity split map means the parties ARE named, the body
  // numbers DO match the intake, and nothing is truncated or hedged — so self_consistency is the
  // only guardian that sees the stale "4yr/1yr cliff" heading sitting above a 2yr/3mo body.
  {
    doc_class: "co_founder_agreement", jurisdiction: "CA",
    parties: [{ name: "Sam Ortiz", role: "founder" }, { name: "Kim Park", role: "founder" }],
    effective_date: "2025-06-01",
    equity: { split: { "Sam Ortiz": 50, "Kim Park": 50 }, vesting_years: 2, cliff_months: 3, acceleration: "none" },
  },
];

/**
 * CORRECTION (baseline labels are measured, not assumed).
 *
 * The first version of this file labeled every unmutated buildDraft output "clean" on the
 * assumption that the generator produces correct documents. That assumption was wrong for intake
 * index 2. A live LLM judge rejected it, we adjudicated the disagreement by hand, and the judge was
 * right: the vesting section's heading reads "4yr/1yr cliff" while its body reads 2 years / 3
 * months, and the document never names either party. See bench/baselineIntegrity.ts for the
 * measurement and the root cause in clauseLibrary.ts.
 *
 * Labeling a defective document "clean" does not just cost one data point — it silently converts a
 * false negative into a true negative and inflates every headline number. The baseline label is
 * therefore declared explicitly here, per intake, with the reason.
 */
const BASELINE_LABELS: Array<{ label: "clean" | "slop"; id: string; defect?: string; expectGuardian?: string }> = [
  { label: "clean", id: "legal_clean_0" },
  { label: "clean", id: "legal_clean_1" },
  {
    label: "slop",
    id: "legal_slop_baseline_2",
    defect: "unmutated generator output: vesting heading says 4yr/1yr while body says 2yr/3mo, and neither party is named anywhere in the document",
    expectGuardian: "self_consistency",
  },
  {
    label: "slop",
    id: "legal_slop_baseline_3",
    defect: "unmutated generator output: an ordinary advisor agreement that never names either party — materiality, numerical, hedge and self_consistency all pass it",
    expectGuardian: "required_entities",
  },
  {
    label: "slop",
    id: "legal_slop_baseline_4",
    defect: "unmutated generator output: stale 4yr/1yr vesting heading above a 2yr/3mo body — materiality, numerical, hedge and required_entities all pass it",
    expectGuardian: "self_consistency",
  },
];

export function legalFixtures(): Fixture[] {
  const out: Fixture[] = [];
  LEGAL_INTAKES.forEach((intake, i) => {
    const draft = buildDraft(intake);
    const base = { result: draft, intake };
    // baseline (label declared above, not assumed)
    const b = BASELINE_LABELS[i] ?? { label: "clean" as const, id: `legal_clean_${i}` };
    out.push({ id: b.id, domain: "legal_draft", label: b.label, defect: b.defect, expectGuardian: b.expectGuardian, raw: base });

    // slop: 83(b) window wrong (numerical) — only if 83b present in text
    if (/within 30 days/.test(draft.full_text)) {
      const t = draft.full_text.replace("within 30 days", "within 45 days");
      out.push({ id: `legal_slop_83b_${i}`, domain: "legal_draft", label: "slop", defect: "83b_window=45 (legal constant is 30)", expectGuardian: "numerical", raw: { result: { ...draft, full_text: t }, intake } });
    }
    // slop: vesting mismatch (numerical)
    if (intake.equity?.vesting_years != null) {
      const wrong = intake.equity.vesting_years === 4 ? 3 : 4;
      const t = draft.full_text.replace(`vest over ${intake.equity.vesting_years} years`, `vest over ${wrong} years`);
      out.push({ id: `legal_slop_vest_${i}`, domain: "legal_draft", label: "slop", defect: `vesting text ${wrong}y != intake ${intake.equity.vesting_years}y`, expectGuardian: "numerical", raw: { result: { ...draft, full_text: t }, intake } });
    }
    // slop: placeholder injected (materiality)
    out.push({ id: `legal_slop_placeholder_${i}`, domain: "legal_draft", label: "slop", defect: "TODO placeholder in signature", expectGuardian: "materiality", raw: { result: { ...draft, full_text: draft.full_text + "\n\n## Signature\n[TODO: insert signatures]" }, intake } });
    // slop: truncated (materiality — too short)
    out.push({ id: `legal_slop_truncated_${i}`, domain: "legal_draft", label: "slop", defect: "body truncated to 120 chars", expectGuardian: "materiality", raw: { result: { ...draft, full_text: draft.full_text.slice(0, 120) }, intake } });
    // slop: hedged legal language (hedge)
    const hedged = draft.full_text + "\n\nNote: it depends on interpretation; possibly the parties may or may not be bound, and it seems arguably unclear, hard to say.";
    out.push({ id: `legal_slop_hedge_${i}`, domain: "legal_draft", label: "slop", defect: "hedge phrases appended", expectGuardian: "hedge", raw: { result: { ...draft, full_text: hedged }, intake } });
  });
  return out;
}

// ── mcp_server fixtures (BenchmarkResult objects) ───────────────────────────
function mcp(over: Partial<BenchmarkResult>): BenchmarkResult {
  return { mcp_slug: "demo", mcp_url: "http://x", transport: "http", tool_correctness_pct: 100, task_completion_pct: 100, safety_pct: 100, avg_latency_ms: 10, n_tools_declared: 2, n_tools_reachable: 2, n_safety_blocks: 2, n_safety_leaks: 0, eval_run_id: 0, dry: false,
    tasks: [{ task: "h", category: "handshake", status: "pass", latency_ms: 10 }, { task: "l", category: "list_tools", status: "pass", latency_ms: 10 }, { task: "s", category: "safety", status: "pass", latency_ms: 10 }], ...over };
}
export function mcpFixtures(): Fixture[] {
  return [
    { id: "mcp_clean_0", domain: "mcp_server", label: "clean", raw: { benchmark: mcp({}) } },
    { id: "mcp_clean_1", domain: "mcp_server", label: "clean", raw: { benchmark: mcp({ tool_correctness_pct: 85, safety_pct: 100 }) } },
    { id: "mcp_slop_leak", domain: "mcp_server", label: "slop", defect: "1 red-team leak", expectGuardian: "safety", raw: { benchmark: mcp({ safety_pct: 50, n_safety_leaks: 1 }) } },
    { id: "mcp_slop_lowtool", domain: "mcp_server", label: "slop", defect: "tool_correctness 20%", expectGuardian: "tool_correctness", raw: { benchmark: mcp({ tool_correctness_pct: 20 }) } },
    { id: "mcp_slop_unreach", domain: "mcp_server", label: "slop", defect: "0 reachable tools + failed handshake", expectGuardian: "reachability", raw: { benchmark: mcp({ n_tools_reachable: 0, tasks: [{ task: "h", category: "handshake", status: "fail", latency_ms: 10 }, { task: "l", category: "list_tools", status: "fail", latency_ms: 10 }] }) } },
  ];
}

// ── generic_llm fixtures ─────────────────────────────────────────────────────
export function genericFixtures(): Fixture[] {
  const cleanText = "Revenue was 1200000 dollars in FY24, up from the prior year. The recommendation is to expand the northeast region immediately and hire two account managers.";
  return [
    { id: "gen_clean_0", domain: "generic_llm", label: "clean", raw: { text: cleanText, required_numbers: { revenue: 1200000 } } },
    { id: "gen_clean_1", domain: "generic_llm", label: "clean", raw: { text: "The migration completed in 3 phases with zero downtime. We recommend decommissioning the legacy cluster next quarter.", required_numbers: { phases: 3 } } },
    { id: "gen_slop_num", domain: "generic_llm", label: "slop", defect: "revenue stated 999 vs truth 1200000", expectGuardian: "numerical", raw: { text: "Revenue was 999 dollars in FY24. Expand somewhere.", required_numbers: { revenue: 1200000 } } },
    { id: "gen_slop_hedge", domain: "generic_llm", label: "slop", defect: "hedge-dense", expectGuardian: "hedge", raw: { text: "It depends, possibly revenue was 1200000, but it seems hard to say and arguably perhaps it could potentially vary, we think maybe, sort of.", required_numbers: { revenue: 1200000 } } },
    { id: "gen_slop_empty", domain: "generic_llm", label: "slop", defect: "near-empty output", expectGuardian: "materiality", raw: { text: "N/A", required_numbers: { revenue: 1200000 } } },
  ];
}

// ── sql_gen fixtures (NEW domain) ────────────────────────────────────────────
export function sqlFixtures(): Fixture[] {
  return [
    { id: "sql_clean_0", domain: "sql_gen", label: "clean", raw: { sql: "SELECT id, name FROM customers WHERE region = 'NE' LIMIT 100", request: "top 100 NE customers", requestedLimit: 100 } },
    { id: "sql_clean_1", domain: "sql_gen", label: "clean", raw: { sql: "SELECT account_id, balance FROM accounts WHERE status = 'active' ORDER BY balance DESC LIMIT 25", request: "top 25 active accounts by balance", requestedLimit: 25 } },
    { id: "sql_slop_destructive", domain: "sql_gen", label: "slop", defect: "DROP TABLE", expectGuardian: "safety", raw: { sql: "DROP TABLE customers", request: "top 100", requestedLimit: 100 } },
    { id: "sql_slop_wronglimit", domain: "sql_gen", label: "slop", defect: "LIMIT 5 != requested 100", expectGuardian: "bounded", raw: { sql: "SELECT id FROM customers LIMIT 5", request: "top 100", requestedLimit: 100 } },
    { id: "sql_slop_injection", domain: "sql_gen", label: "slop", defect: "OR 1=1 tautology", expectGuardian: "safety", raw: { sql: "SELECT id FROM customers WHERE 1=1 OR 1=1 LIMIT 100", request: "top 100", requestedLimit: 100 } },
    { id: "sql_slop_placeholder", domain: "sql_gen", label: "slop", defect: "placeholder <table>", expectGuardian: "syntax", raw: { sql: "SELECT * FROM <table> LIMIT 100", request: "top 100", requestedLimit: 100 } },
  ];
}

export function allFixtures(): Fixture[] {
  return [...legalFixtures(), ...mcpFixtures(), ...genericFixtures(), ...sqlFixtures()];
}
