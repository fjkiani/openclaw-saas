# PLAN — Wire mcp-universe-benchmarks into openclaw-saas as a new domain

**Goal**: Deliver a full stress-benchmarks vertical inside `openclaw-saas` — backend endpoints, frontend page, honest MDC docs, and a downgrade pass on the audit-flagged "unverified" claims. Anchor the stress corpus (909 runs, 11 models, 5 categories) inside OpenClaw so it renders and interrogates on the frontend.

## Locked decisions (from user Q&A)

| # | Decision |
|---|---|
| Q1 | **In-process `lib/archon/`** is the archon target. External archon-zeta stays a follow-up. |
| Q2 | Domain name = **Agent Robustness Benchmarks**. All 5 categories (baseline / concurrency / adversarial / faults / ratelimit) as sub-tabs. |
| Q3 | 5-agent audit shape = **5 named audit roles run sequentially by me**, each producing a report artifact. Reports saved under `/mnt/shared-workspace/openclaw-audit/`. |
| Q4 | Fake-claim policy = **downgrade + build critical**. Every fake gets an honest label; I only physically build the stubs on the new domain's critical path this pass. |

## What already exists (verified by Phase 1 inspection)

- OpenClaw is a real multi-tenant "AI workforce factory" — Node/Express + React SPA + Clerk + Postgres. 24 registered routers. Fresh audit ledger (`HANDOFF_integration_agent.md`, `MDC_training.md`, `MDC_architecture.md`) with LIVE/PARTIAL/VISION/STALE labels.
- **Two archons**: (1) in-process `artifacts/api-server/src/lib/archon/` (7 files, L1-L4 skill judge, "Replaces the dead openclaw-benchmark.onrender.com external service"); (2) `packages/archon-factory/` + `packages/archon/` config shim pointing at external `archon-zeta.onrender.com`. **Live path = in-process**.
- Existing archon route file `routes/archon.ts` has 5 routes (`/api/archon/{health, generate, run/:id, runs, debug/l1}`). New domain lands as siblings.
- Existing status endpoint `routes/status.ts` — pattern to extend for the new domain's probe.
- Frontend has shadcn primitives (`tabs`, `table`, `card`, `badge`, `chart`, `select`), TanStack Query, wouter, `apiFetch`. Layout has hardcoded `navItems` in `Layout.tsx:29-37`.
- **Existing `benchmarkClient.ts`** — expects a FastAPI at `BENCHMARK_SERVICE_URL/api/v1/benchmark/*`. **That FastAPI does not exist** in `mcp-universe-benchmarks` (Python CLI only). `checkBenchmarkGate` at `tenants.ts:372` therefore silently 5xx/times out against the dead `openclaw-benchmark.onrender.com`. This is the exact "fake seam" the user asked me to hunt.

## Phase-3 build plan (concrete deliverables, in order)

### Sprint A — Backend module (owner: Agent 2's plan)

1. Create `artifacts/api-server/src/lib/stress-benchmarks/`:
   - `types.ts` — verified TS types matching the 23-field JSONL schema.
   - `runStore.ts` — memoized JSONL loader from `STRESS_BENCHMARKS_CORPUS_PATH` (default `artifacts/api-server/corpus/stress-benchmarks/runs.jsonl`). Exports `getAllRuns()`, `getStressRunCount()`, `getFiltered({model, category, domain, passed, limit, offset})`.
   - `aggregate.ts` — leaderboard, category × model matrix, failure-class histogram, latency percentiles.
   - `README.md` — corpus origin, schema, refresh strategy.

2. Copy the 909-row corpus into the repo:
   - `artifacts/api-server/corpus/stress-benchmarks/runs.jsonl` (909 rows)
   - `artifacts/api-server/corpus/stress-benchmarks/stress_summary.json`
   - `artifacts/api-server/corpus/stress-benchmarks/PROVENANCE.md` (source repo + branch + SHA + run date + categories + model list).

3. Create `artifacts/api-server/src/routes/stressBenchmarks.ts` with 7 endpoints:
   ```
   GET  /api/stress-benchmarks/health
   GET  /api/stress-benchmarks/summary
   GET  /api/stress-benchmarks/models
   GET  /api/stress-benchmarks/categories
   GET  /api/stress-benchmarks/runs
   GET  /api/stress-benchmarks/failure-classes
   GET  /api/stress-benchmarks/gemma-callout
   ```
   Public read (no auth) — data is benchmark research, follows the `routes/status.ts` pattern.

4. Register the router in `routes/index.ts` (add import + `router.use(stressBenchmarksRouter)`).

5. Extend `routes/status.ts` with a `stress_benchmarks` probe.

