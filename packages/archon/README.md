# @openclaw/archon

Archon workflow engine integration for OpenClaw — the Zeta Skill Factory.

## What This Is

This package contains the Archon configuration and workflow definitions for OpenClaw's skill generation pipeline. It is **not** a standalone service — it references the upstream `fjkiani/archon-zeta` fork which runs as a separate Render.com service.

## Workflows

### `zeta-skill-forge`

The core skill generation pipeline:

```
prompt → generate (Qwen3 Coder) → L0 validate (tsc) → fix loop (max 2) → L1-L4 benchmark → catalog
```

**Trigger via archon-factory:**
```bash
POST /archon/generate
{ "description": "Build a skill that fetches RSS headlines for a company" }
```

**Or directly via Archon REST API:**
```bash
POST http://archon-zeta.onrender.com/api/workflows/zeta-skill-forge/run
{ "message": "Build a skill that fetches RSS headlines for a company" }
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ARCHON_FACTORY_URL` | URL of the archon-factory service | `http://localhost:3002` |
| `BENCHMARK_SERVICE_URL` | URL of mcp-benchmarks FastAPI service | `http://localhost:8001` |
| `OPENCLAW_API_URL` | URL of openclaw-api service | `http://localhost:3001` |
| `OPENCLAW_SERVICE_TOKEN` | Service-to-service bearer token | — |
| `CLAUDE_BIN_PATH` | Path to Claude Code binary | auto-detected |
| `CLAUDE_USE_GLOBAL_AUTH` | Use global Claude auth | `true` |

## Local Development

```bash
# Install Archon CLI
curl -fsSL https://archon.diy/install | bash

# Run a workflow
archon run zeta-skill-forge "Build a skill that fetches RSS headlines"
```

## Deployment

Archon runs as a separate service (`archon-zeta` on Render.com) using the `fjkiani/archon-zeta` fork. The workflow YAML files in this package are committed to that fork's `.archon/workflows/` directory.

See `render.yaml` in the root of `openclaw-saas` for deployment configuration.
