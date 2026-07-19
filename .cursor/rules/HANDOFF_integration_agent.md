# OpenClaw — Integration Agent Handoff
**From:** Model Forge agent (Phases 1–5 complete)
**To:** Integration agent
**Date:** 2026-05-14 (§1 reality audit: 2026-06-06)
**Scope:** Wire siloed skills into composable, Kairos-orchestrated workflows.

> **⚠️ §1 was stale.** Forge/KB tables and seed data were documented as “verified live” in May 2026 but **were absent on Render/Railway Postgres** in the June 2026 audit. **`MDC_training.md`** and **`MDC_architecture.md`** are the current live-vs-vision sources. **§2–§10** below remain valid as integration **target** work.

| Label | Meaning |
|-------|---------|
| **LIVE** | Code + HTTP/DB verified |
| **PARTIAL** | Code exists; env/DB/manual gap |
| **VISION** | Not on prod DB |
| **STALE** | Was true on another DB/deploy; do not assume |

---

## 1. What Exists Today (Re-audited 2026-06-06)

### 1.1 Services

| Service | URL | Status |
|---------|-----|--------|
| Render API | https://openclaw-api-k30t.onrender.com | **LIVE** — healthz, draft, flywheel, extract-clause, judge |
| Railway API | https://reliable-abundance-production-aac6.up.railway.app | **LIVE** — ZIE judge, semantic clause, SEO flywheel; **different DB** |
| Static SPA | https://openclaw-lfky.onrender.com | **LIVE** — bundle may target **b9wb** API per `render.yaml`, not k30t |
| Benchmark/Kairos | https://openclaw-benchmark.onrender.com | **NOT DEPLOYED (2026-07 audit)** — hostname does not respond; live L1-L4 judgment now runs in-process on `openclaw-api` (`src/lib/archon/*`). `benchmarkClient.ts` reachability-probes and falls back cleanly. |
| Agent Robustness corpus | (in-repo, `artifacts/api-server/corpus/stress-benchmarks/`) | **LIVE (Sprint A)** — 909 rows served at `/api/stress-benchmarks/*`; see `.cursor/rules/11-agent-robustness.mdc` |

**Repo HEAD (audit):** `530be25` on `fjkiani/openclaw-saas` main.

**Credentials:** Use Render/Railway/Clerk dashboards — do not commit API keys or PATs to this doc.

### 1.2 Database — two Postgres instances

Migrations: `runMigrations()` + `runZieMigration()` in `index.ts`, parallel via `Promise.allSettled` — **ZIE can succeed while Forge/graph migrations fail silently**.

#### LIVE on probed DBs (Render and/or Railway)

| Table | Notes |
|-------|--------|
| `zie_training_records`, `zie_preference_pairs` | Vault for draft/generate/SEO |
| `evaluation_runs`, `evaluation_metrics` | ZIE judge bridge (`0007_judge_evaluation_bridge.sql`) |
| `semantic_clause_analysis_*` | Railway-heavy |
| `skills`, `skill_benchmarks` | Catalog |
| `manuscript_*`, `zie_router_policies`, etc. | Drizzle-migrated domains |

#### VISION on probed prod DB (code exists, tables missing)

| Table group | Notes |
|-------------|--------|
| **Model Forge** — `model_workspaces`, `model_datasets`, `dataset_documents`, `dataset_versions`, `training_jobs`, `training_job_artifacts`, `model_registrations`, `model_versions`, `model_deployments`, `deployment_endpoints`, `model_policies`, `model_approvals`, `model_usage_events` | `forge.ts` routes will fail inserts |
| **Knowledge graph** — `knowledge_graphs`, `graph_documents`, `graph_chunks` | Never created on prod; schema diverges in source |
| **Workflow integration (§3)** — `business_objects`, `workflow_*`, `platform_policies` | Not built |

#### STALE — May 2026 handoff seed claims (do not assume)

Original handoff listed demo tenant, workspace id=5, dataset id=3, queued training job — **may have existed on a different Render Postgres instance** or pre-migration DB. **Not verified** on k30t/Railway zephyr June 2026. Re-verify with SQL before integration work depends on it.

