/**
 * providers/index.ts — unified LLM + embedding provider abstraction.
 *
 * V2 sovereign-deployment foundation. One interface for chat + embeddings that
 * runs against:
 *   - cloud  : Gemini (embeddings/chat) + Groq (chat) — public SaaS (V1)
 *   - local  : Ollama (or any OpenAI-compatible local server) — air-gapped (V2)
 *   - hybrid : local-first with cloud fallback (or vice versa)
 *
 * Selected via env so the SAME codebase deploys as public SaaS or as a fully
 * isolated on-prem / VPC tenant with a locally-hosted model and no public-cloud
 * dependency (hedge funds, hospitals, compliance-bound tenants).
 *
 * Env:
 *   LLM_BACKEND            = cloud | local | hybrid   (default: cloud)
 *   EMBED_BACKEND          = cloud | local            (default: follows LLM_BACKEND)
 *
 *   Local (Ollama / OpenAI-compatible):
 *     LOCAL_LLM_BASE_URL   = http://ollama:11434      (or http://localhost:11434)
 *     LOCAL_LLM_MODEL      = llama3.1:8b               (chat model)
 *     LOCAL_EMBED_MODEL    = nomic-embed-text          (embedding model)
 *     LOCAL_LLM_API_KEY    = (optional; for OpenAI-compatible servers that need one)
 *
 *   Cloud:
 *     GOOGLE_API_KEY       — Gemini embeddings + chat
 *     GROQ_API_KEY         — Groq chat (fast path)
 *
 *   Hybrid:
 *     HYBRID_ORDER         = local-first | cloud-first (default: local-first)
 */

import { logger } from "../logger.js";
import { resolveApiKey } from "../resolveApiKey.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json" | "text";
}

