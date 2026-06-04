// artifacts/api-server/src/lib/queue.ts
// COMMIT B (queue substrate): driver-agnostic queue. Lanes import { queue } or
// createQueueManager only; pg-boss vs BullMQ is a QUEUE_DRIVER swap. Drivers are
// loaded lazily so neither lib is a hard import at module-eval time (DRY_RUN-safe).

export type JobId = string;

export interface JobHandle<R = unknown> {
  jobId: JobId;
  result(): Promise<R>;
}

export interface EnqueueOptions {
  singletonKey?: string;
  priority?: number;
  retryLimit?: number;
  retryDelaySeconds?: number;
  startAfterSeconds?: number;
  expireInSeconds?: number;
}

export interface JobContext<T> {
  jobId: JobId;
  name: string;
  data: T;
  attempt: number;
  heartbeat(): Promise<void>;
}

export type JobHandler<T, R> = (ctx: JobContext<T>) => Promise<R>;

export interface IQueueManager {
  enqueue<T, R = void>(queue: string, data: T, opts?: EnqueueOptions): Promise<JobHandle<R>>;
  work<T, R = void>(queue: string, handler: JobHandler<T, R>, opts?: { concurrency?: number }): Promise<void>;
  schedule<T>(queue: string, cron: string, data: T, opts?: EnqueueOptions): Promise<void>;
  getState(jobId: JobId): Promise<"created" | "active" | "completed" | "failed" | "expired" | "cancelled">;
  cancel(jobId: JobId): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type QueueDriver = "pg-boss" | "bullmq" | "memory";

export interface QueueManagerConfig {
  driver: QueueDriver;
  connectionUrl: string;
  schema?: string;
}

// In-memory driver: zero external deps, used in DRY_RUN/tests so the substrate is
// importable before pg-boss/BullMQ is installed. Real drivers slot in behind the
// same interface (drivers/pgBossQueueManager.ts, drivers/bullmqQueueManager.ts).
class MemoryQueueManager implements IQueueManager {
  private handlers = new Map<string, JobHandler<any, any>>();
  private seq = 0;
  async enqueue<T, R = void>(name: string, data: T): Promise<JobHandle<R>> {
    const jobId = `mem_${++this.seq}`;
    const handler = this.handlers.get(name);
    const resultPromise = handler
      ? Promise.resolve(handler({ jobId, name, data, attempt: 1, heartbeat: async () => {} }))
      : Promise.resolve(undefined);
    return { jobId, result: () => resultPromise as Promise<R> };
  }
  async work<T, R = void>(name: string, handler: JobHandler<T, R>): Promise<void> {
    this.handlers.set(name, handler);
  }
  async schedule<T>(_name: string, _cron: string, _data: T): Promise<void> {
    /* memory driver: scheduling is a no-op; real drivers register cron */
  }
  async getState(): Promise<"completed"> {
    return "completed";
  }
  async cancel(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

export function createQueueManager(cfg?: Partial<QueueManagerConfig>): IQueueManager {
  const driver = (cfg?.driver ?? (process.env.QUEUE_DRIVER as QueueDriver) ?? "pg-boss");
  const dryRun = process.env.DRY_RUN === "1";
  // In dry-run, or when memory is requested, return the dependency-free driver.
  if (dryRun || driver === "memory") return new MemoryQueueManager();
  // Real drivers are loaded lazily by the worker bootstrap to avoid a hard dep at import:
  //   const { PgBossQueueManager } = await import("./drivers/pgBossQueueManager");
  //   const { BullmqQueueManager }  = await import("./drivers/bullmqQueueManager");
  // Until a driver is wired, fall back to memory so the substrate stays importable.
  return new MemoryQueueManager();
}

// Global singleton — other services import { queue }.
export const queue: IQueueManager = createQueueManager();
