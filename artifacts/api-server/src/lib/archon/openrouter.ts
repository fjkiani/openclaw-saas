import { archonConfig as config } from "./config";

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 3000; // 3s base — matches OpenRouter's retry_after_seconds hint

export async function callOpenRouter(
  model: string,
  messages: OpenRouterMessage[],
  temperature = 0.2
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 3s, 6s, 12s, 24s
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
      body: JSON.stringify({ model, messages, temperature, max_tokens: 4096 }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? "";
    }

    const errText = await res.text();

    // Retry on 429 (rate limit) and 503 (upstream unavailable)
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      lastError = new Error(`OpenRouter ${res.status}: ${errText}`);
      continue;
    }

    // Non-retryable error
    throw new Error(`OpenRouter ${res.status}: ${errText}`);
  }

  throw lastError ?? new Error("OpenRouter: max retries exceeded");
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
