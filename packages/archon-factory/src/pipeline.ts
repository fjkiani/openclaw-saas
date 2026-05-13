import { generateSkill, fixSkill, type GeneratedSkill } from "./skillGenerator.js";
import { validateSkill } from "./skillValidator.js";
import { updateRun, type FactoryRun } from "./runStore.js";
import { config } from "./config.js";

const MAX_FIX_RETRIES = 2;

export async function runSkillForgePipeline(
  runId: string,
  description: string
): Promise<void> {
  updateRun(runId, { status: "generating", stage: "Generating skill with Qwen3 Coder..." });

  let skill: GeneratedSkill;

  // Step 1: Generate
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

  // Step 2: L0 Validate + Fix loop
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

  // Step 3: L1-L4 Benchmark
  updateRun(runId, { status: "benchmarking", stage: "Running L1-L4 benchmark via OpenRouter..." });

  let benchmarkResult: FactoryRun["benchmarkResult"];
  try {
    const benchRes = await fetch(
      `${config.benchmarkServiceUrl}/api/v1/benchmark/run-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill_id: `archon-${runId.slice(0, 8)}`,
          skill_name: skill.name,
          skill_description: skill.description,
          skill_category: skill.category ?? "GENERAL",
          skill_inputs: skill.inputSchema,
          skill_outputs: skill.outputSchema,
          test_suite: "standard",
        }),
        signal: AbortSignal.timeout(120_000), // 2 min timeout
      }
    );

    if (!benchRes.ok) {
      throw new Error(`Benchmark service returned ${benchRes.status}`);
    }

    benchmarkResult = (await benchRes.json()) as FactoryRun["benchmarkResult"];
    updateRun(runId, { benchmarkResult, stage: `Benchmark complete — grade: ${benchmarkResult?.grade}` });
  } catch (err) {
    // Soft-fail: benchmark service may be offline
    benchmarkResult = { grade: "INCONCLUSIVE", overall_score: null };
    updateRun(runId, {
      benchmarkResult,
      stage: "Benchmark service unavailable — proceeding with INCONCLUSIVE grade",
    });
  }

  // Step 4: Catalog insert (if CERTIFIED or CONDITIONAL)
  const grade = benchmarkResult?.grade ?? "INCONCLUSIVE";
  if (grade === "CERTIFIED" || grade === "CONDITIONAL") {
    updateRun(runId, { status: "cataloging", stage: "Inserting skill into OpenClaw catalog..." });

    try {
      const catalogRes = await fetch(`${config.openclawApiUrl}/api/skills`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openclawServiceToken}`,
        },
        body: JSON.stringify({
          name: skill.name,
          slug: skill.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
          description: skill.description,
          category: skill.category ?? "General",
          featured: false,
          tags: ["archon", "generated"],
          source: "archon",
          implementation: skill.implementation,
          archonRunId: runId,
        }),
      });

      if (catalogRes.ok) {
        const catalogData = (await catalogRes.json()) as { id?: number };
        updateRun(runId, { cataloged: true, skillId: catalogData.id });
      }
    } catch {
      // Soft-fail: catalog insert is best-effort
      updateRun(runId, { cataloged: false });
    }
  }

  updateRun(runId, {
    status: "completed",
    stage: "done",
    completedAt: Date.now(),
  });
}
