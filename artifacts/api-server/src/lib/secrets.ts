// artifacts/api-server/src/lib/secrets.ts
// COMMIT B (auth substrate): dry-run secret provider + 401-graceful auth guard.
// DRY_RUN=1 (or an absent key) injects deterministic mocks so the whole pipeline
// runs locally with no production keys; a real run surfaces BLOCKED_PENDING_*_KEY.

export type SecretKey =
  | "OPENROUTER_API_KEY"
  | "GROQ_API_KEY"
  | "MODAL_TOKEN_ID"
  | "MODAL_TOKEN_SECRET"
  | "HF_TOKEN"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY";

export interface SecretProvider {
  get(key: SecretKey): string | undefined;
  require(key: SecretKey): string; // throws MissingSecretError if absent AND not dry-run
  isDryRun(key: SecretKey): boolean;
}

export class MissingSecretError extends Error {
  constructor(public key: SecretKey) {
    super(`Missing secret: ${key}`);
    this.name = "MissingSecretError";
  }
}

const MOCK_VALUES: Record<SecretKey, string> = {
  OPENROUTER_API_KEY: "sk-mock-openrouter-DRYRUN",
  GROQ_API_KEY: "gsk-mock-groq-DRYRUN",
  MODAL_TOKEN_ID: "ak-mock-modal-DRYRUN",
  MODAL_TOKEN_SECRET: "as-mock-modal-DRYRUN",
  HF_TOKEN: "hf_mock_DRYRUN",
  S3_ACCESS_KEY_ID: "AKIA_MOCK_DRYRUN",
  S3_SECRET_ACCESS_KEY: "mock-s3-secret-DRYRUN",
};

export function createSecretProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  const globalDryRun = env.DRY_RUN === "1";
  return {
    isDryRun: (k) => globalDryRun || !env[k],
    get(k) {
      return env[k] ?? (globalDryRun ? MOCK_VALUES[k] : undefined);
    },
    require(k) {
      const v = env[k];
      if (v) return v;
      if (globalDryRun) return MOCK_VALUES[k];
      throw new MissingSecretError(k);
    },
  };
}

// Global provider singleton — other services import { secrets }.
export const secrets: SecretProvider = createSecretProvider();

// ── Graceful 401 handling ───────────────────────────────────────────────
export interface ProviderResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  stubbed?: boolean;
  reason?: string;
}

/**
 * Wraps any authed provider call. Behavior:
 *  - key absent  + dry-run -> returns stub (status 200-equivalent, stubbed=true)
 *  - key absent  + real    -> { ok:false, status:401 }  (caller raises BLOCKED_PENDING_*_KEY)
 *  - real 401    + dry-run -> degrades to stub so the state machine still advances
 *  - real 401    + real    -> { ok:false, status:401 }
 */
export async function callWithAuthGuard<T>(
  key: SecretKey,
  fn: (token: string) => Promise<ProviderResponse<T>>,
  dryRunStub: () => T,
  provider: SecretProvider = secrets,
): Promise<ProviderResponse<T>> {
  const token = provider.get(key);
  if (!token) {
    const dry = provider.isDryRun(key);
    return {
      ok: dry,
      status: dry ? 200 : 401,
      data: dry ? dryRunStub() : undefined,
      stubbed: dry,
      reason: `absent:${key}`,
    };
  }
  const res = await fn(token);
  if (res.status === 401) {
    if (provider.isDryRun(key)) {
      return { ok: true, status: 200, data: dryRunStub(), stubbed: true, reason: `401->stub:${key}` };
    }
    return { ok: false, status: 401, reason: `unauthorized:${key}` };
  }
  return res;
}
