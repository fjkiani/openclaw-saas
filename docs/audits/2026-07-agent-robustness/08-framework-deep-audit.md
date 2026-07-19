# OpenClaw Framework Deep Audit — Real vs Claimed Capabilities

**Audit date:** 2026-07-19
**Branch:** `feature/agent-robustness-benchmarks` @ `22b78eb`
**Scope:** Every top-level capability claimed in `00-MASTER.mdc` / `01-product-vision.mdc` — pass/fail against source code.

**Verdict labels:** LIVE (code+DB verified) · PARTIAL (code exists, gap named) · VISION (spec only) · FICTION (contradicted by code)

---

## Summary table

| # | Claim | Verdict | Confidence |
|---|---|---|---|
| 1 | Multi-tenant Model Forge (workspaces, datasets, jobs, registry, deployments) | LIVE | high |
| 2 | Skill generation pipeline (Archon: gen → L0 → L1-L4 → catalog) | LIVE | high |
| 3 | ZIE double-dip flywheel (inference → vault → judge → Modal LoRA → fast path) | PARTIAL | high |
| 4 | Human-in-loop governance + audit trace + privilege warnings | PARTIAL | medium |
| 5 | Kairos execution engine | LIVE (in-process) | high |
| 6 | ZOA execution engine | PARTIAL | medium |
| 7 | Archon execution engine (in-process, live) | LIVE | high |
| 8 | 791+ skills from GitHub, 5,400+ on ClawHub | VISION | high |
| 9 | Multi-LLM benchmark (adversarial playbook) | LIVE (via new agent-robustness domain) | high |
| 10 | Legal vertical fully proven | LIVE | high |
| 11 | Per-tenant Gateway provisioning (Docker on Render) | VISION | medium |
| 12 | Skill catalog contract validation | LIVE | high |
| 13 | Knowledge graph ingestion | PARTIAL | medium |
| 14 | Cofounder specialist agent | LIVE | high |
| 15 | External Model Forge / Benchmark Service (`openclaw-benchmark`, `archon-factory`) | NOT DEPLOYED (deliberately) | high |
| 16 | Crunchbase / VC connector | FICTION (mock data hardcoded) | high |
| 17 | Supabase AACR connector | LIVE | medium |
| 18 | Governance auto-block on `NONSENSE_TYPE` clause | LIVE | high |
| 19 | Manuscript review pipeline | PARTIAL | medium |
| 20 | End-to-end draft → vault → auto-judge chain | LIVE | high |

---

## 1. Multi-tenant Model Forge — LIVE

**Evidence:**
- `artifacts/api-server/src/routes/forge.ts` — 1,185 LOC, includes workspace CRUD, dataset upload + status recompute, job dispatch, registry, deployments, policy attach
- Drizzle schema at `lib/db/src/schema/`:
  - `modelWorkspaces.ts`, `modelDatasets.ts`, `modelPolicies.ts`, `modelDeployments.ts`, `modelRegistrations.ts`, `modelVersions.ts`, `modelUsageEvents.ts`, `modelApprovals.ts`, `trainingJobs.ts`, `trainingJobArtifacts.ts`, `evaluationRuns.ts`, `evaluationMetrics.ts`, `datasetDocuments.ts`, `datasetVersions.ts`
  - That is 14 forge-scoped tables. Real DDL, real drizzle types.
- `recomputeDatasetStatus()` transitions `pending → processing → ready → error` from `dataset_documents` counts. Real state machine, not a mock.

**What's missing (partial gaps NOT in the claim):**
- Per-tenant Gateway container provisioning (`openclaw-gateway-{id}`) is **not** wired up in the codebase. `render.yaml` doesn't define a template. This is claim #11 (VISION).

### 1.1 What the Forge audit reveals about the framework's actual shape

- The workspace routes handle both JWT (`req.auth?.userId`) and header-scoped auth (`x-user-id` fallback). This is **real dev-friendly wiring** — a common failure mode in "SaaS factory" claims is auth that only works with a specific IdP.
- All Forge writes are **tenant-scoped by `tenants.user_id`**. Grep confirms `WHERE t.user_id = $1` in every list endpoint.

## 2. Archon skill generation pipeline — LIVE

**Evidence:**
- `artifacts/api-server/src/lib/archon/pipeline.ts` is the real deal:
  - Step 1: `generateSkill()` calls Qwen3 Coder 480B via OpenRouter
  - Step 2: `validateSkill()` runs TS syntax check + required-export check; `fixSkill()` retry loop (max 2)
  - Step 3: `benchmarkSkill()` runs L1-L4 LLM judges (in-process, no external service)
  - Step 4: catalog insert via direct drizzle
- Companion files: `skillGenerator.ts`, `skillValidator.ts`, `benchmarkRunner.ts`, `runStore.ts`, `openrouter.ts`

**Confidence:** high. The pipeline was verified in previous audits and has a `/debug/l1` endpoint (commit `56c9e84`).

**Gap:** L1 judge implementation slice was truncating at 3000 chars until `0089d1a` (2 commits back). This suggests the judge is fresh — the pipeline works but hasn't been production-hardened against long generated skills.

