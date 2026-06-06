# OpenClaw — Model Training: Reality vs Vision

**Purpose:** Single source of truth for what training/flywheel infrastructure **actually runs today** vs what the MDC docs **describe as target architecture**. Written for engineers wiring legal counsel, ZIE, or Forge — not as marketing copy.

**Last audited:** 2026-06-06 · **Repo HEAD:** `530be25` (`openclaw-saas` main)

**Cross-references:**
- Architecture (7-stage MDC target): `MDC_architecture.md`
- Integration handoff (§1 re-audited 2026-06-06): `HANDOFF_integration_agent.md`
- Co-founder specialist spec vs implementation: `10-cofounder-specialist.mdc`

---

## How to read this document

| Label | Meaning |
|-------|---------|
| **LIVE** | Verified in source and/or live HTTP/DB probe on named deploy |
| **PARTIAL** | Code exists; broken env, wrong DB, stub path, or manual step required |
| **VISION** | Specified in MDC/handoff; tables, routes, or behavior not present on production DB |
| **FICTION** | Claimed in seed/comments/MDC; contradicted by code or live probes |

---

## Deployment topology (do not conflate)

Three surfaces, **two Postgres instances**. Flywheel counts on one are invisible on the other.

| Surface | URL | DB | Role |
|---------|-----|-----|------|
| Render API | `https://openclaw-api-k30t.onrender.com` | Render `openclaw-db` | Legal draft/flywheel, `extract-clause`, CounselUI default |
| Railway API | `https://reliable-abundance-production-aac6.up.railway.app` | Railway `zephyr` | ZIE judge, semantic clause, SEO flywheel |
| Static UI | `https://openclaw-lfky.onrender.com` | — | SPA; bundle may point at **b9wb** per `render.yaml`, not k30t |

`render.yaml` sets `KAIROS_SERVICE_URL` → `openclaw-benchmark.onrender.com`. Railway env for Kairos: **unknown**.

---

## LIVE today — ZIE flywheel (legal drafting path)

This is the path that actually accumulated training data in June 2026 audits. It is **not** the 7-stage Forge MDC; it is a parallel vault + judge + (planned) Modal loop.

### Endpoints (Render k30t — verified)

```
GET  /api/v1/legal/flywheel/status     LIVE — counts from zie_* tables
POST /api/v1/legal/clause/draft        LIVE — three modes (see below)
POST /api/v1/judge/latest              LIVE on Render — manual, not cron
POST /api/v1/judge/pair/:pairId        LIVE
GET  /api/v1/legal/extract-clause      LIVE — clause classification (see RAG §)
POST /api/v1/legal/matter              PARTIAL — route exists; fails without OPENROUTER_API_KEY_2
```

### `POST /api/v1/legal/clause/draft` modes

| Mode | Body | Status |
|------|------|--------|
| `inline` | `clause_id`, `original_text`, `risk_level`, … | **LIVE** — `draftAgent.ts` → OpenRouter/Groq |
| `from_run` | `run_id`, `clause_id` | **LIVE** — reads `semantic_clause_analyses` (Railway DB has runs; Render may differ) |
| `generate` | `mode:"generate"`, `clause_type`, `context`, `instructions` | **LIVE** since `530be25` — full agreement text |

**Common mistake (FICTION in agent runbooks):** `{ "clause_type", "context", "instructions" }` **without** `"mode":"generate"` → **400 Invalid request**.

### Vault writes (`draftAgent.ts`)

On each successful draft/generate call, **async** `setImmediate` inserts:

- `zie_training_records` — `domain=legal`, `task_type=legal_clause_draft` or `legal_agreement_generate`
- `zie_preference_pairs` — chosen=improved text, rejected=original (or empty for generate)

**FICTION:** Response field `vault_written: true` is **hardcoded** in `legal.clause.draft.ts` before the async insert completes. It is not a DB receipt. Confirm with SQL or flywheel count delta.

### Judge + training trigger

