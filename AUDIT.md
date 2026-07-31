# OpenClaw Capabilities Audit (V2 Sprint)

Method: static scan of all 27 route files (139 endpoints) + full `lib/` tree,
classifying each capability as REAL / SLOP / SIMULATED-LABELED / TEMPLATE.
"Slop" = returns fabricated data to the user as if it were real work.

## 1. Executive summary

| Class | Count | Disposition |
|-------|-------|-------------|
| Route files | 27 | — |
| Endpoints | 139 | — |
| Genuine slop (fabricated user-facing data) | **6 ZOA skills + 1 AACR crm-push** | **GUT or make real** |
| Honest simulation (labeled `simulated:true`) | same files | relabel → real or remove |
| Legit template placeholder system | clauseLibrary, draftEngine, draftVerifier, legalActionEngine | KEEP (real feature) |
| Test-only mock escape hatch | secrets.ts (DRY_RUN), guardians.ts (fixture) | KEEP (not user-facing) |

## 2. THE CORE PROBLEM: corpus content is thin

The retrieval *machinery* is real (BM25 + Qdrant hybrid + RRF merge, verified live
with cosine 0.73 top-hit). But the **content** is 12 hand-written seed documents.
That is a text-matcher over a dozen paragraphs — not a legal corpus.

**Fix (W2):** ingest CUAD (Contract Understanding Atticus Dataset) — 510 real
commercial contracts, ~13,000 labeled clauses across 41 clause types — directly
into prod Postgres + Qdrant. This makes retrieval return real contract language.

## 3. SLOP TO GUT (user-facing fabrication)

### 3a. ZOA skills (`lib/skills/zoa/index.ts`) — 6 skills, ALL simulated
Each fabricates numbers instead of doing work:
- `zoa-billing`: `reconciled = count*0.9`, `totalAmount = count*1250.75` — pure invention
- `zoa-scheduling`: returns 3 hardcoded future dates as "available slots"
- `zoa-payroll`, `zoa-hr`, `zoa-procurement`, `zoa-compliance`: same pattern

These are not connected to any real billing/calendar/payroll/HR system.
**Disposition:** gut the fabricated-number returns. Either (a) wire to a real
connector, or (b) convert to honest "capability framework" that requires a
user-provided connector credential and errors honestly when absent (the pattern
we applied to crunchbase.ts). No invented numbers.

### 3b. AACR crm-push (`lib/skills/aacr/index.ts`)
Logs a payload, returns a fake receipt. **Disposition:** honest-error pattern —
require CRM connector credential, throw when absent.

## 4. REAL capabilities (verified, keep)

- **Legal counsel retrieval** — hybrid BM25+Qdrant+RRF, live-verified
- **Qdrant vector store** — 2 collections, payload indexes, real embeddings (Gemini 3072/1536-dim)
- **LLM routing** — Groq (primary) + Gemini (fallback), OpenRouter fully removed
- **Archon skill forge** — real LLM-backed generation (Groq/Gemini keys confirmed live)
- **Draft engine** — template + intake + verifier (PLACEHOLDER_LEAK detection) — real
- **Workflow engine** — real orchestration over registered skills
- **Double-dip router** — real fast/slow path with DB policy override
- **Rigor gate / verification** — real guardians + bench harness

## 5. KEEP but reclassify (not slop)

- `secrets.ts` MOCK_VALUES — only under `DRY_RUN=1`, a test escape hatch, never in prod
- `guardians.ts` lorem_ipsum — a verifier test fixture, intentional
- `[PLACEHOLDER:]` markers — the clause templating feature, verifier catches leaks

## 6. V2 GAP: no sovereign / private-deployment capability

Nothing in the repo supports air-gapped / on-prem / isolated-tenant deployment
(local LLM, VPC, no public cloud). This is the V2 moat. Built in W3/W4/W5:
- W3: provider abstraction (cloud + local/Ollama embeddings & chat) + local auth
- W4: sovereign deployment bundle generator (compose, env, scripts, docs) + front-end
- W5: MCP server (Cloudflare MCP pattern) + Archon/Forge deployment-bundle generation
