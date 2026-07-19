# Agent 5 — Integrations audit

**Scope**: CORS, env vars, deploy topology, cross-service seams, secret handling.

---

## Deploy topology (from `render.yaml`)

Four Render services declared:
```
1. openclaw-api        (node)   /api/*          — the Express server
2. openclaw-saas       (static) SPA             — VITE_API_URL → openclaw-api-b9wb
3. openclaw-benchmark  (python) legacy FastAPI  — Kairos/ZOA (documented DEAD)
4. archon-factory      (node)   packages/archon-factory  — legacy skill forge (superseded by lib/archon in-process)
```

Frontend static site's `VITE_API_URL` = `openclaw-api-b9wb.onrender.com`. **BUT** `HANDOFF_integration_agent.md §1.1` says the canonical API is `openclaw-api-k30t.onrender.com`. **These are different deploys.** Verifying is Agent 5's job:
- **Finding**: `render.yaml` and HANDOFF disagree on canonical hostname. Cannot resolve without Render dashboard access; flag for user.

## Environment variables — required inventory

**Server-side (openclaw-api)** — from `render.yaml` + `.env.example`:

| Var | Purpose | Status |
|---|---|---|
| `DATABASE_URL` | Postgres (Render `zeta-caid-prod`) | LIVE |
| `CLERK_SECRET_KEY` | Auth | LIVE (per audit) |
| `SESSION_SECRET` | Session signing | LIVE (auto-generated) |
| `OPENROUTER_API_KEY` | Legal drafting, in-process archon | LIVE |
| `OPENROUTER_API_KEY_2` | Fallback (audit says often missing) | PARTIAL |
| `GOOGLE_AI_API_KEY` | Archon Gemini fallback | LIVE (assumed set) |
| `BENCHMARK_SERVICE_URL` | Old external FastAPI upstream | **STALE — dead upstream** |
| `KAIROS_SERVICE_URL` | Same dead upstream | **STALE** |
| `BENCHMARK_GATE_ENABLED` | Enables the (broken) gate at tenants.ts:372 | LIVE flag / broken effect |
| `DRY_RUN` | Modal dispatch stub mode | LIVE (defaults `true`) |
| `FRONTEND_URL` | CORS allowlist | LIVE |

**Client-side (Vite)**:
| Var | Purpose | Status |
|---|---|---|
| `VITE_API_URL` | Base for `apiFetch` | LIVE |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk browser | LIVE |
| `VITE_CLERK_PROXY_URL` | Clerk FAPI proxy path | LIVE |
| `VITE_ZOA_SERVICE_URL` | ZOA direct calls (bypasses api-server for events feed) | STALE — points at dead openclaw-benchmark |
| `VITE_ARCHON_FACTORY_URL` | archon-factory service direct calls | LIVE if archon-factory still deploys |

## CORS

`artifacts/api-server/src/app.ts:56-84`:
- Allowlist: exact `FRONTEND_URL` env var + any `*.onrender.com` fallback
- `credentials: true` (Clerk cookies require this)
- Server-to-server (no `origin`) always allowed
- **For the new domain**: no CORS change needed — `/api/stress-benchmarks/*` inherits the app-level CORS. Frontend at `openclaw-saas.onrender.com` → `openclaw-api-*.onrender.com` is already in the allowlist.

## Integration seams to touch (new domain)

### 1. Read-only corpus mount

The 909-row JSONL lives on `/mnt/shared-workspace/stress-runs/runs.jsonl` in the sandbox. In production (Render), we need it committed to the repo.

**Deploy strategy**:
- Copy `/mnt/shared-workspace/stress-runs/runs.jsonl` (+ `stress_summary.json`, `report_stress.md`) into `artifacts/api-server/corpus/stress-benchmarks/` at commit time.
- Include a small provenance file:
  ```
  corpus/stress-benchmarks/PROVENANCE.md
    Source repo: github.com/fjkiani/mcp-universe-benchmarks
    Source branch: sprint-4-stress-suite
    Source SHA: d1e22ab (Gemma addition) — 909 runs
    Run date range: 2026-07-15 → 2026-07-18
    Models covered: 11 (gemini/gemma-4-*, gemini/gemini-2.5-*, groq/*, openrouter/*)
    Categories: baseline, concurrency, adversarial, faults, ratelimit
  ```
