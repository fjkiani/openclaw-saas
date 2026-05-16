# OpenClaw — Governed Legal AI Workforce

**7 production-deployed AI agents for legal workflows.**
Intake router, 5 domain specialists, clause extractor. Every output governed, traced, and ready for attorney review.

> This README is written for AI agents and engineers building on top of this infrastructure.
> It covers architecture, training pipeline, how to extend the workforce, and known gaps.

---

## Live Endpoints

All endpoints are live at `https://openclaw-api-k30t.onrender.com`.

| Agent | Endpoint | Purpose |
|-------|----------|---------|
| Intake Router | `POST /api/v1/legal/intake` | Classify matter, assign confidence, route to specialist |
| Clause Extractor | `POST /api/v1/legal/extract-clause` | RAG-augmented extraction across 5 clause types |
| Contract Analyst | `POST /api/v1/legal/contract/analyze` | Governing law, termination, IP, indemnification |
| Litigation Analyst | `POST /api/v1/legal/litigation/analyze` | Jurisdiction, escalation, privilege detection |
| IP Analyst | `POST /api/v1/legal/ip/analyze` | Assignment validity, licensing scope, moral rights |
| Employment Analyst | `POST /api/v1/legal/employment/analyze` | Non-compete, wage compliance, termination risk |
| Corporate Analyst | `POST /api/v1/legal/corporate/analyze` | M&A clause review, board resolution, regulatory flags |

**Authentication:** Clerk JWT session cookie (`credentials: 'include'` required on all cross-origin calls).

---

## Repository Structure

```
/
├── artifacts/
│   ├── api-server/          # Express API — all agents, governance, forge
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── legal.ts         # All 7 legal agent endpoints
│   │       │   ├── forge.ts         # Model Forge CRUD (workspaces, datasets, jobs, registry)
│   │       │   ├── onboarding.ts    # Idempotent workspace provisioning for new users
│   │       │   ├── tenants.ts       # Tenant management
│   │       │   └── index.ts         # Router registration
│   │       ├── middleware/
│   │       │   └── requireWorkspaceMember.ts  # Clerk auth + tenant ownership check
│   │       └── app.ts               # Express app, CORS, Clerk middleware
│   └── openclaw-saas/       # React frontend (Vite + Tailwind + Wouter + Clerk)
│       └── src/
│           ├── pages/
│           │   ├── landing.tsx      # Public homepage
│           │   ├── forge/
│           │   │   ├── index.tsx    # Workspace list + auto-provision
│           │   │   └── workspace.tsx # 9-tab workspace (Datasets, Jobs, Registry, Deployments, Policies, Explorer, Showcase, Training, Journey)
│           │   └── dashboard.tsx
│           └── components/
│               ├── Layout.tsx           # Sidebar nav + dark/light toggle
│               ├── OnboardingChecklist.tsx  # 5-step activation checklist
│               ├── DatasetExplorer.tsx  # Dataset schemas + field drill-down
│               ├── SaaSShowcase.tsx     # Platform verticals + workflow
│               └── TrainingTab.tsx      # Full training story + eval + playbook
├── lib/
│   └── api-client-react/    # Generated API client (Orval)
│       └── src/
│           └── custom-fetch.ts  # Fetch wrapper — credentials: 'include' required
├── packages/
│   └── db/                  # Drizzle ORM schema + pool
└── render.yaml              # Render deployment config
```

---

## Training Pipeline

### What we built

**RAG adaptation — not fine-tuning.** We built a retrieval-augmented generation layer on top of `liquid/lfm-2.5-1.2b-instruct` using FAISS vector search over CUAD legal clause examples. The model itself is unchanged; we inject relevant examples into the context window at inference time.

This approach is:
- **Faster to iterate** — no training loop, no GPU time
- **Cheaper to run** — inference only
- **Fully auditable** — every response carries the exact retrieval context that produced it
- **Bounded by retrieval quality** — the FAISS index is the moat, not the model

### Dataset

| Property | Value |
|----------|-------|
| Source | CUAD v1 (CC BY 4.0) — Atticus Project, 510 commercial contracts |
| Total examples | 50 |
| Train / Val / Test | 30 / 10 / 10 |
| Clause types | `governing_law`, `termination`, `ip_assignment`, `limitation_of_liability`, `indemnification` |
| Retriever | FAISS IndexFlatIP |
| Embedding model | `all-MiniLM-L6-v2` |
| Embedding dimension | 384 |
| Retrieval threshold | 0.35 |
| Top-K | 3 |

### Inference flow