**Platform tables:** `tenants` often **0 rows** on Railway. `connectors` / `chat_messages` — verify per deploy.

### 1.3 API Routes

#### Forge router — **PARTIAL** (code LIVE, DB VISION)

`artifacts/api-server/src/routes/forge.ts` — routes listed below require Forge tables + Clerk auth:

**Forge router** (`artifacts/api-server/src/routes/forge.ts`, 1020 lines, 23 routes):

```
GET    /api/forge/workspaces
POST   /api/forge/workspaces
GET    /api/forge/workspaces/:wid
GET    /api/forge/workspaces/:wid/datasets
POST   /api/forge/workspaces/:wid/datasets
GET    /api/forge/workspaces/:wid/datasets/:did
POST   /api/forge/workspaces/:wid/datasets/:did/documents
DELETE /api/forge/workspaces/:wid/datasets/:did/documents/:docId
POST   /api/forge/workspaces/:wid/datasets/:did/version
GET    /api/forge/workspaces/:wid/jobs
POST   /api/forge/workspaces/:wid/jobs
GET    /api/forge/workspaces/:wid/jobs/:jid
POST   /api/forge/workspaces/:wid/jobs/:jid/submit
POST   /api/forge/workspaces/:wid/jobs/:jid/dispatch      ← triggers Kairos
GET    /api/forge/workspaces/:wid/jobs/:jid/events        ← SSE stream
POST   /api/forge/workspaces/:wid/jobs/:jid/cancel
GET    /api/forge/workspaces/:wid/policies
PUT    /api/forge/workspaces/:wid/policies
GET    /api/forge/workspaces/:wid/registry
POST   /api/forge/workspaces/:wid/registry/:rid/versions/:vid/approve
GET    /api/forge/workspaces/:wid/deployments
POST   /api/forge/workspaces/:wid/jobs/:jid/deploy
GET    /api/forge/workspaces/:wid/jobs/:jid/eval
```

Auth middleware: `requireWorkspaceMember` — chain: `wid → model_workspaces.tenant_id → tenants.user_id = req.auth.userId`

#### Legal + ZIE — **LIVE** (Render k30t unless noted)

```
POST /api/v1/legal/clause/draft       inline | from_run | generate
GET  /api/v1/legal/flywheel/status
POST /api/v1/judge/latest               manual — not cron
POST /api/v1/judge/pair/:pairId
GET/POST /api/v1/legal/extract-clause
POST /api/v1/legal/matter               PARTIAL — KEY_2 falls back to KEY_1 after deploy; set both for rate-limit headroom
GET  /api/v1/seo/flywheel/status        Railway + Render
```

**Other routers:** `skills.ts`, `billing.ts`, `chat.ts`, `connectors.ts`, `dashboard.ts`, `graphs.ts` (**PARTIAL** — KB tables absent), `tenants.ts`, `webhooks.ts`, `manuscript.ts`, `seo.ts`

**CounselUI:** `artifacts/mockup-sandbox/.../CounselUI.tsx` — defaults to k30t; Analyze tab blocked until `/matter` env fixed.

### 1.4 Benchmark Service (Kairos Engine) — REFERENCE ONLY

> **AUDIT NOTE (Sprint A, 2026-07):** the `openclaw-benchmark` FastAPI
> service is not currently deployed. The routes below describe the
> intended contract; consumers on `openclaw-api` reach live L1-L4
> judgment via in-process `src/lib/archon/*` instead. If/when the FastAPI
> service is spun back up, `src/lib/benchmarkClient.ts` reachability-
> probes and will start using it automatically.
> The Agent Robustness page is served independently by
> `/api/stress-benchmarks/*` from the in-repo JSONL corpus — see
> `.cursor/rules/11-agent-robustness.mdc`.

`openclaw-benchmark` was intended to run the Kairos agentic execution engine. Key routes (nominal):

