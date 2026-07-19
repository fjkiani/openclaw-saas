# Agent 2 — Backend audit

**Scope**: All `artifacts/api-server/src/routes/*.ts` and `lib/*.ts`. Where are the stubs? What's the concrete backend delta for the new domain?

---

## Stubs & landmines (with evidence)

### 1. `benchmarkClient.ts` — dead upstream, silent gate breakage
- **Claim** (env comment): "Points to the running mcp-benchmarks FastAPI service"
- **Reality**: `mcp-universe-benchmarks` repo has **no FastAPI** — it's a Python CLI. `render.yaml` sets `BENCHMARK_SERVICE_URL=https://openclaw-benchmark.onrender.com` — documented dead per HANDOFF_integration_agent.md §1.4 ("Kairos LLM layer failed in probes").
- **Impact**: `tenants.ts:372` `checkBenchmarkGate` is called on every `POST /api/tenant-skills` install. With `BENCHMARK_GATE_ENABLED=true` (render.yaml default) it will hang for 65s (`runBenchmarkSync` timeout) or crash.
- **Fix (this pass)**: make `checkBenchmarkGate` degrade gracefully. If `BENCHMARK_SERVICE_URL` is unreachable, either (a) return `passes: true, reason: "gate-unavailable-fallback-open"` and log, OR (b) delegate to the in-process `benchmarkRunner.ts` (already exists, "Replaces the dead openclaw-benchmark.onrender.com external service"). **Choose (b)** — the code is already there.
- **Status downgrade**: `benchmarkClient.ts` header comment currently says "calls the mcp-universe-benchmarks FastAPI service" → must say "**PARTIAL** — FastAPI upstream not deployed; primary path is now `lib/archon/benchmarkRunner.ts`".

### 2. Stale env pointers in `render.yaml`
- `BENCHMARK_SERVICE_URL: https://openclaw-benchmark.onrender.com` → **dead**
- `KAIROS_SERVICE_URL:    https://openclaw-benchmark.onrender.com` → **dead**
- Agent 5 (Integrations) will fix these; Agent 2 flags them for the audit.

### 3. `jobMonitor.ts` — in-process polling with known limitation
- Comment: "in-process setInterval, does not survive restart or horizontal scale-out. Replacement target: pg-boss or BullMQ."
- **Status**: PARTIAL (correctly labelled in code) — not touching this pass per §4 owner-boundary.

### 4. Unused/mock secrets fallback
- `lib/secrets.ts` has `DRY_RUN` mode with `sk-mock-openrouter-DRYRUN` etc. — **legit** (documented, deterministic, tests only). Not a stub.

### 5. Placeholder patterns in generated drafts
- `lib/legalActionEngine.ts:308-338` uses "[PLACEHOLDER: ...]" strings by design for user-fillable slots. **Legit** — flags them for detection later.

## Existing archon backend inventory

**`lib/archon/`** (7 files, all in-process):
| File | Purpose | Status |
|---|---|---|
| `config.ts` | Model priority + API keys | LIVE |
| `openrouter.ts` | OpenRouter/Gemini call wrapper w/ fallbacks | LIVE |
| `skillGenerator.ts` | Prompt → TS code generation | LIVE |
| `skillValidator.ts` | `tsc --noEmit` L0 gate | LIVE |
| `benchmarkRunner.ts` | L1 judge + L2/L3 static analysis + L4 composite | LIVE |
| `benchmarkStore.ts` | Persist benchmark result rows | LIVE |
| `runStore.ts` | Persist skill-forge run rows | LIVE (DB-backed) |
| `pipeline.ts` | Orchestrator: generate → validate → fix loop → benchmark → catalog | LIVE |

**Route wiring** (`routes/archon.ts` — 5 routes):
- `/api/archon/{health, generate, run/:id, runs, debug/l1}` — all LIVE

## Backend deliverables for new domain

**New folder**: `artifacts/api-server/src/lib/stress-benchmarks/` (already created empty)