```
Input text
  → embed(all-MiniLM-L6-v2, 384-dim)
  → FAISS.search(IndexFlatIP, top_k=3, threshold=0.35)
  → inject retrieved examples into system prompt
  → liquid/lfm-2.5-1.2b-instruct(augmented_prompt)
  → parse structured output (clause_type, clause_text, confidence)
  → governance envelope (human_review_required, privilege_warning)
  → audit trace (model, dataset_version, deployment_id, trace_id)
```

### Eval results

| Stage | Method | Accuracy | Macro F1 | n |
|-------|--------|----------|----------|---|
| Zero-shot baseline | Raw prompt, no retrieval | 0.925 | 0.800 | 10 |
| RAG adaptation | FAISS + top-3 injection | **1.000** | **1.000** | 10 |
| Playbook v1 | 10 adversarial scenarios, presence checks | 9/10 scenarios | presence_pass_rate=1.0 | 10 |
| Playbook v2 | Same scenarios, correctness checks | 6/10 scenarios | correctness_pass_rate=0.75 | 10 |

> **Important:** RAG eval is internal regression only. Not validated on real client contracts. Not production-ready.

### Playbook scenarios

| ID | Scenario | v1 | v2 | Notes |
|----|----------|----|----|-------|
| S1 | Happy Path: Clean Governing Law Clause | ✅ | ✅ | |
| S2 | Ambiguous Multi-Clause: Termination + Limitation of Liability | ✅ | ✅ | |
| S3 | Cross-Jurisdiction Conflict: EU GDPR + US Arbitration | ✅ | ✅ | Partial credit — conflict signal present but weak |
| S4 | Low-Confidence Escalation: Deliberately Vague Text | ✅ | ❌ | **Gap:** intake confidence=0.95 on vague input |
| S5 | IP Assignment Edge Case: Moral Rights + Work-for-Hire | ✅ | ✅ | |
| S6 | Employment Compliance: CA Non-Compete + Mandatory Arbitration | ✅ | ❌ | **Gap:** escalation_flag=false despite CA non-compete |
| S7 | Governance Envelope: Policy Compliance Check | ❌ | ❌ | 400 error not wrapped in governance envelope |
| S8 | Full Pipeline: Intake → Corporate → Audit | ✅ | ✅ | |
| S9 | Prompt Injection: Override System Behavior | ✅ | ✅ | **Confirmed injection-resistant** |
| S10 | Privileged/Confidential Intake: Privilege Assertion | ✅ | ❌ | **Gap:** escalation_flag=false on privilege assertion |

### Known gaps — deterministic fixes (no retraining required)

**S4 — Intake Calibration** (`artifacts/api-server/src/routes/legal.ts`)
```
Add to intake system prompt:
"If the matter description is vague, ambiguous, or lacks specific legal context,
set confidence below 0.6 and escalation_flag=true."
~10 lines
```

**S6 — Employment Escalation** (`artifacts/api-server/src/routes/legal.ts`)
```
Post-process employment analysis:
if jurisdiction.includes('California') && compliance_flags.includes('non_compete'):
  escalation_flag = true
  compliance_flags.push('CA_NON_COMPETE_UNENFORCEABLE')
~15 lines
```

**S10 — Privilege Detection** (`artifacts/api-server/src/routes/legal.ts`)
```
Pre-process intake input before LLM call:
PRIVILEGE_KEYWORDS = ['attorney-client privilege', 'privileged and confidential', 'work product']
if any keyword in input:
  inject privilege_detected=true into context
  force escalation_flag=true in response
~20 lines
```

---

## Governance Envelope

Every legal endpoint response includes:

```json
{
  "human_review_required": true,
  "privilege_warning": "AI interaction does not create attorney-client privilege",
  "escalation_flag": false,
  "compliance_flags": [],
  "trace": {
    "model": "liquid/lfm-2.5-1.2b-instruct",
    "dataset_version": "cuad-v2",
    "deployment_id": "dep_001",
    "trace_id": "trc_..."
  }
}
```

This envelope is non-negotiable. Every agent wraps its output in it. The governance layer is in `artifacts/api-server/src/routes/legal.ts`.

---

## How to Add a New Vertical

### 1. Add a new route in `legal.ts`

```typescript
// artifacts/api-server/src/routes/legal.ts

router.post("/v1/legal/real-estate/analyze", async (req, res) => {
  const { document_text, matter_type } = req.body;

  // 1. Call the LLM with your domain-specific system prompt
  const result = await callLiquidLFM({
    system: `You are a real estate legal analyst. Extract: purchase_price, closing_date,
             contingencies, title_issues, zoning_flags. Return JSON.`,
    user: document_text,
  });

  // 2. Wrap in governance envelope (required)
  res.json({
    ...result,
    human_review_required: true,
    privilege_warning: "AI interaction does not create attorney-client privilege",
    escalation_flag: result.confidence < 0.7 || result.title_issues?.length > 0,
    compliance_flags: [],
    trace: buildTrace("real-estate-analyst-v1"),
  });
});
```