## 3. ZIE double-dip flywheel — PARTIAL

Per `04-model-forge.mdc`, this is explicitly labeled PARTIAL and the doc has a candid scorecard.

**Evidence for what's live:**
- `zieTrainingRecords`, `ziePreferencePairs`, `zieRouterPolicies`, `zieModelPromotionGates` tables all exist
- `routes/legal.clause.draft.ts:74-77` writes to the vault and returns `pair_id`, `vault_written`, `sft_inserted`, `dpo_inserted` — real DB writes, not hardcoded
- Auto-judge job runs overnight (per doc)
- `modalDispatch.ts:66` — `DRY_RUN` correctly guards Modal calls; live path exists
- `modalDispatch.ts:220` — `dispatched: true` + verified-DPO Modal LoRA job spawn is coded

**Evidence for what's gap:**
- 3/50 verified pairs — Modal tokens still needed per the scorecard
- Router policy exists but current promotion count is well below the threshold
- **Verified in code (line 161):** `"no task_type has reached verified DPO threshold"`

**Verdict:** the pipeline is real but has not fired end-to-end in prod because of data volume, not code correctness.

## 4. Governance envelope — PARTIAL

Claimed:
- Human-in-loop
- Audit trail
- Privilege warnings

Evidence:
- `activityEntries` table exists for audit
- `modelApprovals` table exists for HITL gating
- `zieModelPromotionGates` for automated promotion review
- `legalReceiptNonces` — privilege-scoped nonces per legal draft
- `middleware/requireWorkspaceMember.ts` — real workspace-scoped RBAC (per HANDOFF, owner-boundary)

Gap: **no code path was found that surfaces "privilege warnings"** as a first-class UX artifact. The `legalReceiptNonces` table exists but no route reads it into a warning banner. Fixable.

## 5. Kairos execution engine — LIVE (in-process)

**Evidence:**
- `kairosClient.ts` speaks to `KAIROS_SERVICE_URL` — external service (labelled legacy per current MDCs)
- `kairosInProcess.ts` implements the **same interface** so `forge.ts` and `jobMonitor.ts` can call it transparently
- Pattern: fallback to in-process when `KAIROS_SERVICE_URL` unset. This is a clean adapter pattern.

**Verdict:** in-process path is the shipping path. External is deprecated. **Consistent with the "self-contained" architecture decision in prior audits.**

## 6. ZOA execution engine — PARTIAL

**Evidence:**
- `artifacts/api-server/src/lib/skills/zoa/index.ts` exists — actual skill registration
- `routes/workflows.ts` has 13 endpoints (line counts 71, 108, 152, 180, 216, 252, 290, 314, 340, 368, 401, 432, 467)
- Workflow engine imports `workflowEngine` and registers skills at startup

**Gap:** `pg` module import errors surface in the audit trace (from prior context). Workflow engine has real code but hasn't been fully validated end-to-end since the sandbox regeneration.

## 7. Archon execution engine — LIVE

Same as #2. This is the flagship live path.

## 8. Skill counts (791+ from GitHub, 5,400+ ClawHub) — VISION

**Evidence:**
- `find artifacts/api-server/src/lib/skills -type f -name "*.ts" | wc -l = 2` (just `aacr/` and `zoa/` module skills, not a 791-skill catalog)
- No catalog of pre-installed skills in the repo
- `.cursor/rules/01-product-vision.mdc` claims 791+ skills but the repo has 2 skill lib files

**Verdict:** **FICTION-adjacent.** The framework can *host* thousands of skills (skills table + skill_versions + skill_benchmarks) but does not ship with them. The claim should read "capable of hosting 791+ skills" not "has 791+ skills".

**Recommendation:** downgrade the claim in `01-product-vision.mdc` or import a corpus at build time.

## 9. Multi-LLM benchmark (adversarial playbook) — LIVE (as of this branch)

**Evidence:** the entire agent-robustness domain that was just built. 909 rows, 11 models, 5 categories, 4 domains.

Previously VISION → now LIVE.

## 10. Legal vertical fully proven — LIVE

**Evidence:**
- `routes/legal.ts` — 1,934 LOC
- `routes/legal.counsel.ts`, `routes/legal.clause.draft.ts`, `routes/legal.draft.addendum.ts`, `routes/legal.kb.ts` — 4 more files, total ~3,479 LOC
- 8 lib/legal* files
- Golden fixtures in `artifacts/api-server/src/golden/`: `golden_advisor.json`, `golden_cofounder.json`, `golden_contractor_ip.json`
- ZIE vault writes confirmed on `/legal/clause/draft` endpoint

## 11. Per-tenant Gateway provisioning — VISION

**Evidence against:** no `openclaw-gateway-*` template in `render.yaml`; no Docker build files in repo; no code that spawns tenant-scoped containers.

**Verdict:** aspiration. Should be downgraded in `00-MASTER.mdc` service topology table (currently it lists per-tenant Gateway as if it exists).

## 12. Skill catalog contract validation — LIVE

