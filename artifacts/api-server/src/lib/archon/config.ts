/**
 * archon/config.ts — Config for the in-process Archon skill forge.
 * Reads from the same env vars as the main api-server.
 * OPENROUTER_API_KEY is shared with the legal counsel route.
 *
 * Model priority order — first available (non-429) is used:
 *   1. openai/gpt-oss-120b:free  — 131k ctx, reliable
 *   2. qwen/qwen3-coder:free     — 1M ctx, best for code but often rate-limited
 *   3. meta-llama/llama-3.3-70b-instruct:free — fallback
 */
export const archonConfig = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY_2 ?? "",
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  // Primary code generation model (OpenRouter free tier)
  codeModel: "openai/gpt-oss-120b:free",
  // Fallback models tried in order if primary returns 429
  codeModelFallbacks: [
    "qwen/qwen3-coder:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  // L1 judge model
  reasoningModel: "nousresearch/hermes-3-llama-3.1-405b:free",
  reasoningModelFallbacks: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "openai/gpt-oss-120b:free",
  ],
  // Google Gemini — final fallback when all OpenRouter free models are rate-limited
  // gemini-2.5-flash: 1M context, fast, free tier via AI Studio key
  geminiApiKey: process.env.GOOGLE_AI_API_KEY ?? "",
  geminiModel: "gemini-2.5-flash",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
};
