# Intern Assignment: Workflow Skill Evaluation Pipeline

**Repo:** `fjkiani/openclaw-saas`  
**Branch:** `validation/intern-framework`  
**Issued:** 2026-06-16  
**Duration:** 1–2 weeks

---

## What You're Building On

OpenClaw already has a working LLM-as-judge evaluation pipeline. It lives in:

- `lib/judgePair.ts` — judges one `zie_preference_pairs` row, writes to `evaluation_runs` + `evaluation_metrics`
- `lib/benchmarkClient.ts` — calls the Kairos benchmark service for L1–L4 skill grades, writes to `skill_benchmarks`
- `lib/workflowEngine.ts` — executes multi-step workflow definitions, writes to `workflow_runs` + `workflow_step_results`

The integration agent wired these together for the AACR use case. What it did **not** do is close the loop: the workflow engine runs skills, but there is no mechanism to evaluate whether those skill outputs are any good, and no way to benchmark a full workflow definition the same way ZOA skills are benchmarked.

That gap is your assignment.

---

## What Was Built for You

Three new files are already on this branch:

### `lib/skillEval.ts`
Extends `judgePair` to evaluate a single skill handler invocation. Given a `skillId`, an `input`, and a rubric, it:
1. Invokes the handler directly (via `_getHandler` shim in `lib/skills/aacr/index.ts`)
2. Checks output completeness against `expectedOutputKeys`
3. Runs the LLM judge (same model chain as `judgePair.ts`)
4. Writes one `evaluation_runs` row + four `evaluation_metrics` rows: `output_completeness`, `output_quality`, `latency_ms`, `error_rate`

### `lib/workflowBenchmark.ts`
Extends `benchmarkClient` to run L1–L4 against a full workflow definition:
- **L1** — Schema: every step has a valid `skill_id` and `output_key`
- **L2** — Coverage: every `skill_id` is registered in `workflowEngine`
- **L3** — Quality: `evalSkillHandler()` judge score ≥ 0.7 per step
- **L4** — E2E: `workflowEngine.startRun()` → `completed` within timeout

Writes a `skill_benchmarks` row with grade `CERTIFIED` / `CONDITIONAL` / `FAILED`.

### `routes/eval.ts`
Four HTTP endpoints wired into the existing router at `/api/eval/`:
- `POST /api/eval/skills/:skillId` — evaluate one skill
- `POST /api/eval/workflows/:definitionId` — run L1–L4 benchmark
- `GET  /api/eval/workflows/:definitionId/results` — latest benchmark result
- `GET  /api/eval/skills/:skillId/history` — evaluation history

---

## Your Job

The scaffolding is built. Your job is to make it production-ready. Specifically:

### Task 1: Run the pipeline against the live system

Connect to the live Render Postgres DB and run the benchmark against the seeded AACR workflow definition. Record what passes and what fails.

```bash
# The seeded definition is in workflow_definitions — find its ID:
psql $DATABASE_URL -c "SELECT id, name FROM workflow_definitions WHERE tenant_id = 'tenant-demo-openclaw';"

# Then hit the eval endpoint (you need a Clerk test token from Fahad):
curl -X POST https://openclaw-api-k30t.onrender.com/api/eval/workflows/<id> \
  -H "Authorization: Bearer <clerk_token>" \
  -H "Content-Type: application/json" \
  -d '{"test_inputs": [{"query": "KRAS G12C inhibitor resistance"}]}'
```

Document the result in `validation/results/baseline_YYYYMMDD.json`.

### Task 2: Extend the rubric registry

`workflowBenchmark.ts` has a `SKILL_RUBRICS` map with entries for the 4 AACR skills. When a new skill domain is added (e.g., ZOA billing skills), someone needs to add rubrics. Your job:

1. Read the ZOA skill endpoints in `routes/billing.ts`, `routes/payroll.ts`, etc.
2. Add rubric entries for at least 3 ZOA skills (your choice which ones)
3. Run `POST /api/eval/skills/<skillId>` against each and record the judge scores

This tells us whether the eval pipeline generalizes beyond AACR.

### Task 3: Wire the judge trigger into the flywheel

`lib/vaultAutoJudge.ts` already auto-judges `zie_preference_pairs` after vault writes. The same pattern should apply to skill evals: after a workflow run completes, auto-evaluate the step outputs.

In `lib/workflowEngine.ts`, find the `_executeRun` method. After the final `UPDATE workflow_runs SET status = 'completed'` call, add a non-blocking `setImmediate` that calls `evalSkillHandler` for each step that has a rubric defined. Follow the exact pattern in `vaultAutoJudge.ts`.

This closes the loop: every production workflow run automatically generates eval data, which feeds back into the quality metrics visible on the skills page.

### Task 4: Surface benchmark grades on the Workflows tab

`skills.tsx` was updated to add a Workflows tab (P4 from the integration agent). The tab fetches `GET /api/workflows/definitions` and renders definition cards. Your job: add a benchmark grade badge to each card.

The data is already available: `GET /api/eval/workflows/:definitionId/results` returns the latest `skill_benchmarks` row. Add a `BenchmarkGradeBadge` component (already used elsewhere in `skills.tsx`) to each workflow definition card.

---

## What Not to Touch

- `routes/forge.ts` — Forge owns this
- `lib/kairosClient.ts` — extend, don't replace
- `lib/jobMonitor.ts` — leave as-is
- `lib/db/src/schema/model*.ts` and related Forge schema files
- Any existing `evaluation_runs` / `evaluation_metrics` rows — your writes are additive

---

## Acceptance Criteria

1. `POST /api/eval/workflows/<aacr_definition_id>` returns a result with `grade` field (CERTIFIED / CONDITIONAL / FAILED) and all 4 level results populated
2. `evaluation_runs` table has new rows with `domain = 'workflow-skill'` after running the benchmark
3. At least 3 ZOA skill rubrics added to `SKILL_RUBRICS`
4. `workflowEngine._executeRun` triggers auto-eval after run completion (non-blocking)
5. Workflows tab in `skills.tsx` shows benchmark grade badge on definition cards
6. All changes on `validation/intern-framework` branch, PR opened against `main`

---

## Key Constants

| Item | Value |
|---|---|
| Demo tenant ID | `tenant-demo-openclaw` |
| Demo user ID | `user_3DhVktxcTmcEqDWgYpMihDOy00t` |
| AACR workflow definition name | "Conference Intelligence → CRM Pipeline" |
| Judge pass threshold | 0.7 (combined completeness + quality) |
| L3 CERTIFIED threshold | avg ≥ 0.7 |
| L3 CONDITIONAL threshold | avg ≥ 0.5 |
| Supabase project | `xfhiwodulrbbtfcqneqt` |
| API base | `https://openclaw-api-k30t.onrender.com` |

---

## Escalation

If a test fails and you can't determine root cause in 2 hours: open a GitHub issue on `fjkiani/openclaw-saas` with label `validation-blocker`. Do not modify production code to make a test pass.
