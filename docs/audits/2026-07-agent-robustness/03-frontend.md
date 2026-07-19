# Agent 3 — Frontend audit

**Scope**: `artifacts/openclaw-saas/src` — pages, components, apiFetch, Clerk wiring.

---

## Frontend patterns established (evidence)

1. **Router**: `wouter` (see `App.tsx`). Every non-public route is `<ProtectedRoute component={PageX}>`.
2. **Nav**: `Layout.tsx:29-37` — `navItems` is a hardcoded array. **Adding a nav entry = one line here** + one `<Route>` in `App.tsx`.
3. **Auth**: Clerk via `@clerk/react`, wrapped with `useSafeUser`/`useSafeClerk` for dev-without-Clerk. Layout renders identically in both modes.
4. **API client**: `apiFetch` (`lib/apiFetch.ts`) is the canonical fetch wrapper. Prepends `VITE_API_URL`, attaches Bearer + `X-User-Id` for cross-origin dev instances.
5. **Data fetching**: Two patterns coexist:
   - Codegen'd hooks from `@workspace/api-client-react` (from `lib/api-spec` OpenAPI) — `useListSkills`, `useListForgeWorkspaces`, etc. **Correct pattern for anything spec'd.**
   - Direct `apiFetch(...)` + `useState` for ad-hoc routes not in the OpenAPI (skills.tsx benchmark polling).
6. **UI kit**: shadcn primitives in `components/ui/` (57 files) — everything needed is there: `tabs`, `table`, `card`, `badge`, `chart`, `dialog`, `progress`, `skeleton`, `select`, `separator`, `tooltip`, `spinner`.
7. **Font/style**: mono font, dark-first theme with light toggle in `Layout`.
8. **Testids**: convention `data-testid="nav-X"`, `card-stat-X`, etc. — must follow.

## Existing stress-adjacent components (verified)

- `components/BenchmarkPanel.tsx` — CERTIFIED/CONDITIONAL/FAILED/INCONCLUSIVE grade badge + level breakdown. Reusable for showing per-model stress-benchmark grades.
- `components/DatasetExplorer.tsx` — CUAD-style dataset schema browser. **Pattern reuse** for the stress corpus catalog view.
- `pages/skills.tsx` — has async polling pattern (`apiFetch` + setTimeout retry) — reuse if we later add live stress runs.

## Stub found on frontend

`pages/skills.tsx:47` calls `POST /api/skills/${skill.id}/benchmark` — that returns a `benchmark_id` from the (dead) `checkBenchmarkGate` upstream. When upstream is down, `runRes.ok` is false → shows "Benchmark service unavailable — please retry". **The frontend UX for this failure exists**. But because Agent 2 will switch to in-process runner, the L1-L4 benchmark path becomes actually LIVE — no frontend change needed.

## Frontend deliverables

### 1. New page: `pages/agent-robustness/index.tsx`

Route: `/agent-robustness`.

Layout: PageHeader + 5 tabs (baseline, concurrency, adversarial, faults, ratelimit) + a persistent leaderboard header.

```
┌ PageHeader: "Agent Robustness Benchmarks" ─────────────────┐
│  909 runs · 11 models · 5 categories                        │
├─────────────────────────────────────────────────────────────┤
│ [Leaderboard] [Model detail] [Failure taxonomy] [Corpus]    │
├─── Baseline · Concurrency · Adversarial · Faults · Rate ────┤
│                                                             │
│  <Selected tab content>                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. Sub-tabs (5 categories)

Each tab shares one component `<CategoryPanel category="baseline" />`:

- **Header row**: n_runs in this category, n_models covered, overall pass rate.
- **Model × domain matrix**: Table. Rows = models. Columns = domains (governance_traps, identity_service, etc). Cells = pass_rate (color-scaled).
- **Failure class breakdown**: Stacked bar per model — `none|wrong_answer|refusal|timeout|rate_limited|...`.
- **Latency chart**: p50/p95 per model (`Chart` primitive from shadcn or a simple bar).
- **Run drilldown table** (filterable): pageable list of runs w/ `response_preview` expansion.

### 3. Persistent leaderboard component

`components/StressLeaderboard.tsx` — top-of-page component always visible. Shows:
- Model name + provider
- Pass rate (%)
- p50/p95 latency
- n_runs
- Sorted by pass rate desc; sortable columns.

Reuse `BenchmarkGradeBadge` for grade equivalence (>=50% pass = CERTIFIED, >=25% CONDITIONAL, <25% FAILED — simple threshold mirroring `benchmarkRunner.ts`).

### 4. Data fetching

**Do not add** to `api-spec` yet (would trigger OpenAPI regen for one domain — heavier than useful in v1). Use direct `apiFetch` + `useQuery` (TanStack Query is already available):

```ts
// src/pages/agent-robustness/hooks.ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function useStressSummary() {
  return useQuery({
    queryKey: ["stress", "summary"],
    queryFn: () => fetchJson<StressSummary>("/api/stress-benchmarks/summary"),
  });
}

export function useStressModels() {
  return useQuery({
    queryKey: ["stress", "models"],
    queryFn: () => fetchJson<StressModel[]>("/api/stress-benchmarks/models"),
  });
}

export function useStressRuns(filters: RunFilters) {
  return useQuery({
    queryKey: ["stress", "runs", filters],
    queryFn: () => fetchJson<StressRunPage>(`/api/stress-benchmarks/runs?${new URLSearchParams(filters as any)}`),
  });
}
```

### 5. Nav + routing wiring

**`Layout.tsx:29-37`** — add:
```ts
{ href: "/agent-robustness", icon: Activity, label: "Robustness" },
```
(`Activity` icon already imported at line 22.)

**`App.tsx`** — add:
```tsx
<Route path="/agent-robustness"><ProtectedRoute component={AgentRobustnessPage} /></Route>
```

### 6. Auth policy

Per HANDOFF §6 invariants: all tenant-scoped routes must verify Clerk. But **stress-benchmarks data is public benchmark research** — reasonable to keep the page under `<ProtectedRoute>` for consistency (any logged-in tenant can view), but the API routes should be unauth'd (like `/api/status`). That's Agent 2's job — Agent 3 renders whatever's there.

### 7. What NOT to build

- **No new UI kit primitives** — everything's in `components/ui/`.
- **No stress-run-trigger button** — v1 is read-only. Adding a "Run new stress test" button would be a fake affordance (no FastAPI upstream). Show a `<Sheet>` explaining the corpus origin (mcp-universe-benchmarks repo, git SHA, run date) and link to the source repo instead.
- **No mocked charts** — every visible number must come from `/api/stress-benchmarks/*`.
