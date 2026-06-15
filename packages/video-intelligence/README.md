# @workspace/video-intelligence

AACR 2026 conference intelligence pipeline — crawler, dual-schema LLM extractor, Supabase storage, and TypeScript SDK.

## What This Is

A complete pipeline that:
1. Crawls AACR 2026 session metadata from Swapcard
2. Downloads Vimeo VTT transcripts for each session
3. Runs dual-schema LLM extraction (Schema A: scientific, Schema B: competitive intel)
4. Stores all outputs in Supabase with pgvector embeddings
5. Exposes a TypeScript SDK for querying the corpus

## Corpus Stats (AACR 2026, as of 2026-06-15)

| Table | Rows | Description |
|---|---|---|
| `aacr_sessions` | 296 | Unique session slugs |
| `aacr_speakers` | 862 | Schema A scientific extraction |
| `aacr_competitive_intel` | 926 | Schema B competitive intelligence |
| `aacr_clinical_data` | 1,480 | Flattened clinical data entries |
| `aacr_embeddings` | 3,024 | pgvector embeddings (1536 dims, OpenAI text-embedding-3-small) |

### Embedding coverage
| Field | Count |
|---|---|
| `moa_summary` | 862 (100%) |
| `key_findings` | 861 |
| `crispro_opportunity` | 851 |
| `cognitive_dissonance` | 450 (sessions with CD hits only) |

### Presentation type distribution
| Type | Count |
|---|---|
| `clinical_trial_readout` | 381 |
| `translational_science` | 342 |
| `platform_showcase` | 82 |
| `basic_science` | 52 |

## Supabase Schema

**Project:** `xfhiwodulrbbtfcqneqt`  
**URL:** `https://xfhiwodulrbbtfcqneqt.supabase.co`

### `aacr_sessions`
```sql
id SERIAL PRIMARY KEY
slug TEXT UNIQUE NOT NULL          -- e.g. "kras-targeted-therapies-overcoming-resistance"
title TEXT
created_at TIMESTAMPTZ
```

### `aacr_speakers` (Schema A)
```sql
id SERIAL PRIMARY KEY
talk_id TEXT UNIQUE NOT NULL       -- format: {session_slug}::{speaker_last_name}::{index}
session_slug TEXT REFERENCES aacr_sessions(slug)
session_title TEXT
talk_title TEXT
speaker_name TEXT
affiliation TEXT
role TEXT
disclosures_noted BOOLEAN
tumor_types TEXT[]
clinical_stage TEXT                -- enum: preclinical|IND_enabling|phase_1|phase_1_2|phase_2|phase_2_3|phase_3|approved|mixed|unspecified
topic_categories TEXT[]
novelty_flag TEXT                  -- enum: first_in_class|best_in_class|me_too|platform_technology|clinical_validation_of_known|negative_or_null_result|unspecified
moa_summary TEXT
key_findings TEXT[]
readouts TEXT[]
resistance_notes TEXT[]
open_questions TEXT[]
targets JSONB
biomarkers JSONB
models JSONB
clinical_data JSONB
combination_strategies JSONB
external_follow_up JSONB
created_at TIMESTAMPTZ
```

### `aacr_competitive_intel` (Schema B)
```sql
id SERIAL PRIMARY KEY
talk_id TEXT NOT NULL
speaker_talk_id TEXT               -- join key to aacr_speakers (null if ::unknown::)
session_slug TEXT REFERENCES aacr_sessions(slug)
speaker_name TEXT
institution TEXT
session_title TEXT
talk_title TEXT
presentation_type TEXT             -- enum: clinical_trial_readout|translational_science|platform_showcase|basic_science|industry_pitch|preclinical_science|...
rhetorical_signals TEXT[]          -- verbatim speaker quotes
cognitive_dissonance TEXT[]        -- observation + contradictory conclusion pairs
vulnerability_identified JSONB
trial_dilution_risk JSONB
competitive_moat_weakness JSONB
data_maturity TEXT                 -- enum: preclinical_only|early_clinical|mature_clinical|mixed|not_applicable
sample_size_adequacy TEXT
follow_up_adequacy TEXT
key_data_gaps TEXT[]
crispro_opportunity JSONB[]        -- array of {opportunity_type, priority, description, transcript_evidence, crispro_angle}
cited_competitors JSONB
unresolved_questions TEXT[]
nct_candidates TEXT[]              -- properly-formatted NCTs only (unverified)
assets_to_track TEXT[]
companies_to_monitor TEXT[]
created_at TIMESTAMPTZ
```

### `aacr_clinical_data`
```sql
id SERIAL PRIMARY KEY
talk_id TEXT REFERENCES aacr_speakers(talk_id)
speaker_name TEXT
affiliation TEXT
session_slug TEXT
tumor_types TEXT[]
clinical_stage TEXT
metric TEXT                        -- e.g. "ORR", "PFS", "OS", "DOR"
value TEXT                         -- e.g. "33%", "8.8 months"
confidence_interval TEXT
n TEXT                             -- free text (e.g. "n=21", "Phase I crizotinib trial")
population TEXT
comparator TEXT
maturity TEXT
created_at TIMESTAMPTZ
```

