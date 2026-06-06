# OpenClaw MDC Architecture
## Model Development Cycle — Target Design + Live Status

> **Reality audit (2026-06-06 · repo `530be25`):** This document describes the **target** seven-stage Forge MDC. For what is **LIVE vs VISION vs FICTION** on production deploys, read **`MDC_training.md`** first — it is the operational source of truth.

| Label | Meaning |
|-------|---------|
| **LIVE** | Verified in code and/or live probe |
| **PARTIAL** | Code exists; env, DB, or stub gap |
| **VISION** | Target schema/routes; not on prod DB |
| **FICTION** | Claimed; contradicted by audit |

---

## What is the MDC? (VISION — product target)

The Model Development Cycle (MDC) is the end-to-end process by which OpenClaw takes raw data, trains or adapts a model, evaluates it honestly, governs its deployment, and exposes it as a live API endpoint. It is the backbone of the **Model Forge** product.

The MDC is not a single pipeline. It is connected stages, each with its own data model, API surface, and governance checkpoint. **Target invariant:** a model cannot skip a stage; every stage produces a durable DB record.

**Audit note:** On Render/Railway Postgres probed June 2026, **Forge tables were absent** (`training_jobs`, `model_datasets`, etc.). ZIE tables (`zie_*`, judge bridge) **are live** on both deploys — a **parallel** path not shown in the diagram below.

---

## Deployment topology (do not conflate)

| Surface | URL | DB |
|---------|-----|-----|
| Render API | `openclaw-api-k30t.onrender.com` | Render `openclaw-db` |
| Railway API | `reliable-abundance-production-aac6.up.railway.app` | Railway `zephyr` |
| Benchmark/Kairos | `openclaw-benchmark.onrender.com` | Separate / in-memory runs |

Flywheel counts, judge receipts, and Forge seed data **are not shared** across Render and Railway unless explicitly synced.

---

## The Seven Stages (target diagram)

```
Raw Data
   │
   ▼
[1] DATASET          model_datasets + dataset_documents          VISION on prod DB
   │
   ▼
[2] VERSION          dataset_versions (snapshot, immutable)      VISION
   │
   ▼
[3] TRAINING JOB     training_jobs                               VISION (code PARTIAL)
   │
   ▼
[4] EVALUATION       evaluation_runs + evaluation_metrics        PARTIAL (two paths)
   │
   ▼
[5] REGISTRATION     model_registrations + model_versions          VISION
   │
   ▼
[6] DEPLOYMENT       model_deployments                             VISION
   │
   ▼
[7] ENDPOINT         deployment_endpoints → HTTP route           PARTIAL (static routes)
```

### Parallel live path (ZIE — not in original MDC diagram)

```
Legal/SEO inference → zie_training_records + zie_preference_pairs
                   → POST /v1/judge/latest (manual) → evaluation_runs/metrics
                   → checkVerifiedThresholds (50 verified) → training_jobs → Modal (PARTIAL)
Routes: /v1/legal/clause/draft, /v1/legal/flywheel/status, /v1/judge/*
```

---

## Stage 1: Dataset — **VISION**

**Target table:** `model_datasets`, `dataset_documents`

**Key fields:** `source_type`, `sensitivity`, `status` (pending/processing/ready/error), `document_count`

**Target behavior:** Training job submit rejected until dataset `ready`.

**Live status:** Routes in `forge.ts` **PARTIAL** — fail at DB insert if tables missing. Seed references datasets that may not exist on current Render DB.

---

## Stage 2: Dataset Version — **VISION**

**Target table:** `dataset_versions` — immutable snapshot.

**Route:** `POST /forge/workspaces/:wid/datasets/:did/version`

---

## Stage 3: Training Job — **PARTIAL** (code only)

**Target table:** `training_jobs`

**Status machine (target):**
```
draft → queued → running → completed → failed
```

**Modes (target vs reality):**

| Mode | Target | Reality |
|------|--------|---------|
| `prompt_tuning` | Distinct adaptation | **FICTION** — no branch in `forge.ts` |
| `rag_adaptation` | Build retrieval index | **FICTION** — label in Kairos goal string only; no FAISS/artifact |
| `fine_tuning` | GPU weight update | **VISION** — Modal stub in `modalDispatch.ts` |

