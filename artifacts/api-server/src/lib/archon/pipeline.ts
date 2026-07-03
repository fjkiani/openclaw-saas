/**
 * pipeline.ts — Archon skill forge pipeline (in-process on openclaw-api).
 *
 * Stages:
 *   1. Generate  — Qwen3 Coder 480B via OpenRouter
 *   2. L0 Validate + Fix loop — TypeScript syntax + required exports
 *   3. L1-L4 Benchmark — internal LLM judge (no external service)
 *   4. Catalog insert — direct drizzle DB insert (no HTTP, no service token)
 */

import { generateSkill, fixSkill, type GeneratedSkill } from "./skillGenerator";
import { validateSkill } from "./skillValidator";
import { benchmarkSkill } from "./benchmarkRunner";
import { updateRun, type FactoryRun } from "./runStore";

const MAX_FIX_RETRIES = 2;

export async function runSkillForgePipeline(runId: string, description: string): Promise<void> {
  updateRun(runId, { status: "generating", stage: "Generating skill with Qwen3 Coder 480B..." });

  let skill: GeneratedSkill;

  // ── Step 1: Generate ──────────────────────────────────────────────────────
  try {
    skill = await generateSkill(description);
    updateRun(runId, { skill, stage: "Skill generated — running L0 validation..." });
  } catch (err) {
    updateRun(runId, {
      status: "failed",
      error: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // ── Step 2: L0 Validate + Fix loop ───────────────────────────────────────
  updateRun(runId, { status: "validating", stage: "L0: Checking TypeScript syntax and exports..." });

  let l0 = validateSkill(skill);
  let retryCount = 0;

  while (!l0.l0_pass && retryCount < MAX_FIX_RETRIES) {
    retryCount++;
    updateRun(runId, {
      status: "fixing",
      stage: `L0 failed — fixing (attempt ${retryCount}/${MAX_FIX_RETRIES})...`,
      l0Result: l0,
      retryCount,
    });
    try {
      skill = await fixSkill(skill, l0.error ?? "Unknown validation error");
      updateRun(runId, { skill });
      l0 = validateSkill(skill);
    } catch (err) {
      updateRun(runId, {
        status: "failed",
        error: `Fix attempt ${retryCount} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }

  updateRun(runId, { l0Result: l0, retryCount });

  if (!l0.l0_pass) {
    updateRun(runId, {
      status: "failed",
      error: `L0 validation failed after ${MAX_FIX_RETRIES} fix attempts: ${l0.error}`,
    });
    return;
  }

  // ── Step 3: L1-L4 Benchmark (internal LLM judge) ─────────────────────────
  updateRun(runId, {
    status: "benchmarking",
    stage: "Running L1-L4 benchmark (LLM alignment judge + static analysis)...",
  });

  let benchmarkResult: FactoryRun["benchmarkResult"];
  try {
    const result = await benchmarkSkill(skill);
    benchmarkResult = {
      grade: result.grade,
      overall_score: result.overall_score,
      level_scores: result.level_scores as Record<string, unknown>,
    };
    updateRun(runId, {
      benchmarkResult,
      stage: `Benchmark complete — grade: ${result.grade} (L4: ${result.overall_score}/10) | ${result.l1_reasoning ?? ""}`,
    });
  } catch (err) {
    benchmarkResult = { grade: "INCONCLUSIVE", overall_score: null };
    updateRun(runId, {
      benchmarkResult,
      stage: `Benchmark error — INCONCLUSIVE: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── Step 4: Catalog insert (CERTIFIED or CONDITIONAL only) ───────────────
  const grade = benchmarkResult?.grade ?? "INCONCLUSIVE";

  if (grade === "CERTIFIED" || grade === "CONDITIONAL") {
    updateRun(runId, { status: "cataloging", stage: "Inserting skill into OpenClaw catalog (direct DB)..." });

    try {
      const slug = skill.name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 80);

      // Direct DB insert — no HTTP round-trip (in-process with api-server)
      const { db, skillsTable } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");

      const [inserted] = await db
        .insert(skillsTable)
        .values({
          name: skill.name,
          slug,
          description: skill.description,
          category: skill.category ?? "General",
          featured: false,
          tags: ["archon", "generated", grade.toLowerCase()],
          source: "archon",
          implementation: skill.implementation,
          archonRunId: runId,
        })
        .onConflictDoUpdate({
          target: skillsTable.slug,
          set: {
            name: sql`EXCLUDED.name`,
            description: sql`EXCLUDED.description`,
            source: sql`EXCLUDED.source`,
            implementation: sql`EXCLUDED.implementation`,
            archonRunId: sql`EXCLUDED.archon_run_id`,
          },
        })
        .returning();

      updateRun(runId, { cataloged: true, skillId: inserted.id });
    } catch (err) {
      updateRun(runId, {
        cataloged: false,
        stage: `Catalog insert error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    updateRun(runId, {
      cataloged: false,
      stage: `Grade ${grade} — skill not cataloged (CONDITIONAL or CERTIFIED required)`,
    });
  }

  updateRun(runId, { status: "completed", stage: "done", completedAt: Date.now() });
}
