# @workspace/api-spec

OpenAPI 3.1 specification and Orval codegen configuration for the OpenClaw SaaS API.

## Overview

This package is the single source of truth for the API contract. The spec drives:

1. **`@workspace/api-zod`** — Zod validation schemas for all request/response bodies
2. **`@workspace/api-client-react`** — TanStack Query React hooks for every endpoint

The API server validates inputs against the Zod schemas. The frontend uses the React Query hooks for type-safe data fetching.

## Files

```
lib/api-spec/
├── openapi.yaml        # OpenAPI 3.1 specification
├── orval.config.ts     # Orval codegen configuration
└── package.json
```

## Codegen

```bash
pnpm --filter @workspace/api-spec run codegen
```

This regenerates:
- `lib/api-zod/src/generated/api.ts` — all Zod schemas
- `lib/api-client-react/src/generated/api.ts` — all React Query hooks + fetch functions

**Important**: Run codegen after any change to `openapi.yaml`. The generated files are committed to the repo.

## Workflow for Adding an Endpoint

1. **Edit `openapi.yaml`** — add the path, operation, and component schemas
2. **Run codegen** — `pnpm --filter @workspace/api-spec run codegen`
3. **Write the route** — import the generated Zod schemas for validation
4. **Write the frontend** — import the generated hooks for data fetching
5. **Typecheck** — `pnpm run typecheck` must pass

## Codegen Config (Orval)

The Zod output uses `mode: "single"` with an absolute target path. Do not change `info.title` in the OpenAPI spec — it controls the generated filenames.

```typescript
// orval.config.ts (simplified)
export default defineConfig({
  "api-zod": {
    output: {
      target: path.resolve(apiZodSrc, "generated", "api.ts"),
      client: "zod",
      mode: "single",
    },
    input: { target: "./openapi.yaml" },
  },
  "api-client-react": {
    output: {
      target: path.resolve(apiClientSrc, "generated", "api.ts"),
      client: "react-query",
      mode: "single",
    },
    input: { target: "./openapi.yaml" },
  },
});
```

## API Surface

See the root [README.md](../../README.md#api-reference) for the full endpoint list, or open `openapi.yaml` directly.