**Dispatch:** `POST .../jobs/:jid/dispatch` → `kairosClient.runWorkflow({ skill_id, goal, tenant_id })` — **PARTIAL**. Kairos service **LIVE** but probed runs fail on LLM streaming read bug.

**Governance gates (target):** dataset ready, model allowlist, concurrency — **VISION** until `training_jobs` exists.

---

## Stage 4: Evaluation — **PARTIAL** (two implementations)

**Target tables:** `evaluation_runs`, `evaluation_metrics` (one row per metric, threshold, passed)

### Forge path (`jobMonitor.ts`) — **FICTION as honest eval**

On Kairos `done`: inserts stub `overall_score=0.85`, hardcoded pass. Not a held-out test set.

### ZIE path (`judge.ts`) — **LIVE**

`POST /v1/judge/latest` — real LLM scores; atomic write to `evaluation_runs` + `evaluation_metrics` + `zie_preference_pairs.judge_run_id`. **Manual** — no overnight cron.

**Honest eval principle (target):** failing metrics visible with `passed=false`. **LIVE** for judge path; **not enforced** for Forge stub path.

---

## Stage 5: Registration and Approval — **VISION**

**Target tables:** `model_registrations`, `model_versions`, `model_approvals`

Tenant-owner approval gate, audit trail. Code in `forge.ts`; tables absent on probed prod DB.

---

## Stage 6: Deployment — **VISION**

**Target table:** `model_deployments` — `POST .../jobs/:jid/deploy` requires completed job + approved version.

---

## Stage 7: Endpoint — **PARTIAL**

**Target:** `deployment_endpoints` row per deployed model.

**Live today:** Static routes in `legal.ts`, not registered via Forge deployment records:

```
GET/POST https://openclaw-api-k30t.onrender.com/api/v1/legal/extract-clause   LIVE
POST     .../api/v1/legal/clause/draft                                        LIVE
GET      .../api/v1/legal/flywheel/status                                     LIVE
POST     .../api/v1/legal/matter                                              PARTIAL (needs OPENROUTER_API_KEY_2 on Render)
```

`/extract-clause` is **not** backed by a `deployment_endpoints` row on live DB — it is a first-class route, not an MDC-deployed artifact.

---

## Knowledge Graph / KB layer — **VISION**

**Target tables:** `knowledge_graphs`, `graph_documents`, `graph_chunks`

**Target route:** `POST /tenants/:id/graphs/:graphId/query` (BM25 via `tsv` in Drizzle schema)

**Live status (June 2026 audit):**
- Tables **not created** on Render/Railway prod DB (`runMigrations()` vs `runZieMigration()` split; FK/type mismatches)
- `POST /kb/search` — **FICTION** (route does not exist)
- No pgvector on probed Postgres
- **Not wired** to legal inference — legal “RAG” is `keywordRetrieve()` + `cofounderRetrieve()` (hardcoded snippets)

See `graphs.ts` vs `index.ts` vs Drizzle — **three-way schema divergence** (`MDC_training.md`).

---

## Governance Layer — **VISION** (Forge)

**Target table:** `model_policies` — allowlists, budgets, `deployment_requires_approval`

**Target:** `model_usage_events` append-only audit.

**Live:** ZIE vault writes usage-like data in `zie_*` tables; Forge usage events require Forge tables.

---

## Kairos Execution Engine — **PARTIAL**

**LIVE:** Service at `openclaw-benchmark.onrender.com`; `KAIROS_SERVICE_URL` in `render.yaml`.

**Target flow:**
1. `kairosClient.runWorkflow()` → `run_id`
2. `jobMonitor.ts` polls every 30s
3. On done → job complete + eval + registration

**Reality:** Steps 2–3 require `training_jobs` + working Kairos LLM layer. Kairos accepts runs but **failed** on streaming read in probes (`llm_calls_total: 0`). Job monitor is in-process alpha — **does not survive restart**.

---

## Legal Clause Extractor — endpoint LIVE, MDC registry FICTION

