import { callOpenRouter, extractJson } from "./openrouter";
import { archonConfig as config } from "./config";

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

Return ONLY a valid JSON object with these exact keys:
{
  "name": "skill-slug-kebab-case",
  "description": "One sentence describing what this skill does",
  "category": "one of: Data, Finance, Productivity, HR & Payroll, Operations, Legal & Compliance, Research, Communication",
  "inputSchema": { "type": "object", "properties": {...}, "required": [...] },
  "outputSchema": { "type": "object", "properties": {...} },
  "implementation": "FULL TypeScript source code as a single string — must be valid TS"
}

Do NOT wrap in markdown. Return raw JSON only.`;

export interface GeneratedSkill {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  implementation: string;
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

  const parsed = extractJson(raw) as GeneratedSkill;
  const required = ["name", "description", "category", "inputSchema", "outputSchema", "implementation"];
  for (const field of required) {
    if (!parsed[field as keyof GeneratedSkill]) {
      throw new Error(`Generated skill missing required field: ${field}`);
    }
  }
  return parsed;
}

export async function fixSkill(originalSkill: GeneratedSkill, error: string): Promise<GeneratedSkill> {
  const FIX_PROMPT = `The following OpenClaw skill has a validation error. Fix it and return corrected JSON.

Error: ${error}

Original skill JSON:
${JSON.stringify(originalSkill, null, 2)}

Return ONLY the corrected JSON object. Same schema as before. Fix the TypeScript in the "implementation" field.`;

  const raw = await callOpenRouter(
    config.codeModel,
    [
      { role: "system", content: SKILL_SYSTEM_PROMPT },
      { role: "user", content: FIX_PROMPT },
    ],
    0.2,
    config.codeModelFallbacks,
  );
  return extractJson(raw) as GeneratedSkill;
}
