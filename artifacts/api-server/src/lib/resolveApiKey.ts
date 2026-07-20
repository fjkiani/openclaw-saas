/**
 * resolveApiKey — env var lookup with OpenRouter key-2 → key-1 fallback.
 * Unblocks /matter and specialist chains when only OPENROUTER_API_KEY is set.
 */

const OPENROUTER_KEY_ENVS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY_2",
  "OPENROUTER_API_KEY_3",
  "OPENROUTER_API_KEY_4",
] as const;
const OPENROUTER_ENV_SET = new Set<string>(OPENROUTER_KEY_ENVS);

export function resolveApiKey(envVar: string): string {
  const direct = process.env[envVar]?.trim();
  if (direct) return direct;

  // When any OR-key slot is empty, silently fall back through the OR key pool
  // so a single populated key can serve every OR-slotted chain entry. This
  // preserves the "widen chain to N entries even if only 1 key is set"
  // behavior without duplicating chain configs.
  if (OPENROUTER_ENV_SET.has(envVar)) {
    for (const key of OPENROUTER_KEY_ENVS) {
      const val = process.env[key]?.trim();
      if (val) return val;
    }
  }

  return "";
}