### `aacr_embeddings`
```sql
id SERIAL PRIMARY KEY
source_table TEXT                  -- 'aacr_speakers' | 'aacr_competitive_intel'
source_id INTEGER
talk_id TEXT
speaker_name TEXT
session_slug TEXT
field_name TEXT                    -- 'moa_summary' | 'key_findings' | 'cognitive_dissonance' | 'crispro_opportunity'
chunk_text TEXT
embedding vector(1536)             -- OpenAI text-embedding-3-small
created_at TIMESTAMPTZ
```

### Semantic search RPC
```sql
SELECT * FROM match_embeddings(
  query_embedding  vector(1536),
  match_field      TEXT DEFAULT NULL,    -- filter by field_name, NULL = all
  match_count      INT  DEFAULT 10,
  match_threshold  FLOAT DEFAULT 0.7
);
-- Returns: id, source_table, source_id, talk_id, speaker_name, session_slug, field_name, chunk_text, similarity
```

## SDK Usage

```typescript
import { createAACRClient, searchCorpus, generateEmbedding } from '@workspace/video-intelligence/sdk';

// Create client (reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env)
const aacr = createAACRClient();

// Get speakers filtered by tumor type and clinical stage
const speakers = await aacr.getSpeakers({
  tumor_type: 'colorectal cancer',
  clinical_stage: 'phase_3',
  limit: 20,
});

// Get cognitive dissonance hits (clinical trial readouts only)
const cdHits = await aacr.getCDHits({
  presentation_type: 'clinical_trial_readout',
  min_cd_count: 1,
  limit: 50,
});

// Get high-priority CrisPRO opportunities
const opps = await aacr.getCrisPROOpportunities({
  opportunity_type: 'biomarker_stratification_gap',
  priority: 'high',
});

// Semantic search (requires OPENROUTER_API_KEY)
const embedding = await generateEmbedding('KRAS inhibitor resistance mechanisms');
const results = await aacr.semanticSearch({ query: '...', match_count: 10 }, embedding);

// Full search pipeline with GPT-4o re-ranking (feeds double-dip flywheel)
const response = await searchCorpus(aacr, {
  query: 'KRAS inhibitor resistance mechanisms in pancreatic cancer',
  field: 'moa_summary',
  matchCount: 10,
  rerank: true,  // triggers slow path → generates DPO training pair
});
```

## REST API (via openclaw-saas api-server)

All routes require Clerk JWT auth (except `/api/intelligence/stats`).

```
GET  /api/intelligence/sessions          — list sessions (paginated)
GET  /api/intelligence/speakers          — search speakers
GET  /api/intelligence/cd-hits           — cognitive dissonance hits (ranked)
GET  /api/intelligence/crispro           — CrisPRO opportunities
POST /api/intelligence/search            — semantic search
GET  /api/intelligence/stats             — corpus statistics
GET  /api/intelligence/flywheel          — AACR domain flywheel status
```

## Double-Dip Flywheel Integration

Every `/api/intelligence/search` call with `rerank=true` feeds the double-dip training flywheel:

- **Fast path:** embedding-only cosine similarity ranking
- **Slow path:** GPT-4o re-ranking of top-10 results
- **Vault capture:** slow-path winner + fast-path ranking → `zie_preference_pairs` (domain=`aacr`, task_type=`competitive_intel_extraction`)
- **Threshold:** 50 verified pairs → Modal LoRA fine-tune fires automatically
- **After training:** `zie_router_policies` updated → fast path uses fine-tuned model

## Pipeline Source Files

| File | Description |
|---|---|
| `src/crawler/swapcard_session_crawler.py` | Playwright auth + GraphQL APQ session crawler |
| `src/crawler/vimeo_vtt_pipeline.py` | Vimeo embed → VTT → clean text pipeline |
| `src/extractor/extractor.py` | LLM extractor v6 (dual-schema, OpenRouter) |
| `src/extractor/aggregate.py` | Merge per-session outputs into master files |
| `src/schemas/schema_a_scientific.json` | Schema A v2 (scientific extraction) |
| `src/schemas/schema_b_competitive_intel.json` | Schema B v2 (competitive intelligence) |

## Environment Variables

```bash
# Supabase (required for SDK)
SUPABASE_URL=https://xfhiwodulrbbtfcqneqt.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_jwt>

# OpenRouter (required for embedding + re-ranking)
OPENROUTER_API_KEY=<key>

# Python extractor (optional — uses OpenRouter)
OPENROUTER_KEY1=<key1>
OPENROUTER_KEY2=<key2>
```

## Known Limitations

1. **Schema B `talk_id` bug:** Some records use `::unknown::` instead of speaker last name — the `speaker_talk_id` join key is null for these records. Fix in next extractor version.
2. **NCT numbers:** All extracted NCT numbers are unverified (VTT transcripts are spoken word — speakers say trial names, not NCT numbers). Use `nct_candidates_unverified.csv` with caution.
3. **8 missing sessions:** Non-scientific sessions (AACR business meeting, NCI grant workshops, researcher town hall) were not extracted.
4. **IVFFlat index:** Run `CREATE INDEX ON aacr_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);` in Supabase SQL Editor after data load for fast ANN search at scale.