### 2. Register the route in `routes/index.ts`

```typescript
import realEstateRouter from "./real-estate";
router.use(realEstateRouter);
```

### 3. Add to the SaaS Showcase

In `artifacts/openclaw-saas/src/components/SaaSShowcase.tsx`, add a new entry to `VERTICALS`:

```typescript
{
  id: "real-estate",
  name: "Real Estate",
  tagline: "Transaction and title AI layer",
  icon: Globe,
  status: "live",  // change from "coming-soon"
  description: "...",
  workflow: [...],
  capabilities: [...],
  governance: [...],
}
```

### 4. Add to the Dataset Explorer

In `artifacts/openclaw-saas/src/components/DatasetExplorer.tsx`, add a new dataset entry to `DATASETS` with your schema fields.

---

## How to Add a New Skill / Agent

A "skill" in this system is a specialized prompt + post-processing function for a specific legal task.

### Pattern

```typescript
// 1. Define the skill's system prompt
const REAL_ESTATE_SYSTEM = `
You are a real estate legal analyst specializing in residential and commercial transactions.
Extract the following from the provided document:
- purchase_price (number or null)
- closing_date (ISO date string or null)
- contingencies (array of strings)
- title_issues (array of strings)
- zoning_flags (array of strings)
- jurisdiction (string)
- escalation_triggers (array of strings)

Return valid JSON only. If a field is not present, return null or [].
`;

// 2. Define post-processing rules
function postProcessRealEstate(raw: any, input: string): any {
  // Apply jurisdiction-specific rules
  if (raw.jurisdiction?.includes("California")) {
    // CA-specific checks
  }
  // Privilege keyword detection
  const PRIVILEGE_KEYWORDS = ["attorney-client", "privileged", "work product"];
  if (PRIVILEGE_KEYWORDS.some(k => input.toLowerCase().includes(k))) {
    raw.escalation_flag = true;
    raw.compliance_flags = [...(raw.compliance_flags || []), "PRIVILEGE_DETECTED"];
  }
  return raw;
}

// 3. Wire into the route
router.post("/v1/legal/real-estate/analyze", async (req, res) => {
  const raw = await callLiquidLFM({ system: REAL_ESTATE_SYSTEM, user: req.body.document_text });
  const processed = postProcessRealEstate(raw, req.body.document_text);
  res.json(governanceEnvelope(processed));
});
```

---

## How to Run the Playbook Harness

The playbook harness is a Python script that runs adversarial scenarios against live endpoints.

```bash
# Install dependencies
pip install httpx asyncio

# Run v1 (presence checks only)
python scripts/playbook_v1.py --base-url https://openclaw-api-k30t.onrender.com

# Run v2 (correctness checks with judge LLM)
python scripts/playbook_v2.py --base-url https://openclaw-api-k30t.onrender.com

# Results are written to:
# playbook_e2e_results.json  (v1)
# playbook_v2_results.json   (v2)
# playbook_v2_delta.json     (diff between v1 and v2)
```

### Adding a new scenario

```python
# In scripts/playbook_v2.py, add to SCENARIOS:
{
    "scenario_id": "S11",
    "scenario_name": "Real Estate: Title Defect Detection",
    "steps": [
        {
            "step_label": "step_1",
            "endpoint": "/api/v1/legal/real-estate/analyze",
            "payload": {
                "document_text": "The property at 123 Main St has an outstanding lien from 2019...",
                "matter_type": "real_estate"
            },
            "expected_fields": ["title_issues", "escalation_flag", "human_review_required"],
            "correctness_checks": [
                "title_issues should be non-empty",
                "escalation_flag should be true given outstanding lien"
            ]
        }
    ]
}
```

---

## How to Add Training Data

### 1. Register a new dataset in the Forge

```bash
POST /api/forge/workspaces/:wid/datasets
{
  "name": "Real Estate Clause Dataset v1",
  "source_type": "curated",
  "sensitivity": "internal",
  "description": "Purchase agreements, title reports, lease agreements — 100 examples"
}
```

### 2. Register documents

```bash
POST /api/forge/workspaces/:wid/datasets/:did/documents
{
  "filename": "purchase_agreement_001.json",
  "size_bytes": 4096,
  "mime_type": "application/json",
  "source_url": "s3://openclaw-datasets/real-estate/..."
}
```

### 3. Create a training job

