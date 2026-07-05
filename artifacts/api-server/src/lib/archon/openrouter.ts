import { archonConfig as config } from "./config";

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

  throw new Error(`OpenRouter: all models exhausted (tried: ${modelsToTry.join(", ")})`);
}

export function extractJson(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n").filter((l) => !l.startsWith("```")).join("\n").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end));
    }
    throw new Error("No valid JSON found in LLM response");
  }
}