```
POST /api/v1/zoa/kairos/run          — start a Kairos run, returns run_id
GET  /api/v1/zoa/kairos/run/{id}     — poll run status + result
GET  /api/v1/zoa/kairos/run/{id}/stream — SSE event stream (with replay)
GET  /api/v1/zoa/events/dashboard    — recent events (fixed CORS, commit f69e4bb)
GET  /api/v1/zoa/events/{agent_id}   — events for a specific agent
```

ZOA skill endpoints (all live, all benchmarked):
- `/zoa/billing/*` — process-invoice, chase-payment, detect-fraud, generate-invoice
- `/zoa/scheduling/*` — find-slot, book, handle-decline, pending-blocks
- `/zoa/payroll/*` — calculate, detect-anomaly, hold-commission, review-compensation
- `/zoa/hr/*` — screen-resume, performance-review, process-exit, flag-performance
- `/zoa/procurement/*` — scan-receipt, negotiate, check-inventory, auto-order
- `/zoa/compliance/*` — interpret, audit-doc, assess-risk, handle-alert

**Kairos status:** Service **LIVE**; probed runs **fail** on LLM streaming read (`llm_calls_total: 0`). Do not assume Forge dispatch completes real training until Kairos is fixed.

**Render API keys (2026-06 audit):** `OPENROUTER_API_KEY` set (draft/judge work); `OPENROUTER_API_KEY_2` **missing** (breaks `/matter`); `GROQ_API_KEY` optional (OR 120B fallback).

### 1.5 Frontend Pages

```
/                  → landing.tsx
/dashboard         → dashboard.tsx
/skills            → skills.tsx        ← THE SILO PROBLEM LIVES HERE
/zoa               → zoa.tsx
/billing           → billing.tsx
/forge             → forge/index.tsx   ← workspace list
/forge/:wid        → forge/workspace.tsx (5 tabs: Overview, Datasets, Jobs, Registry, Policy)
```

### 1.6 Kairos Client (server-side)

`artifacts/api-server/src/lib/kairosClient.ts` — typed client for the benchmark service:
- `kairosClient.runWorkflow({ skill_id, goal, tenant_id, max_turns })` → `{ run_id, phase, status }`
- `kairosClient.getRunStatus(runId)` → `{ status, violations, degraded, result, archon_reforge_ready }`
- `kairosClient.getRunStreamUrl(runId)` → SSE URL for frontend
- `kairosClient.listRuns(skillId?, tenantId?)` → paginated run list

### 1.7 Job Monitor (alpha, in-process)

`artifacts/api-server/src/lib/jobMonitor.ts` — polls Kairos every 30s for active training jobs.
**Known limitation:** in-process `setInterval`, does not survive restart or horizontal scale-out.
**Replacement target:** pg-boss or BullMQ background worker.

---

## 2. The Problem: Why Skills Are Siloed

The manager's diagnosis is correct. Here is the precise technical root cause:

### 2.1 Skills are catalog items, not workflow steps

`skills.tsx` renders each skill as an independent card with:
- "Install on agent" button → `POST /api/tenant-skills` (installs to tenant, no workflow context)
- "Benchmark" button → `POST /api/skills/:id/benchmark` (isolated benchmark, no shared rubric)
- Category tag (Finance, HR, Browser, etc.) — display only, no routing logic

There is no concept of a **workflow** that chains skills. Installing a skill does nothing except add a row to `tenant_skills`. There is no shared data object (invoice, employee, contract) that flows between skills.

### 2.2 ZOA skills are separate from the ZOA service module

The ZOA page (`zoa.tsx`) shows the 6 ZOA agents (Billing, Scheduling, Payroll, HR, Procurement, Compliance) as a coherent suite. But:
- Each ZOA agent is also a row in the `skills` catalog with its own benchmark button
- The ZOA page does not share state with the skills page
- There is no cross-agent workflow: a Billing event cannot trigger a Compliance check without manual re-invocation
- `model_usage_events` exists but is only written by the Forge job monitor — ZOA agents do not emit to it

### 2.3 No shared business objects

The database has no tables for: invoices, employees, vendors, contracts, purchase orders, compliance alerts. Each ZOA skill call is stateless — it receives a request body and returns a response. Nothing is persisted to a shared object store that other skills can read.

