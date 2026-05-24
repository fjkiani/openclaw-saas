/**
 * Benchmark client — calls the mcp-universe-benchmarks FastAPI service
 * to run L1-L4 skill benchmarks before allowing installation.
 */

const BENCHMARK_SERVICE_URL = process.env.BENCHMARK_SERVICE_URL || "http://localhost:8001";

export interface BenchmarkRunRequest {
  skill_id: number | string;
  skill_name: string;
  skill_description: string;
  skill_category: string;
  skill_inputs?: Record<string, unknown>;
  skill_outputs?: Record<string, unknown>;
  test_suite?: "standard" | "adversarial" | "quick";
}

export interface LevelResult {
  level: string;
  score: number;
  passed: number;
  total: number;
  weight: number;
  details: Record<string, unknown>[];
  llms_used: string[];
}

export interface BenchmarkResult {
  benchmark_id: string;
  skill_id: number | string;
  skill_name: string;
  status: "running" | "completed" | "failed";
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE" | null;
  overall_score: number | null;
  level_scores: Record<string, LevelResult> | null;
  llm_results: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

/**
 * Trigger a benchmark run (async — returns immediately with benchmark_id)
 */
export async function runBenchmark(req: BenchmarkRunRequest): Promise<{ benchmark_id: string; status: string }> {
  const res = await fetch(`${BENCHMARK_SERVICE_URL}/api/v1/benchmark/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Benchmark service error ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ benchmark_id: string; status: string }>;
}

/**
 * Run benchmark synchronously (waits up to 60s for result)
 */
export async function runBenchmarkSync(req: BenchmarkRunRequest): Promise<BenchmarkResult> {
  const res = await fetch(`${BENCHMARK_SERVICE_URL}/api/v1/benchmark/run-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(65_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Benchmark service error ${res.status}: ${text}`);
  }
  return res.json() as Promise<BenchmarkResult>;
}

/**
 * Poll for benchmark result by ID
 */
export async function getBenchmarkResult(benchmarkId: string): Promise<BenchmarkResult> {
  const res = await fetch(`${BENCHMARK_SERVICE_URL}/api/v1/benchmark/${benchmarkId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Benchmark service error ${res.status}: ${text}`);
  }
  return res.json() as Promise<BenchmarkResult>;
}

/**
 * Check if a skill passes the benchmark gate.
 * Returns the latest benchmark result for the skill, or null if never benchmarked.
 * CERTIFIED and CONDITIONAL grades pass. FAILED blocks installation.
 */
export async function checkBenchmarkGate(
  skillId: number,
  skillName: string,
  skillDescription: string,
  skillCategory: string,
): Promise<{ passes: boolean; result: BenchmarkResult | null; reason: string }> {
  try {
    // Run a quick sync benchmark
    const result = await runBenchmarkSync({
      skill_id: skillId,
      skill_name: skillName,
      skill_description: skillDescription,
      skill_category: skillCategory,
      test_suite: "quick",
    });

    if (result.grade === "FAILED") {
      return {
        passes: false,
        result,
        reason: `Skill scored ${result.overall_score}/100 — below passing threshold. Grade: FAILED`,
      };
    }

    if (result.grade === "INCONCLUSIVE") {
      // Allow install but warn
      return {
        passes: true,
        result,
        reason: "Benchmark inconclusive — proceeding with installation (manual review recommended)",
      };
    }

    return {
      passes: true,
      result,
      reason: `Skill passed benchmark with grade ${result.grade} (${result.overall_score}/100)`,
    };
  } catch (err: any) {
    // If benchmark service is unreachable, allow install but log warning
    console.warn("[BenchmarkClient] Service unreachable — skipping gate:", err?.message);
    return {
      passes: true,
      result: null,
      reason: "Benchmark service unavailable — install allowed (service offline)",
    };
  }
}

/**
 * Check benchmark service health
 */
export async function checkBenchmarkServiceHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BENCHMARK_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
