# OpenClaw SaaS

> Multi-tenant SaaS control plane for the [OpenClaw](https://github.com/VoltAgent/openclaw) AI agent runtime.

OpenClaw SaaS lets teams provision isolated AI agent instances, install skills from a community catalog, connect external data sources, and manage knowledge graphs — all from a single dashboard. Each agent runs as a private Render service with its own encrypted disk, WebSocket endpoint, and credential store.

---

## Table of Contents

- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Key Features](#key-features)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Deployment](#deployment)
- [Contributing](#contributing)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  OpenClaw SaaS (this repo)               │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐  ┌──────────────┐  │
│  │  React+Vite  │   │ Express API  │  │  PostgreSQL  │  │
│  │  Frontend    │──▶│   Server     │──▶│  + pgvector  │  │
│  │  (Clerk auth)│   │  (Express 5) │  │  (Drizzle)   │  │
│  └──────────────┘   └──────┬───────┘  └──────────────┘  │
│                             │                             │
│                    ┌────────▼────────┐                   │
│                    │ Render Deploy   │                   │
│                    │ API (gateway    │                   │
│                    │ provisioner)    │                   │
│                    └────────┬────────┘                   │
└─────────────────────────────┼───────────────────────────┘
                              │ provisions
              ┌───────────────▼───────────────┐
              │  Per-tenant OpenClaw Gateway  │
              │  openclaw-gateway-{tenantId}  │
              │  Render Private Service       │
              │  - Isolated disk /tenants/{id}│
              │  - WebSocket endpoint         │
              │  - HTTP chat API              │
              └───────────────────────────────┘
```

### Request Flow

1. User authenticates via Clerk (JWT in every request)
2. React frontend calls `/api/*` endpoints using generated TanStack Query hooks
3. Express API validates inputs with Zod, queries PostgreSQL via Drizzle ORM
4. Gateway provisioning calls Render Deploy API to spin up per-tenant Docker containers
5. Render webhooks (`POST /api/webhooks/render`) update tenant status asynchronously

---

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces |
| Language | TypeScript 5.9, Node.js 24 |
| Frontend | React 19, Vite 7, Tailwind v4, shadcn/ui |
| Backend | Express 5 |
| Database | PostgreSQL 16 + pgvector, Drizzle ORM |
| Auth | Clerk (`@clerk/react`, `@clerk/express`) |
| Routing | Wouter v3 |
| Data fetching | TanStack Query + Orval-generated hooks |
| Validation | Zod v4, drizzle-zod |
| API contract | OpenAPI 3.1 (spec-first, codegen via Orval) |
| Gateway provisioning | Render Deploy API |
| Encryption | AES-256-GCM (Node.js `crypto`) |
| Build | esbuild (API), Vite (frontend) |
| Full-text search | PostgreSQL `tsvector` + `ts_rank` |
| Vector search | pgvector (reserved for embedding upgrade) |

---

## Project Structure

```
openclaw-saas/
├── artifacts/
│   ├── api-server/          # Express 5 API (served at /api)
│   │   └── src/
│   │       ├── routes/      # Route handlers (tenants, skills, connectors, graphs, chat…)
│   │       ├── connectors/  # External API adapters (Crunchbase mock/real)
│   │       └── index.ts     # Server entry point
│   └── openclaw-saas/       # React+Vite SaaS frontend (served at /)
│       └── src/
│           ├── components/  # Layout, ConnectorsTab, KnowledgeTab, …
│           ├── pages/       # Landing, Dashboard, Agents, Skills, Billing
│           └── App.tsx
│
├── lib/
│   ├── db/                  # Drizzle ORM schema + migrations
│   ├── api-spec/            # OpenAPI 3.1 spec + Orval codegen config
│   ├── api-zod/             # Generated Zod validation schemas
│   ├── api-client-react/    # Generated TanStack Query hooks
│   ├── crypto-utils/        # AES-256-GCM encrypt/decrypt
│   ├── skill-contract/      # Skill/Connector TypeScript interfaces
│   └── gateway-provisioner/ # Render Deploy API client
│
├── scripts/                 # Utility scripts
├── render.yaml              # Render Blueprint (full-stack deploy)
├── pnpm-workspace.yaml      # Workspace + catalog pins
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 24+
- pnpm 9+
- PostgreSQL 16+ with the `pgvector` extension

### Install

```bash
git clone https://github.com/fjkiani/openclaw-saas.git
cd openclaw-saas
pnpm install
```

### Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Required secrets (see [Environment Variables](#environment-variables)).

### Push the database schema

```bash
pnpm --filter @workspace/db run push
```

### Start development servers

The project uses Replit workflows. Locally you can run each artifact directly:

```bash
# API server (port from $PORT env var, default 8080)
pnpm --filter @workspace/api-server run dev

# Frontend (port from $PORT env var, default 25593)
pnpm --filter @workspace/openclaw-saas run dev
```

### Regenerate API code after spec changes

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Typecheck

```bash
pnpm run typecheck        # full check (libs + all artifacts)
pnpm run typecheck:libs   # rebuild lib declaration files only
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | 32+ byte random string — used for AES-256-GCM credential encryption |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk frontend publishable key |
| `CLERK_SECRET_KEY` | Yes | Clerk backend secret key |
| `RENDER_API_KEY` | Yes | Render.com API key (Account Settings → API Keys) |
| `RENDER_OWNER_ID` | Yes | Render.com account/team ID |
| `CRUNCHBASE_API_KEY` | No | Crunchbase Basic API key — falls back to schema-accurate mock if absent |

---

## Key Features

### Agent Management

- Provision isolated OpenClaw Gateway instances on Render (one private service per tenant)
- Start / Stop / Delete agents from the dashboard
- Real-time status sync via Render webhooks

### Skill Catalog

- 791+ real skills parsed from the [awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) GitHub README
- 30 categories, 24-hour in-process TTL cache
- Per-agent skill install / uninstall
- Manual refresh via `POST /api/skills/refresh`

### Connector Registry

- AES-256-GCM encrypted credential storage (keys never returned in API responses)
- Phase 1: Crunchbase (investor/org search) — real API when key present, schema-accurate mock otherwise
- Phase 2: Gmail (outreach) — deferred
- Phase 3: LinkedIn (enrichment) — partner approval pending

### Knowledge Graphs

- Per-tenant document stores backed by PostgreSQL full-text search (`tsvector` + GIN index)
- PDF and plain-text upload with automatic chunking (512 tokens, 50-token overlap)
- `ts_rank`-based semantic search returning ranked excerpts
- pgvector column reserved for future embedding-based upgrade
- Graph types: Document Store, Investor Profiles, Data Room, Compliance, Brand Guidelines

### Agent Chat

- Persistent chat history stored in PostgreSQL (`chat_messages` table)
- Live proxying to gateway HTTP API when agent is running
- Graceful error messages on timeout or gateway-down states
- Animated thinking indicator, Enter-to-send, threaded message UI

### Billing

- Three-tier plan display: Free ($0) / Pro ($29/mo) / Enterprise (custom)
- Usage bar and upgrade CTAs

---

## API Reference

All endpoints are prefixed with `/api`. Authentication is required via Clerk session cookie or Bearer token unless noted.

### Tenants

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tenants` | List tenants for authenticated user |
| `POST` | `/api/tenants` | Provision a new agent (triggers Render API) |
| `GET` | `/api/tenants/:id` | Get tenant details |
| `DELETE` | `/api/tenants/:id` | Destroy tenant and Render service |
| `POST` | `/api/tenants/:id/start` | Start (resume) a stopped agent |
| `POST` | `/api/tenants/:id/stop` | Stop (suspend) a running agent |

### Chat

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tenants/:id/chat` | Get chat history |
| `POST` | `/api/tenants/:id/chat` | Send message (proxied to gateway when running) |

### Connectors

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/connectors` | List connector registry |
| `GET` | `/api/tenants/:id/connectors` | List installed connectors |
| `POST` | `/api/tenants/:id/connectors` | Install connector with encrypted credential |
| `DELETE` | `/api/tenants/:id/connectors/:connectorId` | Remove connector |

### Knowledge Graphs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tenants/:id/graphs` | List knowledge graphs |
| `POST` | `/api/tenants/:id/graphs` | Create a new graph |
| `DELETE` | `/api/tenants/:id/graphs/:graphId` | Delete graph and all documents |
| `GET` | `/api/tenants/:id/graphs/:graphId/documents` | List documents in a graph |
| `POST` | `/api/tenants/:id/graphs/:graphId/documents` | Upload PDF/TXT (multipart) |
| `POST` | `/api/tenants/:id/graphs/:graphId/query` | Full-text search |

### Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/skills` | Browse skill catalog (filterable by category/search) |
| `GET` | `/api/tenants/:id/skills` | List installed skills |
| `POST` | `/api/tenants/:id/skills` | Install skill on agent |
| `DELETE` | `/api/tenants/:id/skills/:skillId` | Uninstall skill |
| `POST` | `/api/skills/refresh` | Refresh catalog from GitHub |

### Webhooks

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/webhooks/render` | Render deploy/suspend/delete notifications |

---

## Database Schema

```
tenants              — agent instances (userId, name, status, wsEndpoint, renderServiceId…)
skills               — global catalog (791+ skills, name, category, stars, repoUrl)
tenant_skills        — many-to-many installed skills per agent
activity_entries     — audit log per agent (type, message, createdAt)
chat_messages        — per-tenant chat history (role: user|assistant|error, content)
connectors           — registry of available connector types (name, slug, credentialLabel)
tenant_connectors    — installed connectors with AES-256 encrypted credentials
knowledge_graphs     — per-tenant graph metadata (name, graphType, documentCount)
graph_documents      — uploaded documents (filename, mimeType, sizeBytes, status, chunkCount)
graph_chunks         — text chunks with tsvector (content, tsv GIN index, chunkIndex)
```

---

## Deployment

The repo ships a `render.yaml` Blueprint:

| Service | Type | Plan |
|---|---|---|
| `openclaw-api` | Web Service (Node) | Starter ($7/mo) |
| `openclaw-saas` | Static Site | Free |
| `openclaw-db` | PostgreSQL | Free |

**Deploy steps:**

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Blueprint**
3. Select the repo — Render reads `render.yaml` and creates all services
4. Set the required environment variables in the Render dashboard
5. Register `POST https://<your-api-domain>/api/webhooks/render` in Render → **Notifications**

Per-tenant gateways are provisioned dynamically as additional Render Starter private services when users create agents.

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `pnpm run typecheck` — must pass with zero errors
3. Follow the contract-first API workflow: edit `lib/api-spec/openapi.yaml` first, then run codegen
4. Never commit secrets or `.env` files
5. Open a pull request against `main`

---

## License

MIT
