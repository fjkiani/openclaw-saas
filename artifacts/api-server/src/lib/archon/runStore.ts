import { randomUUID } from "crypto";

export type RunStatus =
  | "pending" | "generating" | "validating" | "fixing"
  | "benchmarking" | "cataloging" | "completed" | "failed";

export interface FactoryRun {
  runId: string;
  description: string;
  status: RunStatus;
  stage: string;
  skill?: {
    name: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    implementation: string;
  };
  l0Result?: { l0_pass: boolean; error?: string };
  benchmarkResult?: {
    grade: string;
    overall_score: number | null;
    level_scores?: Record<string, unknown>;
  };
  cataloged?: boolean;
  skillId?: number;
  retryCount: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

const _store = new Map<string, FactoryRun>();
const MAX_RUNS = 200;

export function createRun(description: string): FactoryRun {
  const run: FactoryRun = {
    runId: randomUUID(),
    description,
    status: "pending",
    stage: "queued",
    retryCount: 0,
    createdAt: Date.now(),
  };
  _store.set(run.runId, run);
  if (_store.size > MAX_RUNS) {
    const oldest = [..._store.entries()]
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .slice(0, 50);
    for (const [k] of oldest) _store.delete(k);
  }
  return run;
}

export function getRun(runId: string): FactoryRun | undefined {
  return _store.get(runId);
}

export function updateRun(runId: string, updates: Partial<FactoryRun>): void {
  const run = _store.get(runId);
  if (run) Object.assign(run, updates);
}

export function listRuns(limit = 20): FactoryRun[] {
  return [..._store.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
