# Agent 4 — MDC / Docs audit

**Scope**: `.cursor/rules/*.mdc` and `.md`. Where do claims contradict code? Which files need honest downgrades?

**Method**: The repo already has a mature label vocabulary: **LIVE / PARTIAL / VISION / STALE / FICTION** (defined in `04-model-forge.mdc:19-24` and `MDC_training.md:12-18`). Reused here.

---

## The 16 MDC/MD files

```
393  00-MASTER.mdc               — top-level product spec (read-first)
 72  01-product-vision.mdc       — positioning
110  02-architecture.mdc         — deploy topology + stack
130  03-skill-contract.mdc       — skill JSON schema
353  04-model-forge.mdc          — Model Forge (has LIVE/FICTION labels — GOOD)
185  05-execution-engines.mdc    — ZOA/Archon/Kairos (STALE — targets dead services)
124  06-governance-layer.mdc     — governance envelope
127  07-legal-vertical.mdc       — legal PoC (has LIVE/FICTION labels — GOOD)
107  08-database-schema.mdc      — DB schema
446  08-legal-corpus-agent-handoff.mdc — corpus ingest gate
152  09-frontend-design.mdc      — design system (unlabeled — mostly correct)
473  10-cofounder-specialist.mdc — co-founder specialist spec ("IN PROGRESS")
493  HANDOFF_integration_agent.md — GOLD STANDARD — audited 2026-06-06
315  MDC_architecture.md         — target 7-stage MDC (has LIVE/VISION labels — GOOD)
323  MDC_training.md             — LIVE-vs-VISION training reality (GOOD)
263  OPENCLAW-AGENT-BRIEF.mdc    — agent role brief
```

**Best-audited files**: `HANDOFF_integration_agent.md`, `MDC_training.md`, `MDC_architecture.md`, `04-model-forge.mdc`, `07-legal-vertical.mdc`. These use explicit labels and probe evidence.

**Least-audited**: `05-execution-engines.mdc`, `02-architecture.mdc`, `01-product-vision.mdc`, `00-MASTER.mdc` — no LIVE/VISION labels.

## Fake / stale claims (with evidence)

### CRITICAL — dead services still positioned as canonical

`.cursor/rules/05-execution-engines.mdc:13-15`
```
| ZOA    | Multi-LLM router + agent orchestration | openclaw-benchmark (FastAPI) |
| Archon | Skill generation workflow engine       | archon-factory + archon-zeta (Render) |
| Kairos | Training job execution + governance    | openclaw-benchmark (FastAPI) |
```

