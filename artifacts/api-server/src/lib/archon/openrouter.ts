import { archonConfig as config } from "./config";

// ── Gemini API (Google AI Studio) ─────────────────────────────────────────────
// Used as final fallback when all OpenRouter free models are rate-limited.
// Gemini 2.5 Flash: 1M context, fast, free tier with AI Studio key.

interface GeminiPart { text: string }
interface GeminiContent { parts: GeminiPart[] }
interface GeminiResponse {
  candidates?: Array<{ content: { parts: GeminiPart[] } }>;
  error?: { message: string; code: number };
}

/**
 * callGemini — calls Google Gemini API directly (not via OpenRouter).
 * Converts OpenRouter-style messages to Gemini's content format.
 * System message is prepended as a user turn (Gemini doesn't have a system role in basic API).
 */
async function callGemini(
  messages: OpenRouterMessage[],
  temperature = 0.2
): Promise<string> {
  const apiKey = config.geminiApiKey;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY not set — Gemini unavailable");

  // Convert messages: system → prepend to first user message; assistant → model role
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  let systemText = "";
  for (const msg of messages) {
    if (msg.role === "system") {
      systemText = msg.content;
    } else if (msg.role === "user") {
      const text = systemText ? `${systemText}

${msg.content}` : msg.content;
      contents.push({ role: "user", parts: [{ text }] });
      systemText = ""; // only prepend to first user message
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }

  const url = `${config.geminiBaseUrl}/${config.geminiModel}:generateContent?key=${apiKey}`;

  // Retry up to 3 times for transient 503 "high demand" errors
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 5000 * attempt)); // 5s, 10s backoff
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature, maxOutputTokens: 8192 },
      }),
    });

    const data = (await res.json()) as GeminiResponse;

    // Retry on 503 / "high demand" transient errors
    if (res.status === 503 || (data.error?.message ?? "").toLowerCase().includes("high demand")) {
      if (attempt < 2) continue; // retry
    }

    if (!res.ok || data.error) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`Gemini error: ${msg}`);
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
  throw new Error("Gemini error: max retries exceeded (503 high demand)");
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const MAX_RETRIES_PER_MODEL = 2;
const BASE_DELAY_MS = 4000; // 4s base

/**
 * callOpenRouter — calls OpenRouter with retry + model fallback.
 *
 * If the primary model returns 429/503, retries up to MAX_RETRIES_PER_MODEL
 * times with exponential backoff, then falls through to the next model in
 * `fallbacks`. Throws only if all models are exhausted.
 */
export async function callOpenRouter(
  model: string,
  messages: OpenRouterMessage[],
  temperature = 0.2,
  fallbacks: string[] = []
): Promise<string> {
  const modelsToTry = [model, ...fallbacks];

  for (const currentModel of modelsToTry) {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      const res = await fetch(config.openrouterBaseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openrouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Archon Factory",
        },
        body: JSON.stringify({ model: currentModel, messages, temperature, max_tokens: 4096 }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        return data.choices[0]?.message?.content ?? "";
      }

      const errText = await res.text();

      // Retry on 429/503 within this model
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES_PER_MODEL) {
        lastError = new Error(`OpenRouter ${res.status} [${currentModel}]: ${errText}`);
        continue;
      }

      // Non-retryable error for this model — try next fallback
      lastError = new Error(`OpenRouter ${res.status} [${currentModel}]: ${errText}`);
      break;
    }

    // If we get here, this model failed — try next
    if (lastError) {
      const isRateLimit = lastError.message.includes("429") || lastError.message.includes("503");
      if (!isRateLimit) {
        // Hard error (400, 401, etc.) — don't try fallbacks
        throw lastError;
      }
      // Rate limit — continue to next model
    }
  }

  // All OpenRouter models exhausted — try Gemini as final fallback
  if (config.geminiApiKey) {
    try {
      const geminiResult = await callGemini(messages, temperature);
      if (geminiResult) return geminiResult;
    } catch (geminiErr) {
      throw new Error(
        `All models exhausted. OpenRouter tried: ${modelsToTry.join(", ")}. ` +
        `Gemini error: ${geminiErr instanceof Error ? geminiErr.message : String(geminiErr)}`
      );
    }
  }

  throw new Error(`OpenRouter: all models exhausted (tried: ${modelsToTry.join(", ")})`);
}

export function extractJson(text: string): unknown {
  let cleaned = text.trim();
  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n").filter((l) => !l.startsWith("```")).join("\n").trim();
  }
  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting from first { to last }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      const slice = cleaned.slice(start, end);
      try {
        return JSON.parse(slice);
      } catch {
        // JSON parse failed — try to repair common LLM JSON issues:
        // 1. Unescaped newlines inside string values
        // 2. Trailing commas
        // 3. Single quotes instead of double quotes
        const repaired = slice
          // Fix unescaped newlines inside strings (replace literal \n with \\n)
          .replace(/("(?:[^"\\]|\\.)*")/g, (match) =>
            match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
          )
          // Remove trailing commas before } or ]
          .replace(/,(\s*[}\]])/g, "$1");
        try {
          return JSON.parse(repaired);
        } catch (finalErr) {
          throw new Error(`No valid JSON found in LLM response: ${(finalErr as Error).message}`);
        }
      }
    }
    throw new Error("No valid JSON found in LLM response");
  }
}
