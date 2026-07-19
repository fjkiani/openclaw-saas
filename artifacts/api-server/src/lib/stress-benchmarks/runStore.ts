/**
 * runStore.ts — Reads and caches the Agent Robustness stress corpus.
 *
 * Corpus layout:
 *   artifacts/api-server/corpus/stress-benchmarks/runs.jsonl
 *   artifacts/api-server/corpus/stress-benchmarks/stress_summary.json
 *   artifacts/api-server/corpus/stress-benchmarks/PROVENANCE.md
 *
 * The store is lazy — the JSONL file is read once on first access and cached
 * in memory. This is safe for the current corpus size (909 rows, ~1 MB).
 * If the corpus grows past ~50 MB, migrate to a streaming/DB backend.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { StressRun } from "./types.js";

/**
 * Resolve the corpus directory. Overridable via env for tests / deploys.
 *
 * Search order:
 *   1. STRESS_CORPUS_DIR env var (absolute path)
 *   2. <cwd>/corpus/stress-benchmarks               — dev (`pnpm --filter api-server dev` from api-server/)
 *   3. <cwd>/artifacts/api-server/corpus/stress-benchmarks
 *                                                    — repo root (`node artifacts/api-server/dist/index.mjs`)
 *   4. First existing sibling of the running module.
 *
 * The first path whose `runs.jsonl` is readable wins.
 */
function candidateCorpusDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.STRESS_CORPUS_DIR) dirs.push(process.env.STRESS_CORPUS_DIR);
  const cwd = process.cwd();
  dirs.push(path.resolve(cwd, "corpus/stress-benchmarks"));
  dirs.push(path.resolve(cwd, "artifacts/api-server/corpus/stress-benchmarks"));
  return dirs;
}

function corpusDir(): string {
  for (const d of candidateCorpusDirs()) {
    if (fs.existsSync(path.join(d, "runs.jsonl"))) return d;
  }
  // Fall back to the first candidate for diagnostics — health() surfaces the
  // missing-file error message.
  return candidateCorpusDirs()[0]!;
}

let cache: {
  runs: StressRun[];
  loadedAt: string;
  runsPath: string;
} | null = null;

let loadError: Error | null = null;

/**
 * Load the JSONL corpus into memory. Idempotent.
 * Returns the cached rows on subsequent calls.
 */
export function loadRuns(): StressRun[] {
  if (cache) return cache.runs;
  if (loadError) throw loadError;

  const dir = corpusDir();
  const runsPath = path.join(dir, "runs.jsonl");
  try {
    const raw = fs.readFileSync(runsPath, "utf-8");
    const runs: StressRun[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        runs.push(JSON.parse(trimmed) as StressRun);
      } catch (parseErr) {
        // Skip malformed line but keep loading — corpus should be validated at build time.
        console.warn("[stress-benchmarks] skipping malformed row:", parseErr);
      }
    }
    cache = {
      runs,
      loadedAt: new Date().toISOString(),
      runsPath,
    };
    return runs;
  } catch (err: any) {
    loadError = new Error(
      `[stress-benchmarks] failed to load ${runsPath}: ${err?.message ?? err}`,
    );
    throw loadError;
  }
}

export interface StoreHealth {
  ok: boolean;
  n_runs: number;
  runs_path: string;
  loaded_at: string | null;
  error?: string;
}

/**
 * Health probe used by /api/status. Does not throw.
 */
export function health(): StoreHealth {
  try {
    const runs = loadRuns();
    return {
      ok: true,
      n_runs: runs.length,
      runs_path: cache!.runsPath,
      loaded_at: cache!.loadedAt,
    };
  } catch (err: any) {
    return {
      ok: false,
      n_runs: 0,
      runs_path: path.join(corpusDir(), "runs.jsonl"),
      loaded_at: null,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Reset cache. For tests only.
 */
export function _resetForTests(): void {
  cache = null;
  loadError = null;
}

/**
 * Public accessor for the resolved corpus directory, used by the route
 * layer to read PROVENANCE.md via the same search order.
 */
export function resolveCorpusDir(): string {
  return corpusDir();
}
