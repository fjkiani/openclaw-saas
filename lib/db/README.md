# @workspace/db

Drizzle ORM schema definitions and PostgreSQL client for OpenClaw SaaS.

## Overview

- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Driver**: `pg` (node-postgres)
- **Extensions**: `pgvector` (vector similarity search, reserved for embedding upgrade)
- **Migrations**: Drizzle Kit (`pnpm run push` for dev, `pnpm run generate` + `pnpm run migrate` for prod)

## Schema

### `tenants`

Per-user agent instances provisioned on Render.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `userId` | text | Clerk user ID |
| `name` | text | Agent display name |
| `description` | text? | Optional description |
| `status` | text | `provisioning` \| `running` \| `stopped` \| `error` |
| `wsEndpoint` | text? | WebSocket URL assigned by Render |
| `renderServiceId` | text? | Render service ID for API calls |
| `gatewayToken` | text? | Auth token for gateway HTTP API |
| `agentCount` | integer | Number of sub-agents (default 0) |
| `memoryUsedKb` | integer | Memory usage in KB |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | Auto-updated on change |

### `skills`

Global skill catalog synced from GitHub.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Skill display name |
| `category` | text | Category slug |
| `description` | text? | |
| `repoUrl` | text? | GitHub URL |
| `stars` | integer | Star count |
| `createdAt` | timestamptz | |

### `tenant_skills`

Many-to-many: installed skills per agent.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | integer FK → tenants | |
| `skillId` | integer FK → skills | |
| `installedAt` | timestamptz | |

### `activity_entries`

Audit log per agent.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | integer FK → tenants | |
| `type` | text | `provision` \| `start` \| `stop` \| `skill_install` \| `error` \| … |
| `message` | text | Human-readable log entry |
| `createdAt` | timestamptz | |

### `chat_messages`

Per-tenant chat history.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | integer FK → tenants | |
| `role` | text | `user` \| `assistant` \| `error` |
| `content` | text | Message body |
| `createdAt` | timestamptz | |

### `connectors`

Registry of available connector types (seeded on migration).

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Display name (e.g. "Crunchbase") |
| `slug` | text UNIQUE | Machine ID (e.g. "crunchbase") |
| `description` | text | What the connector does |
| `credentialLabel` | text | Label shown in install UI (e.g. "API Key") |
| `createdAt` | timestamptz | |

Seeded records: Crunchbase (id=1), Gmail (id=2), LinkedIn (id=3).

### `tenant_connectors`

Installed connectors with encrypted credentials.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | integer FK → tenants | |
| `connectorId` | integer FK → connectors | |
| `encryptedCredential` | text | AES-256-GCM encrypted API key (see `lib/crypto-utils`) |
| `verified` | boolean | Whether the credential has been validated against the API |
| `createdAt` | timestamptz | |

### `knowledge_graphs`

Per-tenant document stores.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `tenantId` | integer FK → tenants | |
| `name` | text | Graph display name |
| `description` | text? | |
| `graphType` | text | `document` \| `investor_profiles` \| `data_room` \| `compliance` \| `brand` |
| `documentCount` | integer | Cached count (default 0) |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | |

### `graph_documents`

Uploaded files belonging to a knowledge graph.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `graphId` | integer FK → knowledge_graphs | |
| `filename` | text | Original file name |
| `mimeType` | text | `application/pdf` \| `text/plain` |
| `sizeBytes` | integer | File size |
| `status` | text | `processing` \| `ready` \| `error` |
| `chunkCount` | integer | Number of text chunks extracted |
| `errorMessage` | text? | Set on processing failure |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | Auto-updated |

### `graph_chunks`

Text chunks from processed documents. Indexed for full-text search.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `documentId` | integer FK → graph_documents | |
| `graphId` | integer FK → knowledge_graphs | |
| `chunkIndex` | integer | Position in document |
| `content` | text | Raw text content (~512 chars) |
| `tsv` | tsvector | **Generated always** from `content` (GIN indexed) |
| `createdAt` | timestamptz | |

The `tsv` column is a PostgreSQL generated column:
```sql
tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```

A GIN index on `tsv` makes full-text search fast at any scale.

## Usage

```typescript
import { db, tenantsTable, skillsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Query
const tenants = await db
  .select()
  .from(tenantsTable)
  .where(eq(tenantsTable.userId, userId));

// Insert
const [tenant] = await db
  .insert(tenantsTable)
  .values({ userId, name, status: "provisioning" })
  .returning();

// Update
await db
  .update(tenantsTable)
  .set({ status: "running" })
  .where(eq(tenantsTable.id, id));
```

## Scripts

```bash
pnpm run push       # Push schema to database (dev, no migration files)
pnpm run generate   # Generate migration SQL files
pnpm run migrate    # Apply pending migrations (production)
pnpm run studio     # Open Drizzle Studio GUI
```