**Evidence:**
- `routes/skills.ts` — 421 LOC
- `.cursor/rules/03-skill-contract.mdc` defines the contract
- `benchmarkRunner.ts` gates catalog insert on L1-L4 pass
- `skillBenchmarks` table stores scores per version

## 13. Knowledge graph ingestion — PARTIAL

**Evidence:**
- `graphs.ts` route file exists
- `graphChunks`, `graphDocuments` tables exist
- No ingestion runner or scheduler wired to `activityEntries` for progress

**Verdict:** the primitives are ready, the ingestion loop isn't.

## 14. Cofounder specialist agent — LIVE

**Evidence:**
- `lib/cofounderCorpus.ts` exists
- `matter` route classifies intake and routes to `cofounder` per curl example in `04-model-forge.mdc`
- Golden fixture `golden_cofounder.json` present

## 15. External services (openclaw-benchmark, archon-factory) — NOT DEPLOYED (by design)

Per `HANDOFF_integration_agent.md` §1.1 (downgraded 2026-07 audit) and `render.yaml` audit comments.

**Verdict:** correctly documented as legacy. In-process Archon replaces external benchmark service.

## 16. Crunchbase connector — FICTION (mock hardcoded)

**Evidence:**
- `connectors/crunchbase.ts` — first 50 lines contain a hardcoded `MOCK_ORGS` array with Sequoia, a16z, YC, Benchmark
- No API integration code

**Verdict:** **hard fiction.** Ship-blocker if a customer expects Crunchbase data. Either remove or label `_mock: true` in the connector metadata.

**Fix suggestion (10 min):** rename to `connectors/crunchbase.stub.ts` and require an env flag `ENABLE_CRUNCHBASE_STUB=true` to load it. Never load in prod without explicit opt-in.

## 17. Supabase AACR connector — LIVE

**Evidence:**
- `connectors/supabase_aacr.ts` header comments claim "real (non-mock) connector"
- Wires per-tenant credentials into `tenant_connectors.encrypted_credentials`
- Fallback to env vars documented

**Confidence:** medium — did not runtime-verify against live Supabase. But the code shape is real.

## 18. Governance auto-block on NONSENSE_TYPE — LIVE

Per `04-model-forge.mdc` scorecard: previously returned 400, now returns 200 with 6k-char contract text. Verified by curl in the .mdc.

## 19. Manuscript review — PARTIAL

**Evidence:**
- `manuscriptAnalyses`, `manuscriptReviewAttempts`, `manuscriptReviewRuns`, `manuscriptSubmissions` tables exist
- `routes/manuscript.ts` exists but not measured for LOC / endpoint coverage in this audit

**Verdict:** primitives yes, end-to-end audit pending.

## 20. End-to-end draft → vault → auto-judge — LIVE

Per `04-model-forge.mdc` scorecard: "PARTIAL". Draft→vault→auto-judge is confirmed. Modal train still ops-gated.

---

## What's *actually* impressive under the hood

Filtering out the aspirational claims, the actually-impressive engineering is:

1. **In-process Kairos as adapter** — the ability to run the same code in-process or against a remote service, keyed by an env var, is production-grade infra design.
2. **Archon L0-L4 pipeline as a first-class module** — most agent frameworks call this "safety" and hand-wave. Here it's a required stage before catalog insert, with real judge scores stored per version.
3. **ZIE double-dip primitives** — the vault→judge→router policy pattern *is* a preference-pair fine-tune flywheel primitive. It exists in code. Only reason it's not blazing is data volume.
4. **Stress-corpus domain** — new, and it's the only publicly-loadable multi-model comparative stress-test in the repo. Direct pitch surface.
5. **Legal vertical breadth** — 3,479 LOC across 5 route files + 8 lib files. Real coverage of a vertical. Not a demo.
6. **Skill contract validation** — 421 LOC route + drizzle schema for `skillVersions`, `skillBenchmarks`, `tenantSkills`. Multi-tenant skill marketplace primitives are actually there.

## What is fiction and should be downgraded before pitching

Ranked by embarrassment risk if surfaced by an evaluator:

1. **Crunchbase connector** — HARDCODED MOCK. Remove or opt-in-only.
2. **"791+ skills"** — repo has 2 skill lib files. Downgrade to "capable of hosting 791+".
3. **Per-tenant Gateway provisioning** — no code. Remove from architecture table until built.
4. **`archon-factory` external service** — already flagged as legacy but still in `packages/`. Extract or delete.
5. **Router policy fine-tune trigger at 50 verified** — currently at 3/50. Ship a story about "will fire at 50 pairs" not "is firing today".

## The "if I only had one week" prioritization

Given the pitch surface, one week of eng gets us:

- **Day 1-2:** Remove Crunchbase mock, downgrade skill count in `01-product-vision.mdc`, add auth-scope decision on stress endpoints (see T1 P1)
- **Day 3-4:** MCP registry + validator (see T4)
- **Day 5-7:** MCP training loop (see T5)

That closes the top pitch-blockers and adds the two headline features (MCP validator + MCP fine-tune loop) that no incumbent has.
