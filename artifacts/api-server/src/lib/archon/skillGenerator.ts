import { callOpenRouter } from "./openrouter";
import { archonConfig as config } from "./config";

// Two-part format: JSON metadata + implementation in a separate block
// This avoids the JSON escaping problem with TypeScript code embedded in JSON strings.
const SKILL_SYSTEM_PROMPT = `You are a skill-generation engine for OpenClaw, a multi-agent SaaS platform.
Generate a complete, runnable TypeScript skill from the user's description.

A skill MUST export these named exports:
  export const name: string
  export const description: string
  export const inputSchema: object  (JSON Schema)
  export const outputSchema: object (JSON Schema)
  export async function run(input: Record<string, unknown>): Promise<Record<string, unknown>>

Constraints:
  - Under 300 lines total
  - No external npm imports — only Node.js built-ins (fs, path, crypto, url) and global fetch
  - The run() function MUST handle all errors and return { error: string } on failure — never throw
  - Use async/await throughout
  - Include JSDoc comments on the run() function

Return your response in EXACTLY this format — two sections separated by the delimiter:

METADATA_JSON
{
  "name": "skill-slug-kebab-case",
  "description": "One sentence describing what this skill does",
  "category": "one of: Data, Finance, Productivity, HR & Payroll, Operations, Legal & Compliance, Research, Communication",
  "inputSchema": { "type": "object", "properties": {}, "required": [] },
  "outputSchema": { "type": "object", "properties": {} }
}
IMPLEMENTATION_CODE
// Full TypeScript source code here — no escaping needed, write normal TypeScript
export const name = "skill-name";
// ... rest of implementation
END_SKILL

Rules:
- METADATA_JSON section: valid JSON with no "implementation" key
- IMPLEMENTATION_CODE section: raw TypeScript, no escaping, no markdown fences
- The delimiters METADATA_JSON, IMPLEMENTATION_CODE, END_SKILL must appear on their own lines
- No text before METADATA_JSON or after END_SKILL`;

export interface GeneratedSkill {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  implementation: string;
}

/**
 * Parse the two-part response format: METADATA_JSON ... IMPLEMENTATION_CODE ... END_SKILL
 * Falls back to JSON format if delimiters are missing.
 */
function parseTwoPartResponse(raw: string): GeneratedSkill {
  // Strip markdown code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n").filter((l) => !l.startsWith("```")).join("\n").trim();
  }

  const metaStart = cleaned.indexOf("METADATA_JSON");
  const implStart = cleaned.indexOf("IMPLEMENTATION_CODE");
  const endMarker = cleaned.indexOf("END_SKILL");

  if (metaStart !== -1 && implStart !== -1) {
    // Two-part format
    const metaText = cleaned.slice(metaStart + "METADATA_JSON".length, implStart).trim();
    const metaJsonStart = metaText.indexOf("{");
    const metaJsonEnd = metaText.lastIndexOf("}") + 1;
    if (metaJsonStart === -1 || metaJsonEnd <= metaJsonStart) {
      throw new Error("No JSON object found in METADATA_JSON section");
    }
    const meta = JSON.parse(metaText.slice(metaJsonStart, metaJsonEnd)) as Omit<GeneratedSkill, "implementation">;
    const implEnd = endMarker !== -1 ? endMarker : cleaned.length;
    const implementation = cleaned.slice(implStart + "IMPLEMENTATION_CODE".length, implEnd).trim();
    return {
      name: meta.name,
      description: meta.description,
      category: meta.category,
      inputSchema: meta.inputSchema ?? {},
      outputSchema: meta.outputSchema ?? {},
      implementation,
    };
  }

  // Fallback: model returned JSON format — extract implementation field surgically
  // Strategy: find "implementation": " then extract everything until the closing quote
  // that is followed by } or ,
  const jsonStart = cleaned.indexOf("{");
  if (jsonStart === -1) throw new Error("No JSON or two-part format found in LLM response");

  // Try to extract implementation field using a regex that handles multiline strings
  // The implementation field value starts after "implementation": " and ends before the last "
  const implFieldMatch = cleaned.match(/"implementation"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (implFieldMatch) {
    // Found implementation field — extract it and rebuild the JSON without it
    const implementation = implFieldMatch[1]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    // Parse the rest of the JSON (without implementation)
    const withoutImpl = cleaned.replace(/"implementation"\s*:\s*"[\s\S]*?"\s*,?\s*/, "");
    const metaStart2 = withoutImpl.indexOf("{");
    const metaEnd2 = withoutImpl.lastIndexOf("}") + 1;
    const meta = JSON.parse(withoutImpl.slice(metaStart2, metaEnd2)) as Omit<GeneratedSkill, "implementation">;
    return { ...meta, implementation };
  }

  // Last resort: try direct JSON parse (may fail for malformed responses)
  const jsonEnd = cleaned.lastIndexOf("}") + 1;
  const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd)) as GeneratedSkill;
  if (parsed.implementation) return parsed;
  throw new Error("Response missing implementation field");
}

export async function generateSkill(prompt: string): Promise<GeneratedSkill> {
  const raw = await callOpenRouter(
    config.codeModel,
    [
      { role: "system", content: SKILL_SYSTEM_PROMPT },
      { role: "user", content: `Build a skill that: ${prompt}` },
    ],
    0.2,
    config.codeModelFallbacks,
  );

  const parsed = parseTwoPartResponse(raw);
  const required: (keyof GeneratedSkill)[] = ["name", "description", "category", "inputSchema", "outputSchema", "implementation"];
  for (const field of required) {
    if (!parsed[field]) {
      throw new Error(`Generated skill missing required field: ${field}`);
    }
  }
  return parsed;
}

export async function fixSkill(originalSkill: GeneratedSkill, error: string): Promise<GeneratedSkill> {
  const FIX_PROMPT = `The following OpenClaw skill has a validation error. Fix it and return the corrected skill.

Error: ${error}

Original skill metadata:
${JSON.stringify({ name: originalSkill.name, description: originalSkill.description, category: originalSkill.category, inputSchema: originalSkill.inputSchema, outputSchema: originalSkill.outputSchema }, null, 2)}

Original implementation:
${originalSkill.implementation}

Return the corrected skill in the same two-part format (METADATA_JSON ... IMPLEMENTATION_CODE ... END_SKILL).`;

  const raw = await callOpenRouter(
    config.codeModel,
    [
      { role: "system", content: SKILL_SYSTEM_PROMPT },
      { role: "user", content: FIX_PROMPT },
    ],
    0.2,
    config.codeModelFallbacks,
  );
  return parseTwoPartResponse(raw);
}
