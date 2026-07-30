/**
 * bench/adjudicate.ts — check the live judge's rejections of CLEAN fixtures against the actual text.
 *
 * The judge false-rejected 3 of 9 clean fixtures in both modes. Before claiming that as judge
 * imprecision, verify whether the judge was actually right and the "clean" labels are wrong. If the
 * labels are wrong, the panel's 0% false-reject rate is label bias, not accuracy.
 */

import { allFixtures } from "./fixtures.js";

const CLAIMS: Record<string, Array<{ claim: string; probe: RegExp }>> = {
  legal_clean_0: [
    { claim: "jurisdiction Delaware stated (intake DE)", probe: /delaware|\bDE\b/i },
    { claim: "both founders named", probe: /Alice Chen[\s\S]*Bob Kumar/i },
    { claim: "60/40 split stated", probe: /\b60\b[\s\S]{0,400}\b40\b/ },
  ],
  legal_clean_1: [
    { claim: "party roles present (founder)", probe: /founder/i },
    { claim: "all three founders named", probe: /Dana Reyes[\s\S]*Evan Li[\s\S]*Priya Shah/i },
    { claim: "jurisdiction New York stated (intake NY)", probe: /new york|\bNY\b/i },
  ],
  legal_clean_2: [
    { claim: "83(b) election clause present", probe: /83\(b\)/i },
    { claim: "advisor named", probe: /Dr\. Ada Wells/i },
    { claim: "vesting 2 years stated (intake 2)", probe: /vest over\s+2\s+years?/i },
    { claim: "cliff 3 months stated (intake 3)", probe: /cliff of\s+3\s+months?/i },
  ],
};

function main() {
  const fx = allFixtures();

  for (const [id, claims] of Object.entries(CLAIMS)) {
    const f = fx.find((x) => x.id === id);
    if (!f) { console.log(`${id}: NOT FOUND`); continue; }
    const text: string = f.raw.result?.full_text ?? "";
    const intake = f.raw.intake;
    console.log(`\n===== ${id} (${intake?.doc_class}, jurisdiction ${intake?.jurisdiction}, ${text.length} chars) =====`);
    for (const c of claims) {
      const hit = c.probe.test(text);
      console.log(`  [${hit ? "PRESENT" : "ABSENT "}] ${c.claim}`);
    }
    console.log(`  section headings: ${(text.match(/^## .*/gm) ?? []).map((s) => s.replace(/^## /, "")).join(" | ")}`);
  }

  // mcp_clean_1: the naive judge called 85% tool correctness "low". Threshold is 70.
  const mcp = fx.find((x) => x.id === "mcp_clean_1");
  console.log(`\n===== mcp_clean_1 =====`);
  console.log(`  tool_correctness_pct = ${mcp?.raw.benchmark?.tool_correctness_pct} (acceptance floor 70)`);
  console.log(`  safety_pct = ${mcp?.raw.benchmark?.safety_pct}, n_safety_leaks = ${mcp?.raw.benchmark?.n_safety_leaks}`);

  // gen_clean_0: the naive judge said "lacks specific data".
  const gen = fx.find((x) => x.id === "gen_clean_0");
  console.log(`\n===== gen_clean_0 =====`);
  console.log(`  required_numbers = ${JSON.stringify(gen?.raw.required_numbers)}`);
  console.log(`  text = ${JSON.stringify(gen?.raw.text)}`);
}

main();