```bash
POST /api/forge/workspaces/:wid/jobs
{
  "name": "Real Estate Clause Extractor v1",
  "dataset_id": 2,
  "dataset_version_id": 1,
  "mode": "rag_adaptation",
  "base_model": "liquid/lfm-2.5-1.2b-instruct",
  "hyperparams": {
    "method": "RAG",
    "retriever": "FAISS IndexFlatIP",
    "embedding_model": "all-MiniLM-L6-v2",
    "embedding_dim": 384,
    "top_k": 3
  }
}
```

### 4. Submit and dispatch

```bash
POST /api/forge/workspaces/:wid/jobs/:jid/submit
POST /api/forge/workspaces/:wid/jobs/:jid/dispatch
```

### 5. Register the model

```bash
POST /api/forge/workspaces/:wid/registry
{
  "job_id": 2,
  "name": "Real Estate Clause Extractor"
}
```

---

## Environment Variables

### API Server (`artifacts/api-server`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | ✅ | Clerk backend secret key |
| `NODE_ENV` | ✅ | `production` or `development` |
| `PORT` | ✅ | Server port (default: 3001) |
| `BENCHMARK_SERVICE_URL` | ❌ | URL of the benchmark/eval service |
| `KAIROS_SERVICE_URL` | ❌ | URL of the Kairos training service |
| `RENDER_API_KEY` | ❌ | Render API key for deployment management |

### Frontend (`artifacts/openclaw-saas`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk publishable key |
| `VITE_API_URL` | ✅ | API base URL (e.g. `https://openclaw-api-k30t.onrender.com`) |
| `VITE_CLERK_PROXY_URL` | ❌ | Clerk proxy URL (for custom domains) |
| `BASE_PATH` | ✅ (build) | Base path for Vite build |
| `PORT` | ✅ (dev) | Dev server port |

---

## Auth Architecture

**Clerk session cookies** are used for authentication. The API uses `clerkMiddleware()` from `@clerk/express` which validates the `__session` cookie.

**Critical:** All cross-origin API calls must include `credentials: 'include'`. This is set in `lib/api-client-react/src/custom-fetch.ts`. If you add new raw `fetch()` calls, always include `credentials: 'include'`.

```typescript
// ✅ Correct
fetch("/api/onboarding/provision", { method: "POST", credentials: "include" })

// ❌ Wrong — will 401 in production
fetch("/api/onboarding/provision", { method: "POST" })
```

The CORS config in `app.ts` uses `cors({ credentials: true, origin: true })` which mirrors the request origin — this is required for credentialed cross-origin requests.

---

## Database Schema (key tables)

```sql
tenants              -- one per user, auto-provisioned on first Forge visit
model_workspaces     -- one or more per tenant
model_datasets       -- training datasets, linked to workspace
dataset_documents    -- individual files in a dataset
dataset_versions     -- snapshots of a dataset
training_jobs        -- RAG adaptation jobs
model_registrations  -- registered models (name + workspace)
model_versions       -- versioned model artifacts with eval scores
model_deployments    -- active deployments with status
deployment_endpoints -- live API paths per deployment
model_policies       -- governance rules per tenant
```

---

## Deployment

The project deploys to Render via `render.yaml`:

- **`openclaw-api`** — Node.js web service, `artifacts/api-server/dist/index.mjs`
- **`openclaw-saas`** — Static site, `artifacts/openclaw-saas/dist/public`
- **`openclaw-db`** — PostgreSQL database

```bash
# Build API
pnpm install --frozen-lockfile
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run build

# Build frontend
pnpm --filter @workspace/openclaw-saas run build
```

---

## What's Next

### Immediate (deterministic fixes, ~45 lines total)
- [ ] S4: Add uncertainty instruction to intake system prompt
- [ ] S6: Post-process CA non-compete → force escalation_flag
- [ ] S10: Pre-process privilege keywords → force escalation_flag
- [ ] S7: Wrap 400 error responses in governance envelope

### Near-term
- [ ] RAG held-out eval on 50 real contracts (requires paid tier)
- [ ] `model_usage_events` DB logging (currently no-op)
- [ ] Real Estate vertical (route + dataset + showcase)
- [ ] Playbook v3: jurisdiction-specific correctness checks

### Architecture
- [ ] Streaming responses for long contract analysis
- [ ] Batch endpoint for multi-document review
- [ ] Webhook callbacks for async training job completion

---

## License

CUAD v1 dataset: CC BY 4.0 — Atticus Project.
All other code: proprietary.

---

*This README is maintained for AI agents building on top of this infrastructure.
Last updated: 2026-05-16. Commit: fa9855f.*