```
stress-benchmarks/
├── types.ts           TS types matching JSONL schema (23 fields verified below)
├── runStore.ts        Load/index 909-row JSONL corpus (memoized)
├── aggregate.ts       Model leaderboard, category × model matrix, failure taxonomy
└── README.md          Explains the corpus + source of truth
```

**New route file**: `artifacts/api-server/src/routes/stressBenchmarks.ts`

Endpoints (all under `/api/stress-benchmarks/`, no auth for read — public benchmark data):
```
GET  /api/stress-benchmarks/health                — basic ping + n_runs loaded
GET  /api/stress-benchmarks/summary               — top-level {n_runs, n_models, categories}
GET  /api/stress-benchmarks/models                — leaderboard (all models × pass_rate + p50/p95)
GET  /api/stress-benchmarks/categories            — per-category matrix
GET  /api/stress-benchmarks/runs?
     model=&category=&domain=&passed=&limit=      — filtered raw runs (paged, ≤200 rows/page)
GET  /api/stress-benchmarks/failure-classes       — histogram of failure_class per model
GET  /api/stress-benchmarks/gemma-callout         — dedicated Gemma-vs-baseline diff (proves the point from prior turn)
```

**Data source strategy** (v1, read-only):
- Corpus lives in `/mnt/shared-workspace/stress-runs/` on the dev sandbox
- In production, this will be a **committed snapshot** at `artifacts/api-server/corpus/stress-benchmarks/runs.jsonl`
- `runStore.ts` reads from `STRESS_BENCHMARKS_CORPUS_PATH` env var, falling back to `artifacts/api-server/corpus/stress-benchmarks/runs.jsonl`
- Memoized on first load — 909 rows × ~1KB avg = ~1MB in memory, trivial

**Data source strategy** (v2, follow-up, NOT this pass):
- Add FastAPI wrapper to `mcp-universe-benchmarks` exposing `POST /api/v1/stress/run` + SSE progress
- Wire `benchmarkClient.ts` there as the canonical FastAPI target

### JSONL schema (from live inspection)

```ts
interface StressRun {
  worker_id: string;              // "worker-0" | "worker-1" | "worker-c" | "worker-d" | "worker-e"
  category: string;               // "baseline" | "concurrency" | "adversarial" | "faults" | "ratelimit"
  perturbation_id: string;        // e.g. "baseline", "role_swap", "tool_flake"
  task: string;                   // e.g. "tasks/temporal_logic_trap_001.json"
  domain: string;                 // e.g. "governance_traps", "identity_service"
  model: string;                  // e.g. "gemini/gemma-4-31b-it"
  run_id: number;                 // 0..N per (model, task, category)
  passed: boolean;
  failure_class: string;          // "none" | "wrong_answer" | "refusal" | "timeout" | "rate_limited" | ...
  evaluator: string;              // e.g. "governance_traps.validate_temporal_logic"
  feedback: string;
  iterations: number;
  max_iterations: number;
  tool_calls: number;
  per_tool_calls: unknown[];
  finish_reason: string;
  token_usage: { prompt: number; completion: number; total: number };
  latency_seconds: number;
  latency_ms: number;
  error: string | null;
  traceback: string | null;
  response_preview: string;       // truncated response text (~200 chars)
  timestamp: string;              // ISO 8601
}
```

## Status registration

Add to `routes/status.ts` after the archon check:

```ts
// 5. Stress benchmarks corpus
try {
  const { getStressRunCount } = await import("../lib/stress-benchmarks/runStore.js");
  const n = getStressRunCount();
  checks.stress_benchmarks = {
    ok: n > 0,
    detail: `${n} runs loaded from corpus`,
  };
} catch (err: any) {
  checks.stress_benchmarks = { ok: false, detail: err.message };
}
```

## What NOT to touch (per HANDOFF §4 + Agent 1)

- `routes/forge.ts` (1185 LOC — Model Forge owner)
- `lib/kairosClient.ts` (Model Forge owner)
- `lib/jobMonitor.ts` (Model Forge owner)
- `lib/db/src/schema/` — no new tables in v1 (JSONL corpus is the source of truth)
- `routes/legal*.ts` — legal vertical, unrelated
