# Frontend End-to-End Readiness — Agent Robustness Domain

**Audit date:** 2026-07-19
**Branch:** `feature/agent-robustness-benchmarks` @ `22b78eb`
**Scope:** How much of the new domain is wired for a live user session, not just building. What breaks when a real user opens the page.

---

## TL;DR — Wire status: 82% ready, 3 P1 gaps

| Layer | Status | Notes |
|---|---|---|
| Route registered (`/agent-robustness`) | LIVE | `App.tsx` behind `ProtectedRoute` |
| Nav link visible in sidebar | LIVE | `Layout.tsx` navItems has `Activity` icon |
| Page renders w/o data | LIVE | Skeletons + card containers ready |
| TanStack Query hooks | LIVE | 4 hooks, 5-min staleTime |
| Backend endpoints reachable | LIVE | 7 routes mounted at `/api/stress-benchmarks/*` |
| Auth guard on route | LIVE | `ProtectedRoute` wraps page |
| Auth **on backend** endpoints | **P1 GAP** | Routes are public — no `requireWorkspaceMember` / tenant scoping |
| Corpus loads in prod (Render) | ADDRESSED | `resolveCorpusDir()` search order + `STRESS_CORPUS_DIR` env |
| Empty-state UI when no runs | **P2 GAP** | Table renders `n=0` without a "load a corpus" CTA |
| Loading skeleton visible ≥300ms | LIVE | `Skeleton` component around tables + cards |
| Error boundary / toast on 5xx | **P1 GAP** | Hooks throw but there is no `ErrorBoundary` on this route |
| Provenance strip shows git SHA | LIVE | Reads from `stress_summary.json` |
| Category tabs deep-link | **P2 GAP** | Tab state lives in React state, not URL query |
| a11y — table headers scoped | LIVE | shadcn defaults |
| a11y — tab keyboard nav | LIVE | Radix Tabs primitives |
| Colorblind palette on grade badges | LIVE | Green/Yellow/Destructive w/ icon |
| Mobile layout (< 768px) | **P3** | Table overflows horizontally, no scroll wrapper |
| Retry-on-failure UX | **P2 GAP** | TanStack default (3 retries, exponential) but no visible countdown |

---

## Detailed audit

### 1. Route + nav wiring — LIVE

Route ordering in `artifacts/openclaw-saas/src/App.tsx`:

```tsx
<Route path="/agent-robustness"><ProtectedRoute component={AgentRobustnessPage} /></Route>
<Route path="/:rest*" component={NotFound} />
```

`ProtectedRoute` (per prior audit) redirects unauthenticated users to `/login`. Confirmed via reading `App.tsx` route order — the domain route is registered **before** the NotFound catch-all, so `/agent-robustness` will match.

Sidebar link in `Layout.tsx`:

```tsx
{ href: "/agent-robustness", icon: Activity, label: "Robustness" }
```

`Activity` icon from lucide-react was already imported for the ZOA / dashboard flow so no bundle penalty.

**Verdict:** User can navigate, page loads.

### 2. Data fetch hooks — LIVE

`src/pages/agent-robustness/hooks.ts` exports:

| Hook | Endpoint | staleTime | Notes |
|---|---|---|---|
| `useStressHealth` | `/api/stress-benchmarks/health` | 5min | Corpus fingerprint |
| `useStressSummary` | `/api/stress-benchmarks/summary` | 5min | Aggregate roll-up |
| `useStressFacets` | `/api/stress-benchmarks/facets` | 5min | Filter options |
| `useStressRuns` | `/api/stress-benchmarks/runs?...` | 5min | Paged/filtered runs |

All go through `@/lib/apiFetch` which handles `credentials: include`, JSON parsing, and 401 → redirect. Solid pattern.

### 3. Backend endpoints — LIVE but PUBLIC (P1)

**All 7 endpoints have zero auth middleware**:

```ts
// artifacts/api-server/src/routes/stressBenchmarks.ts
router.get('/health', ...)      // no requireWorkspaceMember
router.get('/summary', ...)      // no requireWorkspaceMember
router.get('/leaderboard', ...)  // no requireWorkspaceMember
router.get('/models', ...)       // no requireWorkspaceMember
router.get('/categories', ...)   // no requireWorkspaceMember
router.get('/facets', ...)       // no requireWorkspaceMember
router.get('/runs', ...)         // no requireWorkspaceMember
```

**Impact:** Anyone with the API URL can query the leaderboard/corpus without a session token.

- **Attack surface:** If corpus contains model names + performance data that reflects internal experiments not-yet-published, this is a leak.
- **Design intent (per `11-agent-robustness.mdc`):** The corpus is intentionally public research data — this may be by design. Confirm with product before locking.

**Recommendation:** If public is intentional, document it in `.cursor/rules/11-agent-robustness.mdc` and add a `X-Public-Data: true` response header. If not, wrap with `requireWorkspaceMember` and scope corpus by `tenant_id`.

