/**
 * archon/config.ts — Config for the in-process Archon skill forge.
 * Reads from the same env vars as the main api-server.
 * OPENROUTER_API_KEY is shared with the legal counsel route.
 */
export const archonConfig = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY_2 ?? "",
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  codeModel: "qwen/qwen3-coder-480b-a35b:free",
  reasoningModel: "nousresearch/hermes-3-llama-3.1-405b:free",
};
