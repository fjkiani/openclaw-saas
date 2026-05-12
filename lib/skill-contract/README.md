# @workspace/skill-contract

TypeScript interface definitions for OpenClaw skills and connectors. Provides the shared contract between the SaaS control plane and per-tenant gateway instances.

## Exports

### `Skill`

The canonical interface for a skill loaded into an OpenClaw agent runtime.

```typescript
interface Skill {
  id: string;                    // Unique slug, e.g. "web-search"
  name: string;                  // Display name
  description: string;           // Short description shown in catalog
  category: SkillCategory;       // Taxonomy enum
  version: string;               // Semver string
  entrypoint: string;            // Module path or URL
  connectors?: ConnectorDef[];   // Required external APIs
  configSchema?: Record<string, unknown>;  // JSON Schema for config
}
```

### `SkillCategory`

Enum of skill taxonomy values aligned with the awesome-openclaw-skills catalog.

```typescript
type SkillCategory =
  | "research"
  | "outreach"
  | "data-enrichment"
  | "document-processing"
  | "communication"
  | "analytics"
  | "automation"
  | "compliance"
  | "finance"
  | "hr"
  | "legal"
  | "marketing"
  | "sales"
  | "other";
```

### `SkillOutput`

Typed return structure from a skill execution.

```typescript
interface SkillOutput {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: {
    tokensUsed?: number;
    latencyMs?: number;
    source?: string;
  };
}
```

### `ConnectorDef`

Describes an external API dependency that a skill requires.

```typescript
interface ConnectorDef {
  slug: string;          // Matches connectors.slug in the DB
  name: string;          // Human-readable connector name
  required: boolean;     // Whether the skill fails without this connector
  scopes?: string[];     // OAuth scopes needed (if applicable)
}
```

## Usage

```typescript
import type { Skill, SkillCategory, SkillOutput, ConnectorDef } from "@workspace/skill-contract";

const webSearchSkill: Skill = {
  id: "web-search",
  name: "Web Search",
  description: "Search the web using a configurable search engine",
  category: "research",
  version: "1.0.0",
  entrypoint: "@openclaw/skill-web-search",
  connectors: [],
};
```

## Notes

This package contains TypeScript interfaces only — zero runtime code, zero dependencies. It is a pure type contract for use across the monorepo and in gateway implementations.