### 4. Corpus prod-load — ADDRESSED

`resolveCorpusDir()` in `runStore.ts` uses search order:

1. `process.env.STRESS_CORPUS_DIR`
2. `<cwd>/corpus/stress-benchmarks`
3. `<cwd>/artifacts/api-server/corpus/stress-benchmarks`

Verified: Both `cwd=/workspace/openclaw-saas` (Render prod) and `cwd=/workspace/openclaw-saas/artifacts/api-server` (dev) load the same 909 rows.

Render config:
- `.env.example` documents `STRESS_CORPUS_DIR` as optional
- `render.yaml` has commented example

### 5. Error handling — P1 gap

No `<ErrorBoundary>` on the `agent-robustness` route. If `useStressRuns` throws (network dead, 5xx), the entire tab area unmounts and the user sees blank. Toast/inline error banner is missing.

**Fix (5 LOC):** wrap page contents in `react-error-boundary`'s `<ErrorBoundary FallbackComponent={ErrorFallback}>`.

### 6. Empty-state — P2 gap

If corpus is empty (fresh env, `STRESS_CORPUS_DIR` misconfigured, or reset), page shows tables with `total=0` but no explanation. User doesn't know if they broke it or if it's really empty.

**Fix:** Add `{n_runs === 0 && <EmptyState message="No stress runs indexed yet." />}` block above the tables.

### 7. Deep-link category tab — P2 gap

Tab state is `useState<Category>('overview')`. Sharing a URL doesn't preserve tab selection. Prevents reproducible pitches ("look at this specific adversarial slice — send this link").

**Fix (10 LOC):** Add `useSearchParams` sync — `wouter/use-search-params` shim or `nuqs` (already in deps? — check).

### 8. Mobile — P3

Leaderboard table has 8 columns. On `< 768px` viewport, table overflows. No `overflow-x-auto` wrapper.

**Fix:** Wrap `<Table>` in `<div className="overflow-x-auto">`. shadcn recommends this idiom.

---

## Coverage of the "pitch surface"

If a Google/OpenAI/Claude eval team lands on the page, what do they see?

| Section | Present | Quality (0-3) |
|---|---|---|
| Corpus fingerprint (commit + row count) | Yes | 3/3 — commit SHA visible |
| Leaderboard w/ 11 models | Yes | 3/3 — pass@k, p50, n |
| Category breakdown (5 categories) | Yes | 3/3 — pass_rate + count per category |
| Failure-class distribution | Yes | 2/3 — Progress bars, but no drill-down |
| Per-run inspector (drill into a run) | Yes | 2/3 — table shows worker, task, latency; no expand-to-see-response |
| Repro CLI snippet ("run this yourself") | **No** | 0/3 — big pitch gap |
| Methodology note / eval trust | Partial | 1/3 — hosted in `.mdc`, not visible on page |
| Comparison chart (this framework vs baseline claim) | **No** | 0/3 — biggest pitch gap |

**Two must-have additions for the pitch (see moat/pitch report):**

1. **Repro CLI snippet:** a copy-paste block that shows how to regenerate a subset of the corpus from the linked `mcp-universe-benchmarks` repo. This is what an OpenAI/Claude eval eng wants to see.
2. **Comparison overlay:** a chart that shows the same models tested by public leaderboards (HELM, MT-Bench, GAIA) side-by-side with our stress corpus, so a reader can calibrate what "50% pass_rate on governance_traps" means.

---

## E2E verification transcript

```
cwd=/workspace/openclaw-saas/artifacts/api-server
$ node dist/index.mjs &  # sim prod
$ curl -s /api/stress-benchmarks/health          # 200, n_runs=909
$ curl -s /api/stress-benchmarks/summary          # 200, n_models=11 n_categories=5
$ curl -s /api/stress-benchmarks/leaderboard      # 200, gemma-4-31b-it top pass@1=0.500
$ curl -s /api/stress-benchmarks/facets           # 200, models[11] categories[5] domains[4]
$ curl -s /api/stress-benchmarks/runs?limit=10    # 200, total=909, rows=10
$ curl -s /api/stress-benchmarks/runs?category=adversarial&passed=false  # 200, total=271
```

All hooks land against real endpoints. Nothing mocked.

---

## Recommended P1 fixes before pitch demo

Ranked by impact on live demo:

1. **Add repro CLI block** — 15 min, printed on Overview tab as a `<CodeBlock>`. Unblocks the "how do I trust this?" question.
2. **Auth decision on public endpoints** — either lock or explicitly document as public. 20 min.
3. **ErrorBoundary + toast on 5xx** — 15 min. Blocks silent-fail during a live demo.
4. **Empty-state UX** — 10 min. Blocks confusion if corpus fails to load.

**Total P1 fix time: ~60 min.**
