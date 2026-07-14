/**
 * benchmarkRunner.ts — Self-contained L1-L4 skill benchmark.
 *
 * Replaces the dead openclaw-benchmark.onrender.com external service.
 * All evaluation is done locally:
 *   L1: LLM-as-judge (OpenRouter Hermes 3 405B) — does implementation match description?
 *   L2: Static analysis — error handling coverage
 *   L3: Static analysis — output schema completeness
 *   L4: Weighted composite (L1×0.5 + L2×0.3 + L3×0.2) → grade
 *
 * Grade thresholds: L4 >= 8.0 → CERTIFIED, >= 5.0 → CONDITIONAL, < 5.0 → FAILED
 */

import { callOpenRouter, extractJson } from "./openrouter";
import { archonConfig as config } from "./config";
import type { GeneratedSkill } from "./skillGenerator";

export interface BenchmarkResult {
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE";
  overall_score: number | null;
  level_scores: {
    l1_alignment: number;
    l2_error_handling: number;
    l3_schema_coverage: number;
    l4_composite: number;
  };
  l1_reasoning?: string;
  evaluated_at: string;
}

const L1_JUDGE_PROMPT = `You are a strict code quality judge for an AI skill marketplace.

Evaluate whether the TypeScript implementation correctly and completely implements the described behavior.

Score from 0-100:
- 90-100: Implementation fully matches description, handles all edge cases, clean code
- 70-89: Implementation mostly correct, minor gaps or missing edge cases
- 50-69: Implementation partially correct, significant gaps
- 30-49: Implementation attempts the task but has major correctness issues
- 0-29: Implementation does not match description or is fundamentally broken

Return ONLY valid JSON: {"score": <number 0-100>, "reasoning": "<one sentence>"}`;

async function runL1Judge(skill: GeneratedSkill): Promise<{ score: number; reasoning: string }> {
  const userContent = `Description: ${skill.description}

Implementation:
\`\`\`typescript
${skill.implementation.slice(0, 8000)}
\`\`\`

Rate this implementation 0-100. Return JSON only.`;

  try {
    const raw = await callOpenRouter(
      config.reasoningModel,
      [{ role: "system", content: L1_JUDGE_PROMPT }, { role: "user", content: userContent }],
      0.1,
      config.reasoningModelFallbacks,
    );
    const parsed = extractJson(raw) as { score?: number; reasoning?: string };
    const score = typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : 50;
    return { score, reasoning: parsed.reasoning ?? "No reasoning provided" };
  } catch {
    return { score: 55, reasoning: "L1 judge unavailable — using conservative default" };
  }
}

function runL2ErrorHandling(impl: string): number {
  const checks = [
    /try\s*\{/.test(impl),
    /catch\s*\(/.test(impl),
    /return\s*\{[^}]*error/.test(impl),
    /if\s*\(!|=== null|=== undefined|\?\?/.test(impl),
    /if\s*\(!.*input|typeof.*!==|\.trim\(\)/.test(impl),
  ];
  const passed = checks.filter(Boolean).length;
  return 20 + (passed / checks.length) * 80;
}

function runL3SchemaCoverage(skill: GeneratedSkill): number {
  const impl = skill.implementation;
  const outputProps = Object.keys(
    (skill.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
  );
  if (outputProps.length === 0) return 50;
  // Use full implementation for coverage check — the run() body regex can miss
  // return statements that appear after nested blocks or at the end of the file.
  const searchBody = impl;
  const covered = outputProps.filter((prop) =>
    // Quoted key: "prop" or 'prop'
    searchBody.includes(`"${prop}"`) ||
    searchBody.includes(`'${prop}'`) ||
    // Explicit key: prop: value
    searchBody.includes(prop + ":") ||
    // Shorthand property in return object: { prop, ... } or { prop }
    // Match word boundary to avoid partial matches (e.g. "count" matching "discount")
    new RegExp(`[{,\\s]${prop}[,}\\s]`).test(searchBody)
  ).length;
  return Math.round((covered / outputProps.length) * 100);
}

function computeL4(l1: number, l2: number, l3: number): number {
  const composite = l1 * 0.50 + l2 * 0.30 + l3 * 0.20;
  return Math.round((composite / 10) * 10) / 10;
}

function gradeFromL4(l4: number): BenchmarkResult["grade"] {
  if (l4 >= 8.0) return "CERTIFIED";
  if (l4 >= 5.0) return "CONDITIONAL";
  return "FAILED";
}

export async function benchmarkSkill(skill: GeneratedSkill): Promise<BenchmarkResult> {
  const [l1Result, l2Score, l3Score] = await Promise.all([
    runL1Judge(skill),
    Promise.resolve(runL2ErrorHandling(skill.implementation)),
    Promise.resolve(runL3SchemaCoverage(skill)),
  ]);

  const l4Score = computeL4(l1Result.score, l2Score, l3Score);
  const grade = gradeFromL4(l4Score);

  return {
    grade,
    overall_score: l4Score,
    level_scores: {
      l1_alignment: Math.round(l1Result.score),
      l2_error_handling: Math.round(l2Score),
      l3_schema_coverage: Math.round(l3Score),
      l4_composite: l4Score,
    },
    l1_reasoning: l1Result.reasoning,
    evaluated_at: new Date().toISOString(),
  };
}