| Step | Status |
|------|--------|
| LLM judge scores pair | **LIVE** — `POST /api/v1/judge/latest` (manual) |
| `judge_verified`, `judge_run_id` on pair | **LIVE** — atomic tx with `evaluation_runs` + `evaluation_metrics` |
| Auto-judge overnight | **VISION** — no cron/hook from draft |
| `checkVerifiedThresholds()` at 50 verified | **PARTIAL** — code in `modalDispatch.ts`; requires `training_jobs` table + verified pairs |
| Modal LoRA actually runs | **PARTIAL** — `dispatchTraining()` needs Modal SDK + env; `DRY_RUN` stub path exists |
| pg-boss hourly scheduler | **PARTIAL** — `forgeScheduler.ts`; needs `DATABASE_URL` |

**Live flywheel snapshot (Render k30t, 2026-06-06):** `legal_agreement_generate` total_pairs ≈28, **verified_pairs = 0**. Modal threshold never met.

### CounselUI (`CounselUI.tsx` — mockup-sandbox)

| Claim | Reality |
|-------|---------|
| API base k30t, no Railway URL | **LIVE** in code |
| Analyze → `/matter` → clause cards | **PARTIAL** — UI wired; **matter fails** on Render (`OPENROUTER_API_KEY_2` missing) |
| Draft → `/clause/draft` inline/from_run | **LIVE** when analyze succeeded or inline payload provided |
| History flywheel bar | **LIVE** — calls `/legal/flywheel/status` |
| Deployed product UI | **VISION** — mockup-sandbox; not the lfky production bundle unless explicitly built/deployed |

---

## LIVE today — Legal clause classification (`extract-clause`)

The only “RAG” path that ships in production inference:

### What it actually does

**FICTION:** FAISS IndexFlatIP, `all-MiniLM-L6-v2`, 30 CUAD vectors, persisted index files.

**LIVE:** `keywordRetrieve()` in `legal.ts` — five `String.prototype.includes()` blocks return **hardcoded CUAD-style snippets** (governing_law, termination, ip_assignment, limitation_of_liability, indemnification). Injected into the LLM prompt when `use_rag: true`.

Co-founder path: `cofounderRetrieve()` in `cofounderCorpus.ts` — trigger-word match over **10 in-memory** `CorpusEntry` objects (see `10-cofounder-specialist.mdc`). Same pattern: not a vector DB.

### Endpoint

```
GET  https://openclaw-api-k30t.onrender.com/api/v1/legal/extract-clause
POST https://openclaw-api-k30t.onrender.com/api/v1/legal/extract-clause
     Body: { "text": "...", "use_rag": true }
```

Model fallback chain (Groq / OpenRouter) is **LIVE**. Lineage fields in response are **LIVE** but describe prompt injection, not FAISS retrieval.

### Eval numbers in older MDC text

The 6-condition accuracy table (1.2B 80%→90% with RAG, 20B/120B at 100%) reflects **benchmark sessions**, not rows in `evaluation_metrics` tied to a deployed Forge job on Render. Treat as **historical experiment**, not live registry truth.

---

## VISION — Seven-stage Model Development Cycle (Forge)

`MDC_architecture.md` and the sections below describe the **target** Forge product. On Render/Railway production DBs audited June 2026, **Forge tables were absent or unused**:

`model_workspaces`, `model_datasets`, `dataset_documents`, `dataset_versions`, `training_jobs`, `training_job_artifacts`, `model_registrations`, `model_versions`, `model_deployments`, `deployment_endpoints`, `model_policies`

Code exists in `forge.ts`, `jobMonitor.ts`, `kairosClient.ts`; migrations live in `index.ts` `runMigrations()` and may **fail silently** (parallel with `runZieMigration()` via `Promise.allSettled`).

### Stage 1: Dataset — **VISION** on prod DB

Operator uploads documents → `model_datasets` + `dataset_documents`. Submit blocked until `status=ready`.

### Stage 2: Dataset version — **VISION**

Immutable snapshot → `dataset_versions`. Route: `POST /forge/workspaces/:wid/datasets/:did/version`.

### Stage 3: Training job — **PARTIAL** (code only)

| Mode | Vision | Reality |
|------|--------|---------|
| `prompt_tuning` | Distinct pipeline | **FICTION** — no mode branch in `forge.ts` |
| `rag_adaptation` | Builds retrieval index | **FICTION** — mode string in natural-language Kairos `goal` only; no FAISS, no artifact |
| `fine_tuning` | GPU weight update | **VISION** — Modal path stubbed |

Dispatch: `kairosClient.runWorkflow({ skill_id, goal, tenant_id })` — no structured `mode` field.

### Stage 4: Evaluation — **PARTIAL**

