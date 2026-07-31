/**
 * archon/config.ts — Config for the in-process Archon skill forge.
 *
 * Rewired to use Groq (primary) + Gemini (fallback) instead of dead OpenRouter keys.
 * Groq provides low-latency inference for code generation.
 * Gemini provides higher-quality reasoning for the L1 judge.
 *
 * Model priority order:
 *   Code:      1. llama-3.3-70b-versatile (Groq) — fast, reliable code generation
 *              2. gemini-2.5-flash (Gemini) — fallback when Groq rate-limits
 *   L1 Judge:  1. gemini-2.5-flash (Gemini) — strong reasoning, 1M context
 *              2. llama-3.3-70b-versatile (Groq) — fallback
 */
export const archonConfig = {
  // Groq (primary provider for code generation)
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqBaseUrl: "https://api.groq.com/openai/v1/chat/completions",
  // Primary code generation model (Groq)
  codeModel: "llama-3.3-70b-versatile",
  // Fallback models tried in order if primary returns 429
  codeModelFallbacks: [
    "openai/gpt-oss-120b", // Groq-hosted GPT-OSS
  ],
  // L1 judge model — Gemini for strong reasoning
  reasoningModel: "gemini-2.5-flash",
  reasoningModelFallbacks: [
    "llama-3.3-70b-versatile", // Groq fallback
  ],
  // Google Gemini — used for L1 judge and as code-gen fallback
  // Uses GOOGLE_API_KEY (the correct env var name, not GOOGLE_AI_API_KEY)
  geminiApiKey: process.env.GOOGLE_API_KEY ?? "",
  geminiModel: "gemini-2.5-flash",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  // Gemini OpenAI-compatible endpoint (for chat completions format)
  geminiOpenAiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};
