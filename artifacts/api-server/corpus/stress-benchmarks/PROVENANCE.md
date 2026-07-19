# Agent Robustness Benchmark Corpus — Provenance

## Source

- **Repo**: `github.com/fjkiani/mcp-universe-benchmarks`
- **Branch**: `sprint-4-stress-suite`
- **Commit**: `d1e22ab` (Gemma-4 model additions)
- **Harness entrypoint**: `scripts/stress.py`

## Contents

- `runs.jsonl` — **909 rows**, one row per (model × task × perturbation × run_id)
- `stress_summary.json` — precomputed rollup (leaderboard + per-category
  latency percentiles). Written by the harness at end-of-sweep. Present as
  a fallback if `runs.jsonl` cannot be parsed.

## Distribution

- **Models: 11** — covering `gemini/gemma-4-*`, `gemini/gemini-2.5-*`,
  `groq/*`, and `openrouter/*` families.
- **Categories: 5** — baseline (262 runs), concurrency (62), adversarial (352),
  faults (33), ratelimit (200).
- **Governance-traps highlights** — Gemma-4-26b-a4b-it and Gemma-4-31b-it both
  passed 4/8 = 50% of governance_traps tasks, topping the leaderboard for that
  domain at the time of capture.

## Row schema

The route layer trusts these 23 fields exactly. Any harness change that adds,
renames, or drops fields must bump the JSONL and update
`lib/stress-benchmarks/types.ts` in the same PR.

```
worker_id, category, perturbation_id, task, domain, model, run_id,
passed, failure_class, evaluator, feedback,
iterations, max_iterations, tool_calls, per_tool_calls, finish_reason,
token_usage { prompt, completion, total },
latency_seconds, latency_ms,
error, traceback, response_preview, timestamp
```

## Regeneration

To regenerate this corpus:

```bash
git clone https://github.com/fjkiani/mcp-universe-benchmarks
cd mcp-universe-benchmarks
git checkout sprint-4-stress-suite
python scripts/stress.py \
  --categories baseline,concurrency,adversarial,faults,ratelimit \
  --models gemini/gemma-4-26b-a4b-it,gemini/gemma-4-31b-it,gemini/gemini-2.5-flash,groq/llama-3.3-70b-versatile,...
```

Then copy the produced `runs.jsonl` + `stress_summary.json` back into this
directory and update the commit hash above.

## What this corpus does NOT include

- No live re-runs. The frontend cannot trigger new stress runs from this
  data — it is read-only observational data.
- No per-tool call bodies, only counts. Full trace capture is out of scope.
- No prompt/response bodies beyond `response_preview` (first ~200 chars).