**Forge path (`jobMonitor.ts`):** On Kairos `done`, inserts **stub** `evaluation_metrics` (`overall_score=0.85`, hardcoded). **FICTION** as honest measured eval.

**ZIE path (`judge.ts`):** **LIVE** — real LLM judge scores, per-metric rows, `eval_run_id` bridge (migration `0007_judge_evaluation_bridge.sql`).

### Stages 5–7: Registration, deployment, endpoint — **VISION** on prod

Human approval → `model_approvals` → deploy → `deployment_endpoints`. The legal product endpoint `/extract-clause` was **not** created through this registry on live DB; it is a static route in `legal.ts`.

---

## VISION — Kairos execution engine

| Claim | Reality |
|-------|---------|
| Kairos at `openclaw-benchmark.onrender.com` | **LIVE** — accepts `POST /api/v1/zoa/kairos/run` |
| Runs complete LLM work | **PARTIAL** — probed runs **fail** with streaming read bug; `llm_calls_total: 0` |
| Wired to Forge dispatch | **PARTIAL** — code path exists; needs `KAIROS_SERVICE_URL` + `training_jobs` |
| Co-located with benchmark | **LIVE** per OpenAPI / `render.yaml` |

`jobMonitor.ts`: in-process 30s polling; **does not survive restart** (documented alpha limitation).

---

## VISION — Knowledge base / real RAG corpus

**No production KB service.**

| Asset | Status |
|-------|--------|
| `knowledge_graphs`, `graph_documents`, `graph_chunks` | **VISION** on Railway/Render prod — tables not created |
| `POST /kb/search` | **FICTION** — route does not exist |
| `graphs.ts` BM25 query | **PARTIAL** — code exists; schema diverges (`index.ts` vs Drizzle); not wired to legal routes |
| pgvector | **Not installed** on probed Postgres |
| Delaware code / CourtListener / NVCA / CUAD ingestion | **VISION** — no pipeline, schedule, or source-of-truth decision |
| `agent_b.py` multi-lens scorer | **FICTION in repo** — external sandbox script; 3 “RAG” docs are hardcoded strings |

**Source corpus today (actual):**
1. Five keyword snippets — `legal.ts` `keywordRetrieve()`
2. Ten cofounder entries — `cofounderCorpus.ts`
3. LLM pretraining + system prompts — draft/generate/judge
4. Ephemeral test payloads — `zie_preference_pairs` on Render (not curated legal corpus)

See `10-cofounder-specialist.mdc` for **spec** of 10 clause types; retrieval is trigger-match, not embedding search.

---

## Co-founder specialist (`10-cofounder-specialist.mdc`) — spec vs live

| MDC spec | Live status |
|----------|-------------|
| `cofounderCorpus.ts` 10 entries | **LIVE** — in-memory |
| `cofounderRetrieve()` | **LIVE** — keyword triggers, top-3 |
| Matter type `cofounder` / `cofounderAnalyze()` | **PARTIAL** — verify in `legal.ts`; `/matter` blocked on Render without KEY_2 |
| `MatterTab.tsx` in forge workspace | **VISION** — spec points at `openclaw-saas`; shipped mockup is `CounselUI.tsx` in mockup-sandbox |
| Governance triggers in `governanceEngine.ts` | **PARTIAL** — verify per trigger; not same as ZIE judge path |
| “RAG only, no fine-tuning” | **LIVE** for inference; **VISION** for flywheel fine-tune at 50 verified pairs |

---

## Required env vars (legal path)

| Variable | Needed for | Render k30t (audited) |
|----------|------------|------------------------|
| `OPENROUTER_API_KEY` | draft, judge fallback, generate | Set (draft works) |
| `OPENROUTER_API_KEY_2` | `/matter`, semantic analyzer chain | **Missing** — analyze broken |
| `GROQ_API_KEY` | primary draft/judge | Optional — falls back to OR 120B |
| `DATABASE_URL` | vault, flywheel, judge | Set (Render Postgres) |
| `KAIROS_SERVICE_URL` | Forge dispatch | Set in `render.yaml` |

---

## What to build next (decision gates — not a sprint plan)