### 2.4 Governance is workspace-scoped, not platform-scoped

`model_policies` governs Model Forge workspaces only. There is no platform-level policy that applies to skill invocations, ZOA agent calls, or cross-skill workflows. `skill_benchmarks` records benchmark results but does not gate skill invocations.

### 2.5 Kairos is wired to Forge only

`kairosClient.runWorkflow` is called only from `POST /forge/workspaces/:wid/jobs/:jid/dispatch`. Kairos is capable of orchestrating multi-step agentic workflows but is not exposed to the skills catalog or ZOA agents.

**Audit addendum:** Forge dispatch is **VISION** on prod until `training_jobs` exists and Kairos LLM layer works. ZIE flywheel (`draftAgent`, judge, Modal threshold) is a **separate live path** — see `MDC_training.md`.

---

## 3. The Integration Architecture (What to Build)

The goal is to transform OpenClaw from "skill marketplace + Forge module" into "agentic SaaS where skills are callable steps in tenant-scoped workflows."

### 3.1 Shared Business Object Layer

Add these tables to `artifacts/api-server/src/index.ts` (idempotent migrations):

```sql
-- Shared business objects (tenant-scoped)
CREATE TABLE IF NOT EXISTS "business_objects" (
  "id"          serial PRIMARY KEY,
  "tenant_id"   text NOT NULL REFERENCES "tenants"("id"),
  "object_type" text NOT NULL,   -- 'invoice' | 'employee' | 'contract' | 'vendor' | 'alert'
  "external_id" text,            -- source system ID
  "status"      text NOT NULL DEFAULT 'active',
  "data"        jsonb NOT NULL DEFAULT '{}',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

-- Workflow definitions (reusable templates)
CREATE TABLE IF NOT EXISTS "workflow_definitions" (
  "id"          serial PRIMARY KEY,
  "tenant_id"   text NOT NULL REFERENCES "tenants"("id"),
  "name"        text NOT NULL,
  "trigger"     text NOT NULL,   -- 'manual' | 'event' | 'schedule'
  "steps"       jsonb NOT NULL,  -- ordered array of { skill_id, input_mapping, output_mapping }
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

-- Workflow runs (instances of a definition)
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id"          serial PRIMARY KEY,
  "tenant_id"   text NOT NULL REFERENCES "tenants"("id"),
  "definition_id" integer REFERENCES "workflow_definitions"("id"),
  "object_id"   integer REFERENCES "business_objects"("id"),
  "status"      text NOT NULL DEFAULT 'running',  -- running | completed | failed | paused
  "current_step" integer NOT NULL DEFAULT 0,
  "context"     jsonb NOT NULL DEFAULT '{}',      -- shared state passed between steps
  "kairos_run_id" text,
  "started_at"  timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);

-- Workflow step results
CREATE TABLE IF NOT EXISTS "workflow_step_results" (
  "id"          serial PRIMARY KEY,
  "run_id"      integer NOT NULL REFERENCES "workflow_runs"("id"),
  "step_index"  integer NOT NULL,
  "skill_id"    integer REFERENCES "skills"("id"),
  "status"      text NOT NULL,   -- completed | failed | skipped
  "input"       jsonb,
  "output"      jsonb,
  "kairos_run_id" text,
  "executed_at" timestamptz NOT NULL DEFAULT now()
);

-- Platform-level governance (applies to all skill invocations)
CREATE TABLE IF NOT EXISTS "platform_policies" (
  "id"          serial PRIMARY KEY,
  "tenant_id"   text NOT NULL REFERENCES "tenants"("id"),
  "policy_type" text NOT NULL,   -- 'skill_gate' | 'budget' | 'approval'
  "config"      jsonb NOT NULL DEFAULT '{}',
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
```

Add corresponding Drizzle schema files in `lib/db/src/schema/` and export from `index.ts`.

### 3.2 Workflow Execution Engine

Create `artifacts/api-server/src/lib/workflowEngine.ts`:

```typescript
// workflowEngine.ts — orchestrates multi-step skill workflows via Kairos
//
// Each step in a workflow definition maps to a Kairos run.
// The engine passes shared context between steps via workflow_runs.context.
// Steps can reference business object fields via JSONPath in input_mapping.
//
// Interface:
//   workflowEngine.start(definitionId, objectId, tenantId) → workflowRunId
//   workflowEngine.advance(runId) → void  (called by Kairos callback or poll)
//   workflowEngine.getStatus(runId) → WorkflowRunStatus
```

Key design decisions:
- Each step dispatches a Kairos run with `skill_id = "workflow-step-{stepIndex}"` and a structured goal built from `input_mapping` + current `context`
- On Kairos `done`, the engine writes the step result, merges `output_mapping` into `context`, and advances to the next step
- On Kairos `failed`, the engine marks the step failed and pauses the workflow run (human-in-the-loop or auto-retry per policy)
- Replace `jobMonitor.ts` in-process polling with this engine's polling (same pattern, but generalized)

### 3.3 Workflow API Routes

Add to `artifacts/api-server/src/routes/workflows.ts` (new file):

```
POST   /api/workflows/definitions          — create workflow definition
GET    /api/workflows/definitions          — list definitions for tenant
GET    /api/workflows/definitions/:id      — get definition + steps
POST   /api/workflows/runs                 — start a workflow run (triggers step 0)
GET    /api/workflows/runs                 — list runs for tenant
GET    /api/workflows/runs/:id             — get run status + step results
GET    /api/workflows/runs/:id/stream      — SSE stream (proxies Kairos SSE for current step)
POST   /api/workflows/runs/:id/resume      — resume a paused run (after human approval)
POST   /api/objects                        — create business object
GET    /api/objects                        — list objects for tenant (filterable by type)
GET    /api/objects/:id                    — get object + workflow run history
PATCH  /api/objects/:id                    — update object data/status
```

Register in `artifacts/api-server/src/index.ts` alongside existing routers.

### 3.4 Skills Page Refactor

Transform `artifacts/openclaw-saas/src/pages/skills.tsx` from a catalog into a workflow-aware surface:

**Phase A — Minimal (no new backend):**
- Add a "Workflows" tab alongside the existing skill grid
- Skills that belong to a ZOA suite (billing, scheduling, payroll, hr, procurement, compliance) get a "Part of ZOA" badge linking to `/zoa`
- Skills that are installed (`tenant_skills`) show their last benchmark grade inline (already available via `skill_benchmarks`)
- Remove the per-skill "Install on agent" button from the featured grid; replace with "Add to Workflow" that opens a workflow builder drawer

**Phase B — Full (requires workflow backend):**
- Workflow builder drawer: drag-and-drop step ordering, input/output mapping UI, trigger selection
- "Run Workflow" button on each workflow definition card → `POST /api/workflows/runs`
- Live step progress via SSE stream
- Business object selector: "Run on Invoice #1234" or "Run on Employee #567"

### 3.5 ZOA Page Integration

`artifacts/openclaw-saas/src/pages/zoa.tsx` currently shows 6 agent cards. Extend it to:

1. **Shared event feed** — `GET /api/v1/zoa/events/dashboard` is already live and CORS-fixed. Wire it to a real-time feed on the ZOA page showing cross-agent events (billing triggered compliance, etc.)
2. **Cross-agent workflow** — Add a "Run ZOA Workflow" button that dispatches a pre-built workflow definition covering the full back-office loop: invoice → payroll → compliance check
3. **Shared object context** — When a ZOA agent call succeeds, write the result to `business_objects` (e.g., a processed invoice becomes an object with `object_type='invoice'`). Other agents can then reference it

### 3.6 Platform Policy Gate

Create `artifacts/api-server/src/middleware/requirePlatformPolicy.ts`:

```typescript
// Checks platform_policies for the tenant before allowing a skill invocation.
// Enforces: budget limits, approval requirements, blocked skill categories.
// Called by: POST /api/workflows/runs, POST /api/skills/:id/benchmark (when invoked, not just benchmarked)
```

