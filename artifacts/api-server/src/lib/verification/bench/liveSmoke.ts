/**
 * bench/liveSmoke.ts — minimal connectivity probe for the rubric guardian's live path.
 *
 * Confirms (a) a model key resolves, (b) the judge chain returns parseable JSON, and (c) the
 * guardian reports live:true instead of degraded. Prints no key material.
 */

import { registerAllDomains } from "../registerAll.js";
import { verify } from "../verificationCore.js";
import { allFixtures } from "./fixtures.js";

async function main() {
  registerAllDomains();
  const fx = allFixtures();

  // one clean and one slop fixture from a rubric-bearing domain
  const clean = fx.find((f) => f.domain === "generic_llm" && f.label === "clean")!;
  const slop = fx.find((f) => f.domain === "generic_llm" && f.label === "slop")!;

  for (const f of [clean, slop]) {
    const t0 = Date.now();
    const v = await verify(f.domain, f.raw, { live: true });
    const r = v.per_guardian.find((g) => g.guardian === "rubric");
    console.log(`\n[${f.id}] label=${f.label} verdict=${v.verdict} verified=${v.verified} n_verified=${v.n_verified} (${Date.now() - t0}ms)`);
    if (!r) { console.log("  no rubric guardian in this panel"); continue; }
    console.log(`  rubric: status=${r.status} live=${r.live} score=${r.score ?? "-"}`);
    console.log(`  reason: ${r.reasons[0]}`);
    const ev = r.evidence as Record<string, unknown> | undefined;
    if (ev?.axisScores) console.log(`  axes:   ${JSON.stringify(ev.axisScores)}`);
    if (ev?.model_used) console.log(`  model:  ${ev.model_used}`);
  }
}

main().catch((e) => { console.error("SMOKE ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