### What is LIVE

- **Endpoint:** `GET/POST /api/v1/legal/extract-clause` on k30t
- **Inference:** Groq/OpenRouter fallback chain in `legal.ts`
- **“RAG” when `use_rag: true`:** `keywordRetrieve()` — five keyword→snippet rules, **not** FAISS

### What is FICTION (do not cite as deployed MDC asset)

| Claim | Reality |
|-------|---------|
| FAISS IndexFlatIP + MiniLM 384-dim | No index files, no embedding pipeline |
| 30 CUAD vectors in vector store | Snippets hardcoded in TypeScript |
| Job `Legal Clause Extractor v1`, mode=`rag_adaptation`, status=`completed` | Not on probed prod DB |
| Registration/deployment rows for extract-clause | Route is static, not `deployment_endpoints` |
| Eval run with 13 metrics in registry | Benchmark history; not Forge registry truth |

### Historical benchmark (still useful, not registry truth)

| Condition | Accuracy | Macro F1 | Notes |
|-----------|----------|----------|-------|
| 1.2B zero-shot | 80% | 0.787 | Session benchmark |
| 1.2B + keyword “RAG” | 90% | 0.893 | Prompt injection, not vector retrieval |
| 20B zero-shot | 100% | 1.000 | |

**Known limitation (still valid):** 1.2B confuses `limitation_of_liability` vs `indemnification` on short spans — model capacity, not retrieval failure.

---

## Data Model Summary

### Target (Forge MDC)

```
tenants
  └── model_workspaces
        ├── model_datasets → dataset_documents → dataset_versions
        ├── training_jobs → evaluation_runs → evaluation_metrics
        │                 → model_registrations → model_versions → model_approvals
        │                                    → model_deployments → deployment_endpoints
        └── model_policies
model_usage_events
```

### Live (ZIE + platform — partial)

```
zie_training_records
zie_preference_pairs  (+ judge_* columns, judge_run_id)
evaluation_runs       (ZIE judge bridge — also used by judge.ts)
evaluation_metrics
semantic_clause_analysis_runs / semantic_clause_analyses  (Railway-heavy)
skills, skill_benchmarks, tenants (often empty)
```

---

## API Surface

### Forge routes — **PARTIAL** (code LIVE, DB VISION)

All require `requireWorkspaceMember` (Clerk JWT):

```
GET/POST /api/forge/workspaces
... datasets, jobs, dispatch, deploy, registry, policies ...
```

Full list unchanged in `forge.ts` — **will 5xx/404 on missing tables** until migrations succeed.

### Legal + ZIE routes — **LIVE** (Render k30t unless noted)

```
GET/POST /api/v1/legal/extract-clause
POST     /api/v1/legal/clause/draft      (modes: inline | from_run | generate)
GET      /api/v1/legal/flywheel/status
POST     /api/v1/legal/matter            (PARTIAL — KEY_2)
POST     /api/v1/judge/latest
POST     /api/v1/judge/pair/:pairId
GET      /api/v1/seo/flywheel/status     (Railway also)
```

### Graph/KB routes — **PARTIAL**

```
POST /api/tenants/:id/graphs/:graphId/query   — code exists; tables absent on prod
POST /kb/search                                 — FICTION
```

---

## What Makes This Different (target value prop)

1. **Measured, queryable eval** — **LIVE** for ZIE judge metrics; **VISION** for Forge registry queries across `model_versions`.
2. **Governance gates** — **VISION** for Forge approval/deploy; **PARTIAL** for ZIE (judge manual, Modal threshold not reached).

---

## Related documents

| Doc | Role |
|-----|------|
| `MDC_training.md` | Live vs vision detail, env vars, curl receipts |
| `HANDOFF_integration_agent.md` | Integration mission (§1 updated for audit) |
| `10-cofounder-specialist.mdc` | Co-founder corpus spec vs trigger-match implementation |

---

*Document version: 2.0 — 2026-06-06 (reality audit)*
*Supersedes: v1.0 (2026-05-15) which stated Forge/KB/FAISS as live*
*Repo: `openclaw-saas` @ `530be25`*