This is the missing link between `skill_benchmarks` (which records grades) and actual skill invocations (which currently ignore grades). A skill with grade `FAILED` should be blocked from workflow inclusion unless the policy explicitly allows it.

---

## 4. What the Integration Agent Must NOT Touch

The Model Forge agent owns these files. Do not modify them:

| File | Owner | Reason |
|------|-------|--------|
| `artifacts/api-server/src/routes/forge.ts` | Model Forge | 23 routes, FSM logic, Kairos dispatch |
| `artifacts/api-server/src/lib/kairosClient.ts` | Model Forge | Typed Kairos client — extend, don't replace |
| `artifacts/api-server/src/lib/jobMonitor.ts` | Model Forge | Alpha polling — replace with workflowEngine, but coordinate |
| `artifacts/openclaw-saas/src/pages/forge/` | Model Forge | Workspace list + 5-tab detail |
| `lib/db/src/schema/model*.ts` + `training*.ts` + `evaluation*.ts` + `deployment*.ts` | Model Forge | All 15 Forge schema files |
| `artifacts/api-server/src/middleware/requireWorkspaceMember.ts` | Model Forge | Workspace auth chain |

You **may** extend `kairosClient.ts` with new methods. You **may** read from Forge tables (e.g., join `training_jobs` to `workflow_runs`). You **must not** alter Forge table schemas or FSM logic.

---

## 5. Recommended Build Order

### Sprint 1 — Shared Object Layer (2–3 days)
1. Add 5 new tables to `index.ts` migrations (business_objects, workflow_definitions, workflow_runs, workflow_step_results, platform_policies)
2. Add Drizzle schema files + export from `lib/db/src/schema/index.ts`
3. Add `POST /api/objects` and `GET /api/objects` routes (no workflow logic yet)
4. Seed: create 2 sample business objects for the demo tenant (1 invoice, 1 contract)
5. Verify: `GET /api/objects` returns seeded objects with valid auth

### Sprint 2 — Workflow Engine + Routes (3–4 days)
1. Write `workflowEngine.ts` (start, advance, getStatus)
2. Write `workflows.ts` router (definitions CRUD + runs CRUD)
3. Register router in `index.ts`
4. Seed: create 1 workflow definition (3-step ZOA back-office loop: billing → compliance → hr)
5. Verify: `POST /api/workflows/runs` starts a run, Kairos dispatches step 0, step result written on completion

### Sprint 3 — Skills Page Refactor (2–3 days)
1. Add "Workflows" tab to `skills.tsx`
2. Add ZOA suite badges to ZOA-category skills
3. Replace "Install on agent" with "Add to Workflow" drawer (Phase A only — no drag-drop yet)
4. Wire benchmark grade inline display (data already available)
5. Verify: skills page shows workflow tab, ZOA skills show suite badge, benchmark grades visible

### Sprint 4 — ZOA Cross-Agent Feed (1–2 days)
1. Wire `GET /api/v1/zoa/events/dashboard` to real-time feed on ZOA page
2. Add "Run ZOA Workflow" button → `POST /api/workflows/runs` with pre-built definition
3. On ZOA agent call success, write result to `business_objects`
4. Verify: ZOA page shows live event feed, workflow run creates business object

### Sprint 5 — Platform Policy Gate (1–2 days)
1. Write `requirePlatformPolicy.ts` middleware
2. Apply to `POST /api/workflows/runs` (check budget, check skill grades)
3. Seed: create platform policy for demo tenant (block FAILED-grade skills, $1000 budget)
4. Verify: workflow run with a FAILED-grade skill returns 403 with policy reason

---

## 6. Key Invariants to Preserve

