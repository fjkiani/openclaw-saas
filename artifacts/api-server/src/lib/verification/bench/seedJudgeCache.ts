/**
 * bench/seedJudgeCache.ts — one-off migration that carries measured judge verdicts from an earlier
 * run into the prompt-hash cache used by judgeBaseline.ts.
 *
 * Why this exists. The judge baseline was first measured on a 33-fixture corpus. The corpus then
 * grew to 44 fixtures and one fixture was relabeled (legal_clean_2 -> legal_slop_baseline_2) after
 * hand adjudication showed the document really was defective. Re-asking the judge about the 33
 * artifacts it has already answered on would spend a second full token budget on free-tier models
 * whose limits are per-day, and would return the same answers: the judge runs at temperature 0 and
 * the prompt builder is unchanged.
 *
 * What is and is not reused:
 *   - REUSED: the verdict, reason and model for an artifact whose bytes are unchanged.
 *   - NOT reused: the label, the confusion matrix, recall, or false-reject rate. Those are all
 *     recomputed from the corrected labels, which is the entire point of the re-score.
 *
 * The cache key is a hash of the exact system+user prompt, so if an artifact's bytes changed the
 * key changes and the entry simply will not be found — the seeding cannot silently attach an old
 * answer to a new question. Ids that cannot be mapped are reported, not skipped quietly.
 *
 * Run:  tsx bench/seedJudgeCache.ts        (reads judge_baseline.json, writes judge_cache.json)
 */

import { allFixtures } from "./fixtures.js";
import { buildJudgePrompt, judgeCacheKey, type JudgeMode } from "./judgeBaseline.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out";

/**
 * Fixtures renamed since the stored run. The artifact bytes are identical; only the ground-truth
 * label changed, and the label is never shown to the judge.
 */
const RENAMED: Record<string, string> = { legal_clean_2: "legal_slop_baseline_2" };

interface StoredItem { id: string; judge: string; reason: string; model: string }
interface StoredBaseline { items?: StoredItem[] }
interface StoredReport { baselines?: Record<string, StoredBaseline> }

function main(): void {
  const report = JSON.parse(readFileSync(`${OUT}/judge_baseline.json`, "utf8")) as StoredReport;
  const fixtures = new Map(allFixtures().map((f) => [f.id, f]));

  let cache: Record<string, { verdict: string; reason: string; model: string; cached_at: string }> = {};
  try { cache = JSON.parse(readFileSync(`${OUT}/judge_cache.json`, "utf8")); } catch { cache = {}; }

  let seeded = 0;
  const unmapped: string[] = [];

  for (const mode of ["naive", "grounded"] as JudgeMode[]) {
    const items = report.baselines?.[mode]?.items ?? [];
    for (const it of items) {
      const currentId = RENAMED[it.id] ?? it.id;
      const f = fixtures.get(currentId);
      if (!f) { unmapped.push(`${mode}/${it.id}`); continue; }
      const { sys, user } = buildJudgePrompt(f, mode);
      const key = judgeCacheKey(mode, sys, user);
      if (cache[key]) continue;
      cache[key] = {
        verdict: it.judge === "PASS" ? "PASS" : "FAIL",
        reason: it.reason,
        model: it.model,
        cached_at: "seeded-from-prior-run",
      };
      seeded++;
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/judge_cache.json`, JSON.stringify(cache, null, 2));
  console.log(`seeded ${seeded} cache entries; cache now holds ${Object.keys(cache).length}`);
  console.log(`fixtures in current corpus: ${fixtures.size}`);
  if (unmapped.length) console.log(`could not map ${unmapped.length} stored ids: ${unmapped.join(", ")}`);
  else console.log("every stored id mapped to a current fixture");
}

if ((process.argv[1] ?? "").includes("seedJudgeCache")) main();
