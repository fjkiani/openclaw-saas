# 2026-07 Agent Robustness Domain — Audit Bundle

This folder is the paper trail for the Sprint-A/B/C/D build that added the
**Agent Robustness Benchmarks** domain to openclaw-saas.

## 5-agent audit shape (sequential)

| Agent | Report | Role |
|---|---|---|
| 1 | `01-architect.md` | Repo topology, route map, integration architecture, dead pointers |
| 2 | `02-backend.md` | Live vs stub inventory, new lib/route deliverables, JSONL contract |
| 3 | `03-frontend.md` | Page/tab layout, shadcn primitives to reuse, nav wiring |
| 4 | `04-mdc-docs.md` | MDC downgrade list with line numbers + honest labels |
| 5 | `05-integrations.md` | Env vars, CORS, corpus deploy strategy |

## Fake-claim policy applied

**Downgrade + build critical.** Every mention of the (dead)
`openclaw-benchmark` FastAPI, `archon-factory` service, `archon-zeta`
deploy, and the "b9wb vs k30t" hostname mismatch was labelled honestly in
the MDCs / HANDOFF / .env.example / render.yaml. Only the stubs on the
critical path for the new domain were physically built this pass — the
external services were not resurrected.

## What was built vs deferred

Built:
- `artifacts/api-server/src/lib/stress-benchmarks/` (types, runStore, aggregate, README)
- `artifacts/api-server/src/routes/stressBenchmarks.ts` (7 endpoints)
- `artifacts/api-server/corpus/stress-benchmarks/` (909-row JSONL + PROVENANCE.md)
- `artifacts/openclaw-saas/src/pages/agent-robustness/` (page + hooks)
- `.cursor/rules/11-agent-robustness.mdc`
- Nav + route registration + `/api/status` extension
- `benchmarkClient.ts` reachability preflight (removes 65s stall on dead service)
- MDC/HANDOFF/env/render.yaml downgrades

Deferred (flagged, not built):
- Redeploy of `openclaw-benchmark` FastAPI
- Extraction of `packages/archon-factory` into its own service
- Reconciling `openclaw-api-b9wb` vs `openclaw-api-k30t` hostname (Render dashboard action)
- Live re-run of stress corpus from the UI (out of scope — see 11-agent-robustness.mdc "What NOT to do")

## Verification evidence

- Typecheck: zero new errors introduced (pre-existing owner-boundary errors in `forge/*`, `flywheel.ts`, `seo.ts`, `skills.ts`, `legal.kb.ts`, `judge.ts`, `workflows.ts`, `aacr/index.ts`, `grounding.ts` are unchanged).
- Backend smoke: 13/13 endpoint variants pass with value assertions (see commit message).
- Frontend build: 1894 modules transform including the new page.
- CWD-agnostic corpus resolver: verified from both dev CWD (`artifacts/api-server`) and prod CWD (repo root) — both resolve to the same 909-row corpus.
