/**
 * resolveApiKey — env var lookup with OpenRouter key-2 → key-1 fallback.
 * Unblocks /matter and specialist chains when only OPENROUTER_API_KEY is set.
 */

const OPENROUTER_KEY_ENVS = ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY_2"] as const;

export function resolveApiKey(envVar: string): string {
  const direct = process.env[envVar]?.trim();
  if (direct) return direct;

  if (envVar === "OPENROUTER_API_KEY_2" || envVar === "OPENROUTER_API_KEY") {
    for (const key of OPENROUTER_KEY_ENVS) {
      const val = process.env[key]?.trim();
      if (val) return val;
    }
  }

  return "";
}
