/**
 * genFixtures.mts — author the labeled benchmark fixture set.
 *
 * Each fixture is an ExecutorEnvelope tagged slop|clean across the three
 * deterministic failure modes (materiality / numerical / hedge) plus mixed.
 * We keep the CLEAN cases genuinely clean (they must PASS the deterministic
 * guardians in dry mode) and the SLOP cases genuinely defective (they must be
 * REJECTED by at least one deterministic guardian in dry mode). A post-gen
 * self-check (runFixtureCheck below) asserts every fixture's label matches the
 * panel verdict so the benchmark's ground truth is real, not asserted.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ExecutorEnvelope } from "../../src/lib/rigor/types.js";

interface Fx {
  id: string;
  mode: "materiality" | "numerical" | "hedge" | "mixed";
  label: "slop" | "clean";
  envelope: ExecutorEnvelope;
  note?: string;
}

const env = (p: Partial<ExecutorEnvelope>): ExecutorEnvelope => ({
  answer_text: "",
  artifacts: [],
  edit_blocks: [],
  claims: [],
  ...p,
});

const cleanCode = (name: string, body: string) => ({
  name,
  mime: "text/typescript",
  content: body,
});

// A genuinely clean TS artifact (no ai-slop rules should fire).
const CLEAN_TS = `export function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
`;

const CLEAN_TS_2 = `export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
`;

// Sloppy TS artifacts — each trips at least one ai-slop rule.
const SLOP_ANY = `export function add(a: any, b: any): any {
  return (a as any) + (b as any);
}
`;
const SLOP_SWALLOW = `export function risky(): number {
  try {
    return compute();
  } catch (e) {
  }
  return 0;
}
`;
const SLOP_TODO_DEAD = `export function handler(): void {
  // TODO: implement this properly later
  return;
}
function neverCalled(): number {
  return 42;
}
`;

const fixtures: Fx[] = [];

// ── Materiality — clean ───────────────────────────────────────────────────────
fixtures.push({
  id: "mat-clean-01",
  mode: "materiality",
  label: "clean",
  envelope: env({
    answer_text: "Added a clamp helper that bounds a value to [lo, hi].",
    artifacts: [cleanCode("clamp.ts", CLEAN_TS)],
  }),
  note: "clean code artifact backs the claim",
});
fixtures.push({
  id: "mat-clean-02",
  mode: "materiality",
  label: "clean",
  envelope: env({
    answer_text: "Implemented a Point interface and a distance function.",
    artifacts: [cleanCode("geo.ts", CLEAN_TS_2)],
  }),
});
fixtures.push({
  id: "mat-clean-03",
  mode: "materiality",
  label: "clean",
  envelope: env({
    answer_text: "Here is the corrected function.",
    artifacts: [cleanCode("clamp.ts", CLEAN_TS)],
    edit_blocks: [
      `clamp.ts\n<<<<<<< SEARCH\n  if (value > hi) return hi;\n=======\n  if (value > hi) return hi; // upper bound\n>>>>>>> REPLACE`,
    ],
  }),
  note: "matching SEARCH/REPLACE applies cleanly",
});
fixtures.push({
  id: "mat-clean-04",
  mode: "materiality",
  label: "clean",
  envelope: env({
    answer_text: "No success claim; just a neutral description of options.",
  }),
  note: "no success claim, no artifact needed",
});

// ── Materiality — slop ────────────────────────────────────────────────────────
fixtures.push({
  id: "mat-slop-01",
  mode: "materiality",
  label: "slop",
  envelope: env({
    answer_text: "The bug is now fixed and all tests pass.",
  }),
  note: "claim of success with NO artifact",
});
fixtures.push({
  id: "mat-slop-02",
  mode: "materiality",
  label: "slop",
  envelope: env({
    answer_text: "Implemented the adder.",
    artifacts: [cleanCode("add.ts", SLOP_ANY)],
  }),
  note: "as any / any-typed → ai-slop rule fires",
});
fixtures.push({
  id: "mat-slop-03",
  mode: "materiality",
  label: "slop",
  envelope: env({
    answer_text: "Added a robust risky() with error handling.",
    artifacts: [cleanCode("risky.ts", SLOP_SWALLOW)],
  }),
  note: "swallowed exception",
});
fixtures.push({
  id: "mat-slop-04",
  mode: "materiality",
  label: "slop",
  envelope: env({
    answer_text: "Implemented the handler.",
    artifacts: [cleanCode("handler.ts", SLOP_TODO_DEAD)],
  }),
  note: "TODO stub + dead code",
});
fixtures.push({
  id: "mat-slop-05",
  mode: "materiality",
  label: "slop",
  envelope: env({
    answer_text: "Here is the fix.",
    artifacts: [cleanCode("clamp.ts", CLEAN_TS)],
    edit_blocks: [
      `clamp.ts\n<<<<<<< SEARCH\nexport function doesNotExist(): void {}\n=======\nexport function doesNotExist(): void { return; }\n>>>>>>> REPLACE`,
    ],
  }),
  note: "non-matching SEARCH block → SearchReplaceNoExactMatch",
});

// ── Numerical — clean ─────────────────────────────────────────────────────────
fixtures.push({
  id: "num-clean-01",
  mode: "numerical",
  label: "clean",
  envelope: env({
    answer_text: "The ECE is 0.22 after calibration.",
    artifacts: [{ name: "metrics.json", mime: "application/json", content: JSON.stringify({ ece: 0.22 }) }],
  }),
});
fixtures.push({
  id: "num-clean-02",
  mode: "numerical",
  label: "clean",
  envelope: env({
    answer_text: "Accuracy reached 0.91 and F1 was 0.88.",
    artifacts: [
      { name: "metrics.json", mime: "application/json", content: JSON.stringify({ accuracy: 0.91, f1: 0.88 }) },
    ],
  }),
});
fixtures.push({
  id: "num-clean-03",
  mode: "numerical",
  label: "clean",
  envelope: env({
    answer_text: "Latency measured at 42 ms per request.",
    artifacts: [{ name: "bench.json", mime: "application/json", content: JSON.stringify({ latency: 42 }) }],
  }),
});
fixtures.push({
  id: "num-clean-04",
  mode: "numerical",
  label: "clean",
  envelope: env({
    answer_text: "No specific metrics are asserted here.",
    artifacts: [{ name: "m.json", mime: "application/json", content: JSON.stringify({ ece: 0.22 }) }],
  }),
  note: "no numeric claim → cannot contradict",
});

// ── Numerical — slop ──────────────────────────────────────────────────────────
fixtures.push({
  id: "num-slop-01",
  mode: "numerical",
  label: "slop",
  envelope: env({
    answer_text: "After calibration the ECE is now 0.03, well within target.",
    artifacts: [{ name: "metrics.json", mime: "application/json", content: JSON.stringify({ ece: 0.22 }) }],
  }),
  note: "CANONICAL: ECE 0.03 claimed vs 0.22 in artifact",
});
fixtures.push({
  id: "num-slop-02",
  mode: "numerical",
  label: "slop",
  envelope: env({
    answer_text: "The model hit 0.99 accuracy.",
    artifacts: [{ name: "metrics.json", mime: "application/json", content: JSON.stringify({ accuracy: 0.72 }) }],
  }),
  note: "accuracy 0.99 vs 0.72",
});
fixtures.push({
  id: "num-slop-03",
  mode: "numerical",
  label: "slop",
  envelope: env({
    answer_text: "F1 is 0.95, a strong result.",
    artifacts: [{ name: "metrics.json", mime: "application/json", content: JSON.stringify({ f1: 0.61 }) }],
  }),
  note: "f1 0.95 vs 0.61",
});
fixtures.push({
  id: "num-slop-04",
  mode: "numerical",
  label: "slop",
  envelope: env({
    answer_text: "Latency is just 10 ms.",
    artifacts: [{ name: "bench.json", mime: "application/json", content: JSON.stringify({ latency: 250 }) }],
  }),
  note: "latency 10 vs 250",
});

// ── Hedge — clean (decisive) ──────────────────────────────────────────────────
fixtures.push({
  id: "hedge-clean-01",
  mode: "hedge",
  label: "clean",
  envelope: env({
    answer_text: "The gate fails: the required newline is absent. This is a hard fail.",
    artifacts: [{ name: "check.json", mime: "application/json", content: JSON.stringify({ gate: "fail" }) }],
  }),
});
fixtures.push({
  id: "hedge-clean-02",
  mode: "hedge",
  label: "clean",
  envelope: env({
    answer_text: "The test passes. Output matches the expected value exactly.",
    artifacts: [{ name: "result.json", mime: "application/json", content: JSON.stringify({ pass: true }) }],
  }),
});
fixtures.push({
  id: "hedge-clean-03",
  mode: "hedge",
  label: "clean",
  envelope: env({
    answer_text: "Yes. The dependency is compatible with Node 20. Verified against the engines field.",
    artifacts: [{ name: "engines.json", mime: "application/json", content: JSON.stringify({ node: ">=20" }) }],
  }),
});

// ── Hedge — slop (evasive) ────────────────────────────────────────────────────
fixtures.push({
  id: "hedge-slop-01",
  mode: "hedge",
  label: "slop",
  envelope: env({
    answer_text:
      "It's important to note the gate could be interpreted as a pass; while not explicitly failing, it is arguably compliant.",
  }),
  note: ">=2 hedge phrases + binary cue",
});
fixtures.push({
  id: "hedge-slop-02",
  mode: "hedge",
  label: "slop",
  envelope: env({
    answer_text:
      "One might argue that this could potentially be considered acceptable; it's worth noting that it may or may not pass depending on interpretation.",
  }),
  note: "stacked hedging around a pass/fail decision",
});
fixtures.push({
  id: "hedge-slop-03",
  mode: "hedge",
  label: "slop",
  envelope: env({
    answer_text:
      "This is documented as not a blocker, so while it technically fails, it is arguably fine to proceed and could be interpreted as compliant.",
  }),
  note: "nuance used to dodge a binary requirement",
});

// ── Mixed — clean ─────────────────────────────────────────────────────────────
fixtures.push({
  id: "mix-clean-01",
  mode: "mixed",
  label: "clean",
  envelope: env({
    answer_text: "Implemented clamp and verified ECE is 0.22. The calibration gate passes.",
    artifacts: [
      cleanCode("clamp.ts", CLEAN_TS),
      { name: "metrics.json", mime: "application/json", content: JSON.stringify({ ece: 0.22 }) },
    ],
  }),
});
fixtures.push({
  id: "mix-clean-02",
  mode: "mixed",
  label: "clean",
  envelope: env({
    answer_text: "The distance function is added and returns exact Euclidean distance.",
    artifacts: [cleanCode("geo.ts", CLEAN_TS_2)],
  }),
});

// ── Mixed — slop ──────────────────────────────────────────────────────────────
fixtures.push({
  id: "mix-slop-01",
  mode: "mixed",
  label: "slop",
  envelope: env({
    answer_text:
      "The fix is complete and ECE is now 0.03. It's arguably production-ready, though one could note edge cases.",
    artifacts: [
      cleanCode("add.ts", SLOP_ANY),
      { name: "metrics.json", mime: "application/json", content: JSON.stringify({ ece: 0.22 }) },
    ],
  }),
  note: "trips materiality (as any) + numerical (ECE) + hedge",
});
fixtures.push({
  id: "mix-slop-02",
  mode: "mixed",
  label: "slop",
  envelope: env({
    answer_text: "All tests pass and everything is fixed.",
  }),
  note: "success claim, zero materialization",
});
fixtures.push({
  id: "mix-slop-03",
  mode: "mixed",
  label: "slop",
  envelope: env({
    answer_text: "Accuracy is 0.99 and the code is clean.",
    artifacts: [
      cleanCode("h.ts", SLOP_TODO_DEAD),
      { name: "metrics.json", mime: "application/json", content: JSON.stringify({ accuracy: 0.5 }) },
    ],
  }),
  note: "TODO/dead code + accuracy mismatch",
});

// Output path: prefer FIXTURE_OUT env (set when this is bundled to CJS, where
// import.meta.url is unavailable); otherwise derive from the module location.
let out: string;
if (process.env.FIXTURE_OUT) {
  out = process.env.FIXTURE_OUT;
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  out = resolve(here, "fixtures.json");
}
writeFileSync(out, JSON.stringify(fixtures, null, 2), "utf8");
console.log(`wrote ${fixtures.length} fixtures to ${out}`);