**Reality (per `HANDOFF_integration_agent.md` §1.4 + Agent 1's live probe of `benchmarkRunner.ts:4` header)**:
- `openclaw-benchmark.onrender.com` is documented dead (Kairos LLM layer failed in probes).
- Archon logic **has been re-homed in-process** (`artifacts/api-server/src/lib/archon/` — 7 files, DB-backed). `archon-factory` still deploys per `render.yaml` but is duplicative.
- ZOA endpoints on `openclaw-benchmark` are **CORS-fixed** per HANDOFF but "runs fail on LLM streaming read".

**Downgrade required**: label these three rows with `STALE — see HANDOFF_integration_agent.md §1.4` and add a "Current live path" column pointing at `lib/archon/` and in-process archon routes.

### CRITICAL — architecture doc positions the same dead FastAPI

`02-architecture.mdc:48`
```
| Benchmark + ZOA + Kairos | openclaw-benchmark | Python (FastAPI) | Starter |
```

**Downgrade**: mark row `STALE`, add footnote: "See `MDC_training.md` — canonical benchmark path is now in-process (`lib/archon/`)."

### The `benchmarkClient.ts` upstream fiction

`.env.example:11`
```
# URL of the running mcp-benchmarks FastAPI service (benchmark gate + ZOA agents)
BENCHMARK_SERVICE_URL=http://localhost:8001
```

**Reality**: `mcp-universe-benchmarks` (referenced repo) has **no FastAPI** — it's a Python CLI with `mcpbench.cli`. `BENCHMARK_SERVICE_URL` is either the dead onrender service or an imagined localhost daemon.

**Downgrade required**: `.env.example` comment must say "**PARTIAL** — FastAPI wrapper for mcp-universe-benchmarks is a v2 target; today `checkBenchmarkGate` uses in-process `lib/archon/benchmarkRunner.ts`."

### `05-execution-engines.mdc` — legacy shape of Archon integration

Lines 66-105 describe Archon as an external workflow engine you call via `POST http://archon-zeta.onrender.com/api/workflows/zeta-skill-forge/run`. This still works if `archon-zeta` is deployed, but the actual **live production path** is:
```
POST /api/archon/generate  →  in-process pipeline.ts  →  DB-backed run store
```

**Downgrade required**: add a "**Live today**" section at the top of §Archon pointing at `artifacts/api-server/src/lib/archon/*.ts` + `routes/archon.ts`, and demote the external-service section to "**VISION / legacy**".

### 00-MASTER.mdc / 01-product-vision.mdc — factory framing works, but promises specific engines

`00-MASTER.mdc:39` — "'Demo' → 'Live' or 'Production'" language policy is fine.

`01-product-vision.mdc:22-24` — lists engines:
```
- ZOA, Archon, Kairos execution engines
```

**Not fiction, but incomplete** — should also list **stress-benchmarks** as an engine class once Agent 2 lands. **Extension needed** (not downgrade).

## Docs to CREATE (for the new domain)

1. **New MDC**: `.cursor/rules/11-agent-robustness.mdc` — spec for the new domain (frontend routes, backend endpoints, corpus source, provenance).
2. **New README**: `artifacts/api-server/src/lib/stress-benchmarks/README.md` — corpus origin + schema + refresh strategy.
3. **Update**: `HANDOFF_integration_agent.md §1.3 + §1.5` — register the new routes + frontend page in the LIVE inventory (only after Agent 5 confirms the routes actually run in dev).

## Docs to DOWNGRADE (in-place edits, this pass)

| File | Line(s) | Downgrade |
|---|---|---|
| `05-execution-engines.mdc` | 12-15 (table) | Mark ZOA/Archon/Kairos rows `STALE — see HANDOFF §1.4`; add "Current live path" column |
| `05-execution-engines.mdc` | 66-90 (Archon section) | Add "Live today = in-process" preamble; demote external-service body to "VISION / legacy" |
| `02-architecture.mdc` | 48 (services table) | Add STALE marker to `openclaw-benchmark` row |
| `02-architecture.mdc` | 69-70 (repo tree comments) | Note that `packages/archon/` is a config shim, `packages/archon-factory/` is a legacy standalone deploy — the live code is in `lib/archon/` |
| `.env.example` | 11 comment | "**PARTIAL** — FastAPI wrapper is v2; today gate uses in-process runner" |

## Docs to LEAVE ALONE (already honest)

- `HANDOFF_integration_agent.md` — gold standard, audited 2026-06-06.
- `MDC_training.md` — has proper LIVE/PARTIAL/VISION labels + probe evidence.
- `MDC_architecture.md` — labelled.
- `04-model-forge.mdc` — 43 label uses, best-labelled file in the repo.
- `07-legal-vertical.mdc` — 14 label uses.
- `08-legal-corpus-agent-handoff.mdc` — explicit verification checklist pattern.

## Never say

- "Demo" (per `09-frontend-design.mdc:148`) — use "Live" or "Production".
- "Implementation Complete" without pasted verification output (per `08-legal-corpus` §Fail example).

## Verification convention (for the new domain to follow)

Every "**LIVE**" claim we add to MDCs about stress-benchmarks must be provable by:
1. A curl command that hits the route and returns non-error JSON, OR
2. A file path + `wc -l` count, OR
3. A DB SQL query that returns > 0 rows.

Follow `08-legal-corpus §Verification checklist` pattern.
