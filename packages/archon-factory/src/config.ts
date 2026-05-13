import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT ?? "3002", 10),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  benchmarkServiceUrl: process.env.BENCHMARK_SERVICE_URL ?? "http://localhost:8001",
  archonServiceUrl: process.env.ARCHON_SERVICE_URL ?? "http://localhost:3000",
  openclawApiUrl: process.env.OPENCLAW_API_URL ?? "http://localhost:3001",
  openclawServiceToken: process.env.OPENCLAW_SERVICE_TOKEN ?? "",
  openrouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
  // Qwen3 Coder 480B — best free-tier code generation model
  codeModel: "qwen/qwen3-coder-480b-a35b:free",
  // Hermes 3 405B — for fix reasoning
  reasoningModel: "nousresearch/hermes-3-llama-3.1-405b:free",
};
