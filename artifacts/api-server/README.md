# @workspace/api-server

Express 5 API server for the OpenClaw SaaS control plane. Handles agent provisioning, skill management, connector registry, knowledge graphs, and chat proxying.

## Overview

- **Framework**: Express 5 with async error handling
- **Port**: Reads from `$PORT` environment variable
- **Base path**: `/api` (all routes are prefixed)
- **Auth**: Clerk middleware (`@clerk/express`) — every route checks `getAuth(req).userId`
- **Database**: PostgreSQL via Drizzle ORM (`@workspace/db`)
- **Logging**: pino with request/response auto-logging — use `req.log` in handlers, `logger` singleton elsewhere
- **Build**: esbuild CJS bundle (source maps enabled for production stack traces)

## Structure

```
src/
├── index.ts              # Server bootstrap (port binding, middleware, pino-http)
├── routes/
│   ├── index.ts          # Mounts all routers
│   ├── health.ts         # GET /api/healthz
│   ├── tenants.ts        # CRUD + start/stop/delete (Render API)
│   ├── chat.ts           # GET/POST /api/tenants/:id/chat
│   ├── connectors.ts     # Connector registry + install/remove (AES-256 creds)
│   ├── graphs.ts         # Knowledge graphs + PDF upload + tsvector search
│   ├── skills.ts         # Skill catalog CRUD + GitHub refresh
│   ├── dashboard.ts      # Aggregated dashboard stats
│   ├── billing.ts        # Plan/usage endpoints
│   └── webhooks.ts       # POST /api/webhooks/render (async status sync)
└── connectors/
    └── crunchbase.ts     # Crunchbase adapter (real API or mock)
```

## Routes

### Health
```
GET  /api/healthz          → { status: "ok" }
```

### Tenants
```
GET    /api/tenants                        → List user's agents
POST   /api/tenants                        → Provision new agent via Render API
GET    /api/tenants/:id                    → Get agent details
DELETE /api/tenants/:id                    → Destroy agent + Render service
POST   /api/tenants/:id/start              → Resume suspended Render service
POST   /api/tenants/:id/stop               → Suspend Render service
```

### Chat
```
GET  /api/tenants/:id/chat                 → Chat history (PostgreSQL)
POST /api/tenants/:id/chat                 → Send message (proxied to gateway HTTP API)
```

### Connectors
```
GET    /api/connectors                     → List registry (Crunchbase, Gmail, LinkedIn)
GET    /api/tenants/:id/connectors         → List installed connectors
POST   /api/tenants/:id/connectors         → Install with AES-256 encrypted credential
DELETE /api/tenants/:id/connectors/:cid    → Remove connector
```

### Knowledge Graphs
```
GET    /api/tenants/:id/graphs                            → List graphs
POST   /api/tenants/:id/graphs                            → Create graph
DELETE /api/tenants/:id/graphs/:graphId                   → Delete graph + all documents
GET    /api/tenants/:id/graphs/:graphId/documents         → List documents
POST   /api/tenants/:id/graphs/:graphId/documents         → Upload PDF/TXT (multipart/form-data)
POST   /api/tenants/:id/graphs/:graphId/query             → Full-text search (tsvector + ts_rank)
```

### Skills
```
GET    /api/skills                         → Browse catalog (search, category filter)
GET    /api/tenants/:id/skills             → Installed skills
POST   /api/tenants/:id/skills             → Install skill
DELETE /api/tenants/:id/skills/:skillId    → Uninstall skill
POST   /api/skills/refresh                 → Refresh catalog from GitHub
```

### Webhooks
```
POST /api/webhooks/render                  → Render deploy/suspend/delete events
```

## Adding a Route

1. Add the OpenAPI operation to `lib/api-spec/openapi.yaml`
2. Run `pnpm --filter @workspace/api-spec run codegen` to regenerate Zod schemas and React Query hooks
3. Create or extend a route file in `src/routes/`
4. Mount the router in `src/routes/index.ts`
5. Run `pnpm run typecheck` — must pass

## Scripts

```bash
pnpm run dev        # Build + start with NODE_ENV=development
pnpm run build      # esbuild bundle to dist/
pnpm run start      # node --enable-source-maps ./dist/index.mjs
pnpm run typecheck  # tsc --noEmit
```

## Connector System

External API adapters live in `src/connectors/`. Each adapter:

1. Accepts a credential string (decrypted on-the-fly from `tenant_connectors`)
2. Exports typed functions for its operations
3. Falls back to mock data when no credential is configured

Current adapters:

| Adapter | File | Status |
|---|---|---|
| Crunchbase | `crunchbase.ts` | Mock (real API when `CRUNCHBASE_API_KEY` set) |
| Gmail | — | Phase 2 |
| LinkedIn | — | Phase 3 |

## Credential Security

Connector credentials are encrypted with AES-256-GCM using the `SESSION_SECRET` environment variable as the key material (PBKDF2-derived, 100k iterations). The encrypted blob and IV are stored in `tenant_connectors.encryptedCredential`. Raw credential values are **never** returned in any API response.

See `lib/crypto-utils` for implementation details.

## Document Processing Pipeline

1. Client POSTs multipart/form-data to `/api/tenants/:id/graphs/:graphId/documents`
2. `multer` buffers the file in memory (20 MB limit)
3. `pdf-parse` extracts raw text (PDFs) or buffer decoded directly (TXT)
4. Text is split into ~512-character chunks with 50-character overlap
5. Each chunk is inserted into `graph_chunks` with a generated `tsvector` column (GIN index)
6. Document status updated to `"ready"` on success, `"error"` on failure

Search queries run `ts_rank(tsv, plainto_tsquery($query))` ordered by rank descending.
