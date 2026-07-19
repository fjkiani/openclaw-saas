# `lib/stress-benchmarks/`

In-process reader + aggregator for the **Agent Robustness Benchmarks** domain.

## What this is

Stress-test results from `mcp-universe-benchmarks`, exposed over HTTP so the
openclaw-saas frontend can render a live leaderboard, category breakdowns, and
failure-class analysis for the Agent Robustness page.

This module **replaces the (dead) external `openclaw-benchmark` FastAPI
service** for this domain. It reads a JSONL corpus committed into
`corpus/stress-benchmarks/` — no external service call, no external DB.

## Files

- `types.ts` — `StressRun`, `StressSummary`, `LeaderboardEntry`, etc.
- `runStore.ts` — one-time JSONL load + cache + health probe.
- `aggregate.ts` — pure functions: leaderboard, category / domain / failure
  breakdowns, filtered pagination, facets.

## Corpus location

`artifacts/api-server/corpus/stress-benchmarks/`

- `runs.jsonl` — one row per (model × task × perturbation × run_id)
- `stress_summary.json` — precomputed leaderboard (fallback if runs.jsonl
  cannot be loaded)
- `PROVENANCE.md` — source repo / branch / commit / generation timestamp

## Contract

The route layer (`routes/stressBenchmarks.ts`) calls exactly these entry
points:

```ts
import { loadRuns, health } from "./lib/stress-benchmarks/runStore";
import {
  summary,
  leaderboard,
  categoryBreakdown,
  domainBreakdown,
  failureClassBreakdown,
  queryRuns,
  facets,
} from "./lib/stress-benchmarks/aggregate";
```

## Corpus size guidance

Current corpus: **909 rows, ~1 MB**. Fits comfortably in memory. If the
corpus grows past ~50 MB / ~500k rows, migrate to on-disk indexing (SQLite
or DuckDB) — this module is deliberately dumb for now.

## What this module is NOT

- **Not a benchmark runner.** Rows are baked at build time; no live jobs.
- **Not a replacement for `lib/archon/benchmarkRunner.ts`.** That still runs
  live L1–L4 skill judgments for the Archon domain. See
  `.cursor/rules/11-agent-robustness.mdc` for the domain boundary.
- **Not tied to Clerk auth.** Endpoints are read-only and safe to expose
  without a tenant (though the mount point may still require auth via
  higher-level middleware).
