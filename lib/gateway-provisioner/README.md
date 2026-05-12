# @workspace/gateway-provisioner

Render Deploy API client for provisioning, managing, and destroying per-tenant OpenClaw Gateway instances.

## Overview

Each OpenClaw tenant gets their own isolated gateway running as a Render Private Service. This package wraps the Render API to provide a clean async interface for the control plane.

## Architecture

```
OpenClaw SaaS API
       │
       ▼
gateway-provisioner
       │  REST API calls
       ▼
  render.com
       │  creates/manages
       ▼
openclaw-gateway-{tenantId}
  Render Private Service (Starter plan)
  - Isolated disk: /tenants/{id}
  - WebSocket endpoint (wss://…)
  - HTTP chat API (POST /chat)
  - Docker image: openclaw/gateway:latest
```

## Required Environment Variables

```
RENDER_API_KEY    — from render.com → Account Settings → API Keys
RENDER_OWNER_ID   — from render.com → Account Settings → Account ID
```

## API

### `provisionTenant(tenantId, token)`

Creates a new Render Private Service for the given tenant.

```typescript
const { serviceId, wsEndpoint } = await provisionTenant("tenant-123", "gateway-secret-token");
```

Returns `{ serviceId: string, wsEndpoint: string }`.

- Service name: `openclaw-gateway-{tenantId}`
- Service type: Render Private Service (not externally reachable)
- Plan: Starter ($7/mo)
- Environment variables automatically set: `TENANT_ID`, `GATEWAY_TOKEN`

### `startTenant(serviceId)`

Resumes a suspended Render service (maps to tenant "start" action).

```typescript
await startTenant("srv-abc123");
```

### `stopTenant(serviceId)`

Suspends a running Render service (maps to tenant "stop" action).

```typescript
await stopTenant("srv-abc123");
```

### `destroyTenant(serviceId)`

Permanently deletes a Render service. Irreversible.

```typescript
await destroyTenant("srv-abc123");
```

### `getServiceStatus(serviceId)`

Polls the Render API for the current service state.

```typescript
const status = await getServiceStatus("srv-abc123");
// → "running" | "stopped" | "provisioning"
```

## Status Sync via Webhooks

The provisioner functions trigger async Render operations. Actual status changes are delivered via Render webhook notifications to `POST /api/webhooks/render`. The webhook handler maps events to tenant status updates:

| Render Event | Tenant Status |
|---|---|
| `deploy_ended` (success) | `running` |
| `service_suspended` | `stopped` |
| `service_deleted` | `stopped` (clears renderServiceId) |

Register your webhook in the Render dashboard under **Settings → Notifications → Webhook** and point it to `https://<your-api-domain>/api/webhooks/render`.

## Error Handling

All functions throw on non-2xx Render API responses. The calling route handler is responsible for catching and translating errors into appropriate HTTP responses and activity log entries.