export interface ChatResult {
  content: string;
  model: string;
  backend: "cloud" | "local";
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface EmbedResult {
  vector: number[];
  dims: number;
  backend: "cloud" | "local";
  provider: string;
  model: string;
}

export interface ProviderStatus {
  llm_backend: string;
  embed_backend: string;
  local: { configured: boolean; reachable: boolean; chat_model: string; embed_model: string; models?: string[] };
  cloud: { gemini_key_set: boolean; groq_key_set: boolean };
  effective: { chat: string; embed: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const LLM_BACKEND = (process.env.LLM_BACKEND ?? "cloud").toLowerCase();
const EMBED_BACKEND = (process.env.EMBED_BACKEND ?? LLM_BACKEND).toLowerCase();
const HYBRID_ORDER = (process.env.HYBRID_ORDER ?? "local-first").toLowerCase();

const LOCAL_BASE = (process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const LOCAL_CHAT_MODEL = process.env.LOCAL_LLM_MODEL ?? "llama3.1:8b";
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL ?? "nomic-embed-text";
const LOCAL_API_KEY = process.env.LOCAL_LLM_API_KEY ?? "";

const GEMINI_EMBED_MODEL = process.env.LEGAL_EMBED_MODEL ?? "gemini-embedding-001";
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL ?? "llama-3.3-70b-versatile";

export function isLocalLlmConfigured(): boolean {
  return LLM_BACKEND === "local" || LLM_BACKEND === "hybrid" || EMBED_BACKEND === "local";
}

// ─────────────────────────────────────────────────────────────────────────────
// Local backend (Ollama / OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

/** Detect whether the local server speaks Ollama native API or OpenAI-compatible. */
async function localChatOllama(req: ChatRequest): Promise<ChatResult> {
  const res = await fetch(`${LOCAL_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model ?? LOCAL_CHAT_MODEL,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.2,
        num_predict: req.maxTokens ?? 2048,
      },
      ...(req.responseFormat === "json" ? { format: "json" } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`local chat HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string }; model?: string };
  const content = data.message?.content ?? "";
  if (!content) throw new Error("local chat returned empty content");
  return { content, model: data.model ?? LOCAL_CHAT_MODEL, backend: "local", provider: "ollama" };
}

async function localChatOpenAi(req: ChatRequest): Promise<ChatResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LOCAL_API_KEY) headers.Authorization = `Bearer ${LOCAL_API_KEY}`;
  const res = await fetch(`${LOCAL_BASE}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: req.model ?? LOCAL_CHAT_MODEL,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`local chat (openai) HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("local chat (openai) returned empty content");
  return { content, model: data.model ?? LOCAL_CHAT_MODEL, backend: "local", provider: "openai-compatible", usage: data.usage };
}

async function localEmbedOllama(text: string): Promise<EmbedResult> {
  const res = await fetch(`${LOCAL_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, prompt: text.slice(0, 8192) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`local embed HTTP ${res.status}`);
  const data = (await res.json()) as { embedding?: number[] };
  if (!data.embedding?.length) throw new Error("local embed returned empty vector");
  return { vector: data.embedding, dims: data.embedding.length, backend: "local", provider: "ollama", model: LOCAL_EMBED_MODEL };
}

async function localEmbedOpenAi(text: string): Promise<EmbedResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LOCAL_API_KEY) headers.Authorization = `Bearer ${LOCAL_API_KEY}`;
  const res = await fetch(`${LOCAL_BASE}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: text.slice(0, 8192) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`local embed (openai) HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = data.data?.[0]?.embedding;
  if (!vec?.length) throw new Error("local embed (openai) returned empty vector");
  return { vector: vec, dims: vec.length, backend: "local", provider: "openai-compatible", model: LOCAL_EMBED_MODEL };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud backend (Gemini embeddings/chat + Groq chat)
// ─────────────────────────────────────────────────────────────────────────────

async function cloudEmbed(text: string): Promise<EmbedResult> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text: text.slice(0, 8192) }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`gemini embed HTTP ${res.status}`);
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const vec = data.embedding?.values;
  if (!vec?.length) throw new Error("gemini embed returned empty vector");
  return { vector: vec, dims: vec.length, backend: "cloud", provider: "gemini", model: GEMINI_EMBED_MODEL };
}

async function cloudChatGemini(req: ChatRequest): Promise<ChatResult> {
  const apiKey = resolveApiKey("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model ?? GEMINI_CHAT_MODEL,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 2048,
        ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`gemini chat HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("gemini chat returned empty content");
  return { content, model: data.model ?? GEMINI_CHAT_MODEL, backend: "cloud", provider: "gemini", usage: data.usage };
}

async function cloudChatGroq(req: ChatRequest): Promise<ChatResult> {
  const apiKey = resolveApiKey("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not set");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: req.model ?? GROQ_CHAT_MODEL,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`groq chat HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("groq chat returned empty content");
  return { content, model: data.model ?? GROQ_CHAT_MODEL, backend: "cloud", provider: "groq", usage: data.usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local server capability detection (Ollama native vs OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

let localFlavor: "ollama" | "openai" | null = null;

async function detectLocalFlavor(): Promise<"ollama" | "openai"> {
  if (localFlavor) return localFlavor;
  // Ollama exposes /api/tags; OpenAI-compatible servers expose /v1/models.
  try {
    const r = await fetch(`${LOCAL_BASE}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) { localFlavor = "ollama"; return "ollama"; }
  } catch { /* not ollama */ }
  localFlavor = "openai";
  return "openai";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — chat + embed with backend selection + hybrid fallback
// ─────────────────────────────────────────────────────────────────────────────

async function chatLocal(req: ChatRequest): Promise<ChatResult> {
  const flavor = await detectLocalFlavor();
  return flavor === "ollama" ? localChatOllama(req) : localChatOpenAi(req);
}

async function embedLocal(text: string): Promise<EmbedResult> {
  const flavor = await detectLocalFlavor();
  return flavor === "ollama" ? localEmbedOllama(text) : localEmbedOpenAi(text);
}

/**
 * Unified chat. Honors LLM_BACKEND; in hybrid mode tries the preferred backend
 * first and falls back to the other on failure.
 */
export async function providerChat(req: ChatRequest, prefer: "groq" | "gemini" = "gemini"): Promise<ChatResult> {
  const cloudChat = prefer === "groq" ? cloudChatGroq : cloudChatGemini;

  if (LLM_BACKEND === "local") {
    return chatLocal(req);
  }
  if (LLM_BACKEND === "hybrid") {
    const localFirst = HYBRID_ORDER !== "cloud-first";
    const primary = localFirst ? chatLocal : cloudChat;
    const secondary = localFirst ? cloudChat : chatLocal;
    try {
      return await primary(req);
    } catch (err) {
      logger.warn({ err, fallback: localFirst ? "cloud" : "local" }, "providers: hybrid chat fallback");
      return secondary(req);
    }
  }
  // cloud (default)
  return cloudChat(req);
}

/**
 * Unified embed. Honors EMBED_BACKEND; in hybrid mode tries preferred first.
 * NOTE: when mixing backends, vector dims differ (Gemini 3072 vs local model's
 * dims) — the caller must embed corpus + query with the SAME backend. Use
 * `effectiveEmbedDims()` to size collections correctly.
 */
export async function providerEmbed(text: string): Promise<EmbedResult> {
  if (EMBED_BACKEND === "local") {
    return embedLocal(text);
  }
  if (EMBED_BACKEND === "hybrid") {
    const localFirst = HYBRID_ORDER !== "cloud-first";
    const primary = localFirst ? embedLocal : cloudEmbed;
    const secondary = localFirst ? cloudEmbed : embedLocal;
    try {
      return await primary(text);
    } catch (err) {
      logger.warn({ err, fallback: localFirst ? "cloud" : "local" }, "providers: hybrid embed fallback");
      return secondary(text);
    }
  }
  return cloudEmbed(text);
}

/** Dims of the effective embedding backend (for sizing Qdrant collections). */
export function effectiveEmbedDims(): number {
  if (EMBED_BACKEND === "local") {
    // Ollama nomic-embed-text = 768; mxbai-embed-large = 1024. Caller can override.
    return Number(process.env.LOCAL_EMBED_DIMS ?? 768);
  }
  return 3072; // Gemini gemini-embedding-001
}

/** Health/status for the providers subsystem (surfaced on status routes). */
export async function providerStatus(): Promise<ProviderStatus> {
  const localConfigured = isLocalLlmConfigured();
  let reachable = false;
  let models: string[] | undefined;
  if (localConfigured) {
    try {
      const flavor = await detectLocalFlavor();
      const url = flavor === "ollama" ? `${LOCAL_BASE}/api/tags` : `${LOCAL_BASE}/v1/models`;
      const headers: Record<string, string> = {};
      if (LOCAL_API_KEY) headers.Authorization = `Bearer ${LOCAL_API_KEY}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        reachable = true;
        const data = (await r.json()) as { models?: { name?: string; id?: string }[]; data?: { id?: string }[] };
        const raw = (data.models ?? data.data ?? []) as { name?: string; id?: string }[];
        models = raw.map((m) => m.name ?? m.id ?? "").filter(Boolean);
      }
    } catch { reachable = false; }
  }
  const gemini = !!resolveApiKey("GOOGLE_API_KEY");
  const groq = !!resolveApiKey("GROQ_API_KEY");
  return {
    llm_backend: LLM_BACKEND,
    embed_backend: EMBED_BACKEND,
    local: { configured: localConfigured, reachable, chat_model: LOCAL_CHAT_MODEL, embed_model: LOCAL_EMBED_MODEL, models },
    cloud: { gemini_key_set: gemini, groq_key_set: groq },
    effective: {
      chat: LLM_BACKEND === "local" ? `local:${LOCAL_CHAT_MODEL}` : LLM_BACKEND === "hybrid" ? `hybrid(${HYBRID_ORDER})` : "cloud",
      embed: EMBED_BACKEND === "local" ? `local:${LOCAL_EMBED_MODEL}` : EMBED_BACKEND === "hybrid" ? `hybrid(${HYBRID_ORDER})` : "cloud:gemini",
    },
  };
}
