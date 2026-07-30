/**
 * bench/reconIntakes.ts — the real intakes used for the OLD-vs-NEW reconciliation (GAP-1).
 *
 * These are genuine DraftIntake objects (co-founder / advisor / IP-assignment across DE/NY/CA).
 * Shared by the benchmark runner and the test suite so both exercise the identical set. Every
 * intake is fed through the real buildDraft pipeline; nothing here is invented output.
 */

import type { DraftIntake } from "../../draftReceiptEngine.js";

export const RECON_INTAKES: DraftIntake[] = [
  { doc_class: "co_founder_agreement", jurisdiction: "DE", parties: [{ name: "Alice Chen", role: "founder" }, { name: "Bob Kumar", role: "founder" }], effective_date: "2025-01-15", equity: { split: { "Alice Chen": 60, "Bob Kumar": 40 }, vesting_years: 4, cliff_months: 12, acceleration: "single" } },
  { doc_class: "co_founder_agreement", jurisdiction: "NY", parties: [{ name: "Dana Reyes", role: "founder" }, { name: "Evan Li", role: "founder" }, { name: "Priya Shah", role: "founder" }], effective_date: "2024-11-01", equity: { split: { "Dana Reyes": 34, "Evan Li": 33, "Priya Shah": 33 }, vesting_years: 4, cliff_months: 12, acceleration: "double" } },
  { doc_class: "co_founder_agreement", jurisdiction: "CA", parties: [{ name: "Sam Ortiz", role: "founder" }, { name: "Kim Park", role: "founder" }], effective_date: "2025-06-01", equity: { split: { "Sam Ortiz": 50, "Kim Park": 50 }, vesting_years: 4, cliff_months: 12, acceleration: "none" } },
  { doc_class: "advisor_agreement", jurisdiction: "DE", parties: [{ name: "Startup Inc", role: "company", entity_type: "corp" }, { name: "Dr. Ada Wells", role: "advisor" }], effective_date: "2025-03-10", advisory: { equity_pct: 0.5, services_description: "advisory", cash_fee: 0 }, equity: { vesting_years: 2, cliff_months: 3, acceleration: "none" } },
  { doc_class: "contractor_ip_assignment", jurisdiction: "DE", parties: [{ name: "Startup Inc", role: "company", entity_type: "corp" }, { name: "Jordan Fox", role: "contractor" }], effective_date: "2025-02-20", ip: { scope: "broad" } },
];