6. Fix `lib/benchmarkClient.ts` — `checkBenchmarkGate` degrades gracefully: try HTTP upstream once with 5s timeout, on failure delegate to in-process `lib/archon/benchmarkRunner.ts` if the skill has code, else return `{passes:true, reason:"gate-fallback-open"}` and log. This restores `tenants.ts` skill install flow without needing the dead FastAPI.

### Sprint B — Frontend page (owner: Agent 3's plan)

7. Create `artifacts/openclaw-saas/src/pages/agent-robustness/index.tsx`:
   - Header row: 909 runs · 11 models · 5 categories.
   - Persistent `<StressLeaderboard />` component (top of page).
   - 5-tab section (baseline / concurrency / adversarial / faults / ratelimit), each rendering `<CategoryPanel category={x} />` with model × domain matrix, failure taxonomy stacked bar, latency chart, and a filterable run drilldown table.
   - Bottom `<CorpusProvenance />` sheet showing source repo + SHA + run date.

8. Create `artifacts/openclaw-saas/src/pages/agent-robustness/hooks.ts`:
   - `useStressSummary`, `useStressModels`, `useStressCategories`, `useStressRuns(filters)`, `useStressFailureClasses`, `useGemmaCallout` — all via TanStack Query + apiFetch.

9. Wire the nav:
   - `Layout.tsx:29-37` — add `{href:"/agent-robustness", icon:Activity, label:"Robustness"}`.
   - `App.tsx` — add `<Route path="/agent-robustness"><ProtectedRoute component={AgentRobustnessPage}/></Route>`.

10. **No fake affordances**: no "Run new stress" button in v1. `<CorpusProvenance />` explains that new runs require the `mcp-universe-benchmarks` CLI + commit refresh (documented, not hidden).

### Sprint C — MDC/docs downgrade + additions (owner: Agent 4's plan)

11. **Create** `.cursor/rules/11-agent-robustness.mdc` — spec for the new domain (frontend routes, backend endpoints, corpus source, verification commands per §Verification checklist convention from `08-legal-corpus`).

12. **Downgrade in place** (audit-flagged fictions):
    - `.cursor/rules/05-execution-engines.mdc` lines 12-15 — mark ZOA/Archon/Kairos rows as `STALE — see HANDOFF §1.4`, add "Current live path" column pointing at `lib/archon/`.
    - `.cursor/rules/05-execution-engines.mdc` lines 66-90 — add "Live today = in-process" preamble to Archon section; demote external-service body to `VISION / legacy`.
    - `.cursor/rules/02-architecture.mdc` line 48 — add `STALE` marker to the `openclaw-benchmark` row + footnote.
    - `.cursor/rules/02-architecture.mdc` lines 69-70 — clarify that `packages/archon/` = config shim, `packages/archon-factory/` = legacy standalone, live code = `lib/archon/`.
    - `.env.example` line 11 — comment: "PARTIAL — FastAPI wrapper for mcp-universe-benchmarks is a v2 target; today gate uses in-process runner."

13. **Update** `HANDOFF_integration_agent.md`:
    - §1.3 register the 7 new `/api/stress-benchmarks/*` routes as LIVE (with verification commands).
    - §1.5 register the new `/agent-robustness` frontend page.

### Sprint D — Integrations wiring (owner: Agent 5's plan)

14. `render.yaml` — add `STRESS_BENCHMARKS_CORPUS_PATH` env var to `openclaw-api`. Add comments (not removals) marking `BENCHMARK_SERVICE_URL` and `KAIROS_SERVICE_URL` as `# STALE — see MDC_training.md; kept for legacy jobMonitor probes`.

15. `.env.example` — same additions + honest comments on the stale vars.

### Sprint E — Verification (mandatory before "done")

16. Local:
    - `pnpm --filter @workspace/api-server run typecheck` — MUST pass.
    - `pnpm --filter @workspace/openclaw-saas run typecheck` — MUST pass.
    - Start api-server locally, `curl http://localhost:3001/api/stress-benchmarks/health` — must return `{ok:true, n_runs:909}`.
    - `curl http://localhost:3001/api/stress-benchmarks/summary` — non-empty JSON.
    - `curl http://localhost:3001/api/stress-benchmarks/models` — non-empty array with 11 models.
    - `curl http://localhost:3001/api/status` — new `stress_benchmarks` field present.

17. Frontend: `pnpm --filter @workspace/openclaw-saas run build` — MUST pass. Visually confirm `/agent-robustness` route renders with real data.

18. Commit + push to a new branch on `fjkiani/openclaw-saas` (do NOT push to main — user reviews first).

