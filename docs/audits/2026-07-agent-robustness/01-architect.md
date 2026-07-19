# Agent 1 — Architect audit

**Scope**: Repo topology, module layout, route registration, deploy targets, integration seams.
**Status labels** (per HANDOFF_integration_agent.md): LIVE / PARTIAL / VISION / STALE / FICTION.

---

## Topology (verified in tree)

```
openclaw-saas/
├── artifacts/
│   ├── api-server/          Express Node API (Render "openclaw-api")
│   │   └── src/routes/      24 routers, ALL mounted under /api (app.ts:99)
│   ├── mockup-sandbox/      CounselUI mockup harness
│   └── openclaw-saas/       Vite + React SPA (Render "openclaw-saas" static)
├── lib/                     Shared TS libs (api-client-react, db, skill-contract, etc.)
├── packages/
│   ├── archon/              Config-only shim → external archon-zeta.onrender.com
│   ├── archon-factory/      Local archon workflow CLI helper
│   └── video-intelligence/  Unrelated feature package
├── scripts/                 Standalone TS CLIs (legal corpus ingest, seeds)
└── .cursor/rules/           Product-vision + architecture + audit mdc files
```

**Deploy targets** (render.yaml):
- `openclaw-api` (Node) — Render Oregon starter, healthCheck `/api/healthz`
- `openclaw-saas` (static Vite build) — served from `artifacts/openclaw-saas/dist/public`
- Also LIVE elsewhere: Railway API (separate deploy, separate DB), Render mockup

**DB**: two Postgres instances (Render `openclaw-db` / `zeta-caid-prod` alias + Railway `zephyr`).

## The two Archons (disambiguated)

| Layer | Location | Behavior | Status |
|---|---|---|---|
| **In-process Archon** | `artifacts/api-server/src/lib/archon/` (7 files) | Self-contained skill generator + L1-L4 judge. Uses OpenRouter free tier models. DB-backed run store. | **LIVE** — comment: "Replaces the dead openclaw-benchmark.onrender.com external service" |
| **External Archon** | `packages/archon/` (config only) | Thin config + workflow YAML pointing at `archon-zeta.onrender.com` (external service). | **VISION** on canonical deploy (env not wired in render.yaml) |

**Decision (locked from user Q1)**: wire the new domain into **in-process** Archon as a peer engine.

## Route registration map (`src/routes/index.ts` → mounted at `/api` via `app.ts:99`)

24 routers registered:

```
health tenants chat connectors graphs skills dashboard billing webhooks
forge legal onboarding manuscript seo judge legal.clause.draft flywheel
legal.kb legal.counsel intelligence workflows archon status
```

Plus `admin` mounted independently at `index.ts:899`.

### Existing archon routes (`routes/archon.ts`)
- `GET  /api/archon/health`         — LIVE
- `POST /api/archon/generate`       — LIVE (fire-and-forget skill forge)
- `GET  /api/archon/run/:runId`     — LIVE (DB-backed)
- `GET  /api/archon/runs`           — LIVE (DB-backed, 20 latest)
- `POST /api/archon/debug/l1`       — LIVE (direct L1 judge probe)

**Extension target**: add stress-benchmarks routes as siblings — `/api/archon/stress/*` OR at top-level `/api/stress-benchmarks/*`. **Chose top-level** because the stress harness is a separate corpus of runs, not one of Archon's skill-forge outputs.

## Frontend

- **Router**: wouter, defined in `App.tsx` (14 routes)
- **Auth wall**: `<ProtectedRoute>` wraps all non-landing pages via ClerkProvider
- **Pages** (7 non-onboarding): landing, dashboard, agents, skills, billing, zoa (2275 LOC!), forge, startup-counsel (2510 LOC!)
- **API client**: `src/lib/apiFetch.ts` (base fetch wrapper) + `zoaClient.ts` (typed ZOA API)
- **UI kit**: shadcn-style components under `components/ui/`
- **Existing benchmark UI**: `components/BenchmarkPanel.tsx` (may already show benchmark grades — inspect during Frontend audit)

