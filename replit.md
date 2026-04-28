# OpenClaw SaaS Workspace

## Overview

Multi-tenant SaaS control plane for the OpenClaw AI agent runtime. Built on a pnpm workspace monorepo.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec in `lib/api-spec/openapi.yaml`)
- **Build**: esbuild (CJS bundle for API server)
- **Frontend**: React + Vite + Tailwind v4 + shadcn/ui
- **Auth**: Clerk (`@clerk/react`, `@clerk/express`, `@clerk/themes`)
- **Routing**: Wouter v3
- **Data fetching**: TanStack Query + generated Orval hooks
- **Gateway provisioning**: Render Deploy API (`lib/gateway-provisioner`)

## Artifacts

| Artifact | Path | Description |
|---|---|---|
| `openclaw-saas` | `/` | React+Vite SaaS frontend |
| `api-server` | `/api` | Express API server |

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — rebuild lib declaration files (run after schema changes)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `curl -X POST localhost:80/api/skills/refresh` — refresh skill catalog from GitHub

## Architecture

```
OpenClaw SaaS (this app)
  ├── Auth (Clerk)
  ├── Billing (plan/usage)
  ├── Agent Management (tenants CRUD + start/stop via Render Deploy API)
  └── Skill Catalog (791+ real skills from GitHub, 24hr TTL refresh)

Per-tenant Gateway (Render Private Services):
  openclaw-gateway-{tenantId} — Docker container on Render starter plan
  - Provisioned via POST /api/tenants → Render API → private service
  - Status sync via POST /api/webhooks/render (Render webhook notifications)
  - Each tenant gets its own isolated disk: /tenants/{id}
```

## Database Schema

- `tenants` — agent instances per user (userId, name, status, wsEndpoint, renderServiceId, gatewayToken, etc.)
- `skills` — global skill catalog (791+ real skills, refreshed from GitHub awesome-openclaw-skills)
- `tenant_skills` — many-to-many installed skills per agent
- `activity_entries` — audit log per agent
- `chat_messages` — per-tenant chat history (id, tenantId, role: user|assistant|error, content, createdAt)

## Packages

| Package | Path | Description |
|---|---|---|
| `@workspace/db` | `lib/db` | Drizzle ORM + PostgreSQL |
| `@workspace/api-spec` | `lib/api-spec` | OpenAPI spec + codegen config |
| `@workspace/api-zod` | `lib/api-zod` | Generated Zod schemas |
| `@workspace/api-client-react` | `lib/api-client-react` | Generated React Query hooks |
| `@workspace/gateway-provisioner` | `lib/gateway-provisioner` | Render Deploy API client |
| `@workspace/scripts` | `scripts` | Utility scripts |

## Gateway Provisioner (`lib/gateway-provisioner`)

Uses the Render Deploy API to manage per-tenant OpenClaw Gateway instances.

Required env vars (set in Render dashboard or `.env`):
- `RENDER_API_KEY` — from render.com → Account Settings → API Keys
- `RENDER_OWNER_ID` — from render.com → Account Settings → Account ID

Functions:
- `provisionTenant(tenantId, token)` — creates a Render private service, returns `{ serviceId, wsEndpoint }`
- `startTenant(serviceId)` — resumes a suspended Render service
- `stopTenant(serviceId)` — suspends a Render service
- `destroyTenant(serviceId)` — deletes a Render service permanently
- `getServiceStatus(serviceId)` — returns `"running"` | `"stopped"` | `"provisioning"`

## Webhook Integration

Register `POST /api/webhooks/render` in the Render dashboard under Notifications. The endpoint handles:
- `deploy_ended` → marks tenant `status = "running"`
- `service_suspended` → marks tenant `status = "stopped"`
- `service_deleted` → marks tenant `status = "stopped"`, clears renderServiceId

## Skills Catalog

791+ real skills loaded from `https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md` (5,200+ community skills). 30 categories. 24hr in-process TTL cache. Refreshed on first request if DB is empty. Manual refresh via `POST /api/skills/refresh`.

## Deployment (render.yaml)

`render.yaml` at repo root defines the full Blueprint:
- `openclaw-api` — Node web service (Starter $7/mo)
- `openclaw-saas` — Static site (Free)
- `openclaw-db` — PostgreSQL (Free tier)

Connect repo at render.com → New → Blueprint to deploy. Per-tenant gateways are provisioned dynamically as additional Starter private services.

## Features Implemented

- Landing page with pricing tiers (Free $0 / Pro $29 / Enterprise custom)
- Clerk auth (sign-in, sign-up, user session)
- Dashboard with agent stats, activity feed, quick links
- Agent management: provision via Render API, start/stop/delete, detail view
- Skill catalog: 791+ real skills from GitHub, search, filter by category, install on agent
- Billing page: current plan, usage bar, upgrade CTAs
- Real gateway provisioning: no setTimeout stubs, no hardcoded wsEndpoint strings
- Render webhook handler for async status sync
- Agent chat: `GET/POST /api/tenants/:id/chat` — stores messages in DB, proxies POST to gateway HTTP API when running; graceful error messages on timeout/gateway-down; tabbed agent detail page (Overview | Skills | Chat) with threaded message UI, animated thinking dots, Enter-to-send