## What I will NOT do (per fake-claim policy = downgrade + build critical)

- Not fixing every FICTION flagged in `04-model-forge.mdc` (Model Forge owner boundary per HANDOFF §4).
- Not writing FastAPI wrapper for `mcp-universe-benchmarks` in this pass (v2 follow-up).
- Not touching `routes/forge.ts`, `lib/kairosClient.ts`, `lib/jobMonitor.ts` (Model Forge owner).
- Not deploying anything — PR is opened, user merges + deploys.
- Not inventing data — the 909-run corpus is what we have.
- Not adding a "Run new stress test" button unless the FastAPI upstream is real. In v1 the UX is honest read-only.

## Files touched (final list)

**New files (7)**:
```
artifacts/api-server/src/lib/stress-benchmarks/types.ts
artifacts/api-server/src/lib/stress-benchmarks/runStore.ts
artifacts/api-server/src/lib/stress-benchmarks/aggregate.ts
artifacts/api-server/src/lib/stress-benchmarks/README.md
artifacts/api-server/src/routes/stressBenchmarks.ts
artifacts/openclaw-saas/src/pages/agent-robustness/index.tsx
artifacts/openclaw-saas/src/pages/agent-robustness/hooks.ts
```

**New corpus files (3)**:
```
artifacts/api-server/corpus/stress-benchmarks/runs.jsonl        (909 rows, ~1MB)
artifacts/api-server/corpus/stress-benchmarks/stress_summary.json
artifacts/api-server/corpus/stress-benchmarks/PROVENANCE.md
```

**New MDC (1)**:
```
.cursor/rules/11-agent-robustness.mdc
```

**Modified files (6)**:
```
artifacts/api-server/src/routes/index.ts          — register new router
artifacts/api-server/src/routes/status.ts         — add probe
artifacts/api-server/src/lib/benchmarkClient.ts   — graceful fallback via lib/archon
artifacts/openclaw-saas/src/App.tsx               — add route
artifacts/openclaw-saas/src/components/Layout.tsx — add nav item
render.yaml                                        — add STRESS_BENCHMARKS_CORPUS_PATH env, mark stale vars
.env.example                                       — new env var + honest comments
```

**MDC downgrades (in-place edits, 3 files)**:
```
.cursor/rules/02-architecture.mdc                  — STALE markers
.cursor/rules/05-execution-engines.mdc             — STALE markers + "Live today" preamble
.cursor/rules/HANDOFF_integration_agent.md         — register new domain in §1.3 + §1.5
```

**Audit reports** (already written, `/mnt/shared-workspace/openclaw-audit/`):
```
01-architect.md   02-backend.md   03-frontend.md   04-mdc-docs.md   05-integrations.md
```

## Estimated scope

- Backend (Sprint A): ~400 LOC across 5 files. Straightforward — data is on disk.
- Frontend (Sprint B): ~600 LOC — 1 page + 4-5 subcomponents + hooks.
- MDC downgrades (Sprint C): ~80 lines of surgical edits + 1 new ~200-line MDC.
- Wiring (Sprint D): ~20 lines across `render.yaml` + `.env.example`.

Total time before push: single sitting.

## Success criteria

1. `/api/stress-benchmarks/models` returns real leaderboard JSON (11 models, sortable by pass rate).
2. Frontend `/agent-robustness` page renders the same data with all 5 tabs live.
3. `pnpm typecheck` passes on both workspaces.
4. Every LIVE claim in the new MDC file has a paste-able verification command.
5. `benchmarkClient.ts` no longer hangs 65s on skill install when the dead FastAPI is unreachable.
6. No new fake affordances — read-only v1 stays honest.
7. All 5 audit reports remain in `/mnt/shared-workspace/openclaw-audit/` and are referenced from `.cursor/rules/11-agent-robustness.mdc`.

## Risks & mitigations

- **Corpus size**: 1MB is fine for git; if it grows past ~10MB, migrate to LFS or an object store.
- **In-process fallback for `checkBenchmarkGate`**: `benchmarkRunner.ts` needs `skill.implementation`. If skills catalog rows don't have implementation TS, the fallback returns `passes:true, reason:"gate-fallback-open"` and logs — flagged as PARTIAL. Not silent, not lying.
- **Deploy**: user is opening the PR, not auto-deploying. If Render deploy fails on the new corpus file path, `STRESS_BENCHMARKS_CORPUS_PATH` env is settable.

## Approval requested

Approve this plan and I'll run Phase 3 straight through. Ask for changes if you want a different scope split, a different domain slug, or want the FastAPI wrapper built in the same pass (heavier — different plan).