## Critical stub found (Agent 5 confirms callsite)

**`artifacts/api-server/src/lib/benchmarkClient.ts`** — calls `${BENCHMARK_SERVICE_URL}/api/v1/benchmark/{run,run-sync,:id}`. The FastAPI service it expects **does not exist** in `mcp-universe-benchmarks` (that repo is Python CLI-only, no HTTP layer). Consequence: `checkBenchmarkGate` at `tenants.ts:372` calls a dead upstream every skill install — silently 5xx or times out (`BENCHMARK_GATE_ENABLED=true` in render.yaml). Skills currently install with **no benchmark gate in production**.

## Config debt

`render.yaml` still has:
```yaml
BENCHMARK_SERVICE_URL: https://openclaw-benchmark.onrender.com   # ← DEAD
KAIROS_SERVICE_URL:    https://openclaw-benchmark.onrender.com   # ← DEAD
```

## Integration architecture proposal (for the new domain)

```
                            ┌─── Vite SPA ────┐
                            │ /agent-robustness│
                            │ (new page + tabs)│
                            └────────┬─────────┘
                                     │ apiFetch
                                     ▼
                    ┌────────────────────────────────────┐
                    │  openclaw-api  (Express)           │
                    │                                    │
                    │  routes/stressBenchmarks.ts  ← NEW │
                    │    /api/stress-benchmarks/*        │
                    │                                    │
                    │  lib/stress-benchmarks/            │
                    │    ├─ runStore.ts    (JSONL loader)│
                    │    ├─ aggregate.ts   (summary)     │
                    │    └─ types.ts                     │
                    └──────────┬─────────────────────────┘
                               │ reads
                               ▼
                    ┌─────────────────────────────────┐
                    │ /mnt/shared-workspace/          │
                    │   stress-runs/                  │
                    │     runs.jsonl (909 rows)       │
                    │     report_stress.md            │
                    │     stress_summary.json         │
                    └─────────────────────────────────┘

Optional (v2, follow-up): the CLI Python harness gets a thin FastAPI
wrapper so `benchmarkClient.ts` can trigger new stress runs. In v1,
data is read-only from artifacts already committed to
mcp-universe-benchmarks.
```

### Why read-only first
1. Stress runs take **minutes to hours** — sync endpoint model is wrong; SSE progress model is right. Building that correctly takes real time.
2. The 909-run corpus we already have (baseline/concurrency/adversarial/faults/ratelimit × 11 models) IS the story worth telling on the frontend.
3. Downgrading `benchmarkClient.ts` from stub-live to honest-vision (env note + fallback) is cheap and correct — no fake trigger buttons.

## Handoffs to next agents

- **Agent 2 (Backend)**: build `routes/stressBenchmarks.ts` + `lib/stress-benchmarks/` module. Ship the JSONL loader + 3 read endpoints (summary, models, runs). Also downgrade `benchmarkClient.ts` behaviour to fail-soft when service missing (currently probably crashes tenant install path).
- **Agent 3 (Frontend)**: build `/agent-robustness` page with 5-tab layout (baseline / concurrency / adversarial / faults / ratelimit) + leaderboard table + latency violin + failure-class breakdown.
- **Agent 4 (MDC/Docs)**: downgrade every claim in mdc files that references dead endpoints. Register the new domain in `.cursor/rules/`. Update `HANDOFF_integration_agent.md` §1.4.
- **Agent 5 (Integrations)**: verify `render.yaml` env vars, wire `mcp-universe-benchmarks` repo as a git subtree or point the API server at `/mnt/shared-workspace/stress-runs` (deploy strategy). Fix `checkBenchmarkGate` behaviour.

## Non-goals (this pass)

- Do NOT modify Forge (`forge.ts`, `kairosClient.ts`, `jobMonitor.ts`) per §4 of HANDOFF.
- Do NOT rewrite the in-process `lib/archon/` L1-L4 judge — new domain is a peer, not a replacement.
- Do NOT deploy anything to Render/Railway automatically — the audit + wiring lands as a PR only.
- Do NOT invent stress data — the corpus is what we have.
