# openclaw-mlops (Cloudflare Workers)

Cloudflare-Workers-backed MLOps ingest + aggregate for the OpenClaw MCP fleet.
Every MCP tool invocation observed by `api-server/src/lib/mcps/trainingLoop.ts`
is fanned out via `lib/cloudflare/mlopsClient.ts` to this Worker, which persists
one row into a D1 database. The FE `/mlops` page reads back the aggregate.

## Free-tier ceiling (as of 2026)
- **Workers Free**: 100k requests/day, 10 ms CPU per request
- **D1 Free**: 5 GB storage, 5M rows read/day, 100k rows written/day
- **KV Free**: 100k reads + 1k writes/day
- **R2 Free**: 10 GB egress/month

Expected workload: a few thousand per-invocation writes/day + a few hundred
aggregate reads/day. Comfortably fits.

## Deploy

Prereqs: A Cloudflare account and `wrangler` CLI logged in (`wrangler login`).

```bash
cd packages/cloudflare-mlops
pnpm install

# 1. Create backing resources
wrangler d1 create openclaw-mcp-metrics
wrangler r2 bucket create openclaw-mcp-artifacts
wrangler kv:namespace create MCP_CONFIG
# Paste the returned database_id / kv id into wrangler.toml

# 2. Initialise D1 schema
pnpm d1:init

# 3. Set the ingest token (any random string; the api-server passes it as x-mlops-token)
wrangler secret put INGEST_TOKEN

# 4. Deploy
pnpm deploy
```

The Worker prints its URL after `deploy`. Set it in the api-server env:

```bash
CF_DRY_RUN=0
CF_MLOPS_WORKER_URL=https://openclaw-mlops.<subdomain>.workers.dev
CF_MLOPS_INGEST_TOKEN=<same-secret>
```

## Dry-run validate
```bash
pnpm deploy:dry
# → writes dist/index.js — safe to run without CF credentials
```

## Endpoints

| Method | Path                | Purpose                          |
|--------|---------------------|----------------------------------|
| GET    | /health             | Bindings + liveness              |
| POST   | /ingest             | One-row insert (x-mlops-token)   |
| GET    | /metrics/:slug      | Aggregate stats for one MCP      |
| GET    | /metrics            | Top 100 slugs by request volume  |
