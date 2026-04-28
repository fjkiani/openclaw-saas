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
- `pnpm --filter @workspace/scripts run seed-skills` — seed the skills catalog

## Architecture

```
OpenClaw SaaS (this app)
  ├── Auth (Clerk)
  ├── Billing (plan/usage)
  ├── Agent Management (tenants CRUD + start/stop)
  └── Skill Catalog (30 seeded skills, ClawHub browser)
```

## Database Schema

- `tenants` — agent instances per user (userId, name, status, wsEndpoint, etc.)
- `skills` — global skill catalog (30 seeded skills across 8 categories)
- `tenant_skills` — many-to-many installed skills per agent
- `activity_entries` — audit log per agent

## Packages

| Package | Path | Description |
|---|---|---|
| `@workspace/db` | `lib/db` | Drizzle ORM + PostgreSQL |
| `@workspace/api-spec` | `lib/api-spec` | OpenAPI spec + codegen config |
| `@workspace/api-zod` | `lib/api-zod` | Generated Zod schemas |
| `@workspace/api-client-react` | `lib/api-client-react` | Generated React Query hooks |
| `@workspace/scripts` | `scripts` | Utility scripts (seed-skills, etc.) |

## Features Implemented

- Landing page with pricing tiers (Free $0 / Pro $29 / Enterprise custom)
- Clerk auth (sign-in, sign-up, user session)
- Dashboard with agent stats, activity feed, quick links
- Agent management: provision, start, stop, delete, detail view
- Skill catalog: browse 30 skills, search, filter by category, install on agent
- Billing page: current plan, usage bar, upgrade CTAs
- 8 skill categories: BioTech Research, DevOps, Finance, Legal, Data Analytics, Writing, Web Scraping, Communication
