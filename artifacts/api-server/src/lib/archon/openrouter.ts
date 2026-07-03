import { archonConfig as config } from "./config";

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callOpenRouter(
  model: string,
  messages: OpenRouterMessage[],
  temperature = 0.2
): Promise<string> {
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
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