1. **Canonical deploy + DB** — one API + one Postgres for legal flywheel, or explicit sync story.
2. **Set `OPENROUTER_API_KEY_2`** on Render — unblocks `/matter` and CounselUI Analyze tab.
3. **Forge migrations** — make `training_jobs` et al. actually exist before claiming MDC stages 1–7.
4. **Fix Kairos streaming bug** — or bypass Kairos for Forge until fixed.
5. **Source corpus decision** — CUAD vs Delaware vs CourtListener vs NVCA; until chosen, no ingestion architecture.
6. **Replace `vault_written` fiction** — return write receipt (pair id) or fail closed.
7. **Judge automation** — cron/webhook if “overnight scoring” is a product requirement.

---

## Appendix A — Target MDC (vision reference)

The following is the **product vision** from MDC v2.0. Stages are design intent; see §VISION above for prod status.

### Core idea

Operators build models on their data → evaluate → govern → deploy as API endpoints. Every stage writes durable DB records.

### Stage summaries (vision)

1. **Dataset** — `model_datasets`, `dataset_documents`; status machine pending→ready.
2. **Version** — immutable `dataset_versions` snapshot.
3. **Training job** — `training_jobs`; modes prompt_tuning | rag_adaptation | fine_tuning; FSM draft→completed.
4. **Evaluation** — `evaluation_runs` + one row per `evaluation_metrics`; honest pass/fail per metric.
5. **Registration** — `model_registrations`, `model_versions` candidate→approved, `model_approvals` audit.
6. **Deployment** — `model_deployments` pending→active.
7. **Endpoint** — `deployment_endpoints`; lineage in every inference response.

### Governance (vision)

`model_policies` per tenant; `model_usage_events` append-only.

### Data model (vision)

```
tenants → model_workspaces → model_datasets → dataset_versions
                          → training_jobs → evaluation_runs → evaluation_metrics
                                         → model_registrations → model_versions → model_deployments → deployment_endpoints
                          → model_policies
model_usage_events
```

### Parallel live model (ZIE — not in original MDC diagram)

```
Inference (draft/matter/seo) → zie_training_records
                            → zie_preference_pairs → judge → evaluation_runs/metrics
                            → checkVerifiedThresholds (50 verified) → training_jobs → Modal (planned)
                            → zie_router_policies (post-train routing)
```

---

## Appendix B — Historical eval narrative (Legal Clause Extractor v1)

**Task:** 5-way clause classification (governing_law, termination, ip_assignment, limitation_of_liability, indemnification).

**Data (claimed):** CUAD v1, 50 examples, 30/10/10 split. **Index (claimed):** FAISS + MiniLM 384-dim. **Actual inference:** keyword snippets + LLM (see §LIVE extract-clause).

**Reported lift (1.2B):** 80% → 90% accuracy with “RAG” in benchmark runs. **Caveat:** “RAG” was prompt injection from keyword retrieval, not vector search; strong models saturated at 100% without retrieval.

**Known limitation (still valid):** 1.2B confuses limitation_of_liability vs indemnification on short spans — capacity floor, not retrieval failure.

---

## Appendix C — Live endpoint quick reference

```bash
# Flywheel (Render)
curl -s "https://openclaw-api-k30t.onrender.com/api/v1/legal/flywheel/status" \
  -H "Authorization: Bearer test"

# Draft inline
curl -s -X POST "https://openclaw-api-k30t.onrender.com/api/v1/legal/clause/draft" \
  -H "Content-Type: application/json" \
  -d '{"mode":"inline","clause_id":"vesting","clause_label":"Vesting",...}'

# Draft generate (full agreement)
curl -s -X POST "https://openclaw-api-k30t.onrender.com/api/v1/legal/clause/draft" \
  -H "Content-Type: application/json" \
  -d '{"mode":"generate","clause_type":"co_founder_agreement","context":{},"instructions":"..."}'

# Classify clause
curl -s -X POST "https://openclaw-api-k30t.onrender.com/api/v1/legal/extract-clause" \
  -H "Content-Type: application/json" \
  -d '{"text":"...","use_rag":true}'

# Judge (manual)
curl -s -X POST "https://openclaw-api-k30t.onrender.com/api/v1/judge/latest" \
  -H "Authorization: Bearer test"
```

---

*Document version: 3.0 — 2026-06-06 (reality audit)*
*Supersedes: v2.0 (2026-05-15) which described Forge/FAISS as deployed fact*
*Repo: `openclaw-saas` @ `530be25`*