1. **Seed is idempotent** — all INSERTs must use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`. The seed runs on every deploy.
2. **Migrations are additive** — never `DROP TABLE` or `ALTER COLUMN` in a way that removes data. Add columns with `DEFAULT` values.
3. **Auth chain** — all tenant-scoped routes must verify `tenants.user_id = req.auth.userId` (Clerk JWT). Do not bypass this.
4. **Kairos is the execution layer** — do not call ZOA skill endpoints directly from the workflow engine. Route all agentic execution through `kairosClient.runWorkflow`. This ensures governance, benchmarking, and SSE streaming work uniformly.
5. **CORS** — `openclaw-benchmark` allows `https://openclaw-saas.onrender.com`. Do not add new origins without updating the CORS config in `mcp-universe-benchmarks/backend/main.py`.
6. **TypeScript strict** — `tsc --noEmit` must pass before every commit. The `parseInt(req.params.X as string)` pattern is established — follow it.
7. **Column audit before push** — run the column audit script (see below) before every seed change to prevent deploy crashes.

---

## 7. Column Audit Script

Run this before any seed change to catch INSERT/migration mismatches:

```python
import re

with open("artifacts/api-server/src/index.ts") as f:
    migration_src = f.read()

with open("artifacts/api-server/src/seed.ts") as f:
    seed_src = f.read()

# Parse CREATE TABLE blocks
table_cols = {}
for m in re.finditer(r'CREATE TABLE IF NOT EXISTS "(\w+)"\s*\(([^;]+?)\);', migration_src, re.DOTALL):
    table = m.group(1)
    body = m.group(2)
    cols = [c.strip().strip('"').split('"')[0].strip() for c in body.split('\n') if c.strip() and not c.strip().startswith('--')]
    col_names = [c.split()[0].strip('"') for c in cols if c and not c.upper().startswith(('PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT'))]
    table_cols[table] = set(col_names)

# Parse INSERT statements in seed
for m in re.finditer(r'INSERT INTO "?(\w+)"?\s*\(([^)]+)\)', seed_src):
    table = m.group(1)
    cols = [c.strip().strip('"') for c in m.group(2).split(',')]
    if table in table_cols:
        bad = [c for c in cols if c not in table_cols[table]]
        if bad:
            print(f"MISMATCH {table}: seed inserts {bad} but migration has {sorted(table_cols[table])}")
        else:
            print(f"OK {table}")
    else:
        print(f"UNKNOWN TABLE {table}")
```

---

## 8. Environment Variables

| Variable | Service | Status (2026-06 audit) |
|----------|---------|------------------------|
| `DATABASE_URL` | Render `openclaw-api` | Set — Render Postgres (**not** Railway zephyr) |
| `DATABASE_URL` | Railway API | Set — separate instance |
| `CLERK_SECRET_KEY` | API servers | Set (verify per deploy) |
| `KAIROS_SERVICE_URL` | Render API | Set → `openclaw-benchmark.onrender.com` |
| `OPENROUTER_API_KEY` | Render API | Set — draft, judge fallback |
| `OPENROUTER_API_KEY_2` | Render API | Optional — falls back to KEY_1 via `resolveApiKey()` |
| `GROQ_API_KEY` | Render API | Optional — falls back to OR 120B |
| `VITE_API_URL` / `VITE_API_BASE` | Static / mockup | Often **b9wb** or **k30t** — check `render.yaml` / CounselUI |
| `VITE_CLERK_PUBLISHABLE_KEY` | Frontend | Clerk dashboard |

Never paste secret values into repo docs. Rotate any keys previously committed in older handoff versions.

---

## 9. Git Workflow

```bash
git clone https://github.com/fjkiani/openclaw-saas
cd openclaw-saas
# Use gh auth or SSH — do not embed PATs in docs or scripts committed to repo
git push origin main
```

Render auto-deploys on push to `main` for configured services. Monitor via Render dashboard or `gh`/Render API with credentials from env — not from this file.

---

## 10. Summary: The One-Sentence Mission

**Turn the skill catalog from a list of installable plugins into a set of callable steps in tenant-scoped, Kairos-orchestrated workflows that share business objects, emit to a unified event feed, and are gated by platform-level governance policies.**

The **target** pattern is Forge MDC (training → eval → registry → deployment). **As of June 2026 audit**, the **live** partial example is the **ZIE flywheel** (inference → vault → manual judge → Modal threshold) — not the seven-stage Forge registry. The integration agent generalizes workflow orchestration to all skills **and** must not assume Forge tables exist until migrations are proven on the canonical DB.
