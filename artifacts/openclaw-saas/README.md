# @workspace/openclaw-saas

React + Vite SaaS frontend for the OpenClaw control plane. Served at the root path `/`.

## Overview

- **Framework**: React 19 + Vite 7
- **Styling**: Tailwind CSS v4 + shadcn/ui components
- **Auth**: Clerk (`@clerk/react`) with `<ClerkProvider>` wrapping the app
- **Routing**: Wouter v3 (lightweight React router)
- **Data fetching**: TanStack Query v5 + Orval-generated React Query hooks
- **API communication**: Generated hooks from `@workspace/api-client-react`
- **Theme**: Dark terminal aesthetic — `font-mono` throughout, `bg-[#0a0a0f]` base

## Pages

| Route | File | Description |
|---|---|---|
| `/` | `pages/index.tsx` | Landing page with hero, pricing, architecture diagram |
| `/dashboard` | `pages/dashboard.tsx` | Agent stats, activity feed, quick links |
| `/agents` | `pages/agents/index.tsx` | Agent list with provision button |
| `/agents/:id` | `pages/agents/[id].tsx` | Agent detail (5 tabs — see below) |
| `/skills` | `pages/skills.tsx` | Global skill catalog with category filter |
| `/billing` | `pages/billing.tsx` | Plan display, usage bar, upgrade CTAs |

## Agent Detail Tabs

The agent detail page at `/agents/:id` has five tabs:

| Tab | Description |
|---|---|
| **Overview** | Instance info (status, memory, agents, WS endpoint) + activity log |
| **Skills** | Installed skills list + install from catalog modal |
| **Chat** | Live chat with the agent (proxied to gateway HTTP API) |
| **Connectors** | Install/remove external API connectors with encrypted credentials |
| **Knowledge** | Create knowledge graphs, upload PDFs, run full-text search |

## Key Components

```
src/
├── components/
│   ├── Layout.tsx          # Sidebar nav, PageHeader, StatusBadge, ActivityIcon
│   ├── ConnectorsTab.tsx   # Connector registry, install modal, phase roadmap
│   └── KnowledgeTab.tsx    # Graph CRUD, PDF upload, tsvector search UI
├── pages/
│   ├── index.tsx           # Landing page
│   ├── dashboard.tsx
│   ├── billing.tsx
│   ├── skills.tsx
│   └── agents/
│       ├── index.tsx
│       └── [id].tsx        # Tabbed agent detail page
├── hooks/
│   └── use-toast.ts        # shadcn toast hook
├── lib/
│   └── utils.ts            # cn() helper
└── App.tsx                 # Router, QueryClient, ClerkProvider setup
```

## Design System

- **Base color**: `#0a0a0f` (near-black)
- **Accent**: `hsl(var(--primary))` — cyan/blue
- **Font**: JetBrains Mono (monospace throughout)
- **Cards**: `bg-card border border-border rounded-lg`
- **Badges**: Micro text (`text-[10px] font-mono`) with colored borders
- **Borders**: `border-border` (subtle zinc)

Status colors:

| Status | Color |
|---|---|
| running | emerald-400 |
| stopped | zinc-400 |
| provisioning | amber-400 |
| error | red-400 |

## Adding a Page

1. Create the file in `src/pages/`
2. Add a `<Route>` in `src/App.tsx`
3. Add a nav link in `src/components/Layout.tsx`
4. Use generated hooks from `@workspace/api-client-react` for data fetching

## API Hook Pattern

```tsx
import { useListTenantConnectors, getListTenantConnectorsQueryKey } from "@workspace/api-client-react";

const { data, isLoading } = useListTenantConnectors(tenantId, {
  query: { queryKey: getListTenantConnectorsQueryKey(tenantId) },
});
```

For mutations:

```tsx
import { useInstallConnectorOnTenant } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const queryClient = useQueryClient();
const install = useInstallConnectorOnTenant({
  mutation: {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListTenantConnectorsQueryKey(tenantId) });
    },
  },
});

install.mutate({ id: tenantId, data: { connectorId: 1, credential: "key_abc123" } });
```

## Scripts

```bash
pnpm run dev        # Vite dev server (reads $PORT)
pnpm run build      # Vite production build
pnpm run typecheck  # tsc --noEmit
```
