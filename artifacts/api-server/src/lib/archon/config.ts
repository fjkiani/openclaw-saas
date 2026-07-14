/**
 * archon/config.ts — Config for the in-process Archon skill forge.
 * Reads from the same env vars as the main api-server.
 * OPENROUTER_API_KEY is shared with the legal counsel route.
 *
 * Model priority order — first available (non-429/404) is used:
 *   Code:      1. qwen/qwen3-coder:free     — 1M ctx, purpose-built for code generation
 *              2. nvidia/nemotron-3-super-120b-a12b:free — 1M ctx, strong reasoning
 *              3. meta-llama/llama-3.3-70b-instruct:free — 131k ctx, reliable fallback
 *   L1 Judge:  1. nvidia/nemotron-3-ultra-550b-a55b:free — 550B, strongest free reasoning
 *              2. qwen/qwen3-coder:free — 1M ctx, reliable JSON output
 *              3. nvidia/nemotron-3-super-120b-a12b:free — 1M ctx fallback
 *
 * Note: openai/gpt-oss-120b:free was removed — no longer available on free tier (404).
 * Note: nousresearch/hermes-3-llama-3.1-405b:free consistently returns L1=20 (too strict).
 */
export const archonConfig = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY_2 ?? "",
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  // Primary code generation model (OpenRouter free tier)
  codeModel: "qwen/qwen3-coder:free",
  // Fallback models tried in order if primary returns 429
  codeModelFallbacks: [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  // L1 judge model — switched from hermes-3-405b (returns L1=20 consistently)
  // to nemotron-3-ultra-550b (strongest free reasoning model available)
  reasoningModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
  reasoningModelFallbacks: [
    "qwen/qwen3-coder:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ],
  // Google Gemini — final fallback when all OpenRouter free models are rate-limited
  // gemini-2.5-flash: 1M context, fast, free tier via AI Studio key
  geminiApiKey: process.env.GOOGLE_AI_API_KEY ?? "",
  geminiModel: "gemini-2.5-flash",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
};