- Add `STRESS_BENCHMARKS_CORPUS_PATH` env var (optional override) — otherwise `runStore.ts` uses `path.resolve(__dirname, '../../corpus/stress-benchmarks/runs.jsonl')`.

**Corpus size**: 909 lines × ~1KB avg ≈ 1MB. Git-friendly. **DO commit it directly** (do not use LFS — small enough).

### 2. `render.yaml` changes (v1)

Add to `openclaw-api` envVars:
```yaml
- key: STRESS_BENCHMARKS_CORPUS_PATH
  value: /opt/render/project/src/artifacts/api-server/corpus/stress-benchmarks/runs.jsonl
```

**Do NOT** touch `BENCHMARK_SERVICE_URL` / `KAIROS_SERVICE_URL` unless we also fix `benchmarkClient.ts` — those are a separate PR concern. **Do** add a comment above them: `# STALE — see MDC_training.md; kept for legacy jobMonitor probes`.

### 3. The `checkBenchmarkGate` fix

Two options in Agent 2's plan:
- (a) fail-open when service unreachable: `passes:true, reason:"gate-service-unreachable"` + log
- (b) delegate to in-process `benchmarkRunner.ts`

**Recommendation: (b)**. `benchmarkRunner.ts` already has `benchmarkSkill(skill: GeneratedSkill)` — just call it directly from `checkBenchmarkGate`. This turns the currently-broken gate into a real gate, without needing the dead FastAPI upstream.

**Small caveat**: `benchmarkRunner.ts` expects a `GeneratedSkill` (has `.implementation` — TS code). Skills in the catalog table have a URL/id and description but may not have implementation TS. Need to load implementation from wherever skills are stored (Agent 5 flags for Agent 2 to resolve).

### 4. Cross-machine reliability

The `mcp-universe-benchmarks` corpus is generated on Python side. Refresh flow:
```
mcp-universe-benchmarks (Python CLI) →
  runs.jsonl checked into openclaw-saas artifacts/api-server/corpus/stress-benchmarks/ →
  api-server picks up on deploy
```
Explicit — no live pipe. Any new stress data requires: (1) run stress CLI, (2) commit result JSONL, (3) push. Documented as such.

### 5. Health status wiring

`routes/status.ts` — add stress-benchmarks probe:
```ts
try {
  const { getStressRunCount } = await import("../lib/stress-benchmarks/runStore.js");
  const n = getStressRunCount();
  checks.stress_benchmarks = { ok: n > 0, detail: `${n} runs loaded from corpus` };
} catch (err: any) {
  checks.stress_benchmarks = { ok: false, detail: err.message };
}
```
Public endpoint — no auth. Follows existing pattern.

## Follow-ups (NOT this pass)

1. **FastAPI wrapper** on mcp-universe-benchmarks (`backend/main.py` referenced in HANDOFF §5) — expose `POST /api/v1/stress/run` for live triggering. Env `BENCHMARK_SERVICE_URL` becomes real. `benchmarkClient.ts` becomes actual live path.
2. **archon-zeta.onrender.com** — check if deployed; either wire packages/archon workflows to it or delete `packages/archon/` shim entirely.
3. **openclaw-benchmark.onrender.com** — decide: revive Kairos or fully migrate to in-process. Right now it's Schrödinger's service.
4. **b9wb vs k30t** — pick a canonical openclaw-api URL and update `render.yaml` + HANDOFF to match.

## Owner-boundary reminders (per HANDOFF §4)

Agent 5 must NOT modify (this pass):
- `lib/kairosClient.ts` (Model Forge owner)
- `lib/jobMonitor.ts` (Model Forge owner)
- `routes/forge.ts` (Model Forge owner)
- `middleware/requireWorkspaceMember.ts` (Model Forge owner)

Agent 5 MAY modify:
- `render.yaml` (envVars additions, not removals)
- `.env.example` (new vars, comments on stale vars)
- `routes/status.ts` (add probe)
- `lib/benchmarkClient.ts` (make failure fallback graceful — swap in-process runner)
