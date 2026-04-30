export type SkillCategory =
  | "RESEARCH"
  | "GENERATE"
  | "VALIDATE"
  | "SEND"
  | "ANALYZE"
  | "TRANSFORM"
  | "ENRICH";

export interface SkillOutput {
  success: boolean;
  data: Record<string, unknown>;
  metadata?: {
    tokensUsed?: number;
    connectorsCalled?: string[];
    graphsQueried?: string[];
    executionMs?: number;
  };
  error?: string;
}

export interface SkillContext {
  tenantId: number;
  userId: string;
  connectors: Record<string, string>;
  graphIds: number[];
  runId: string;
}

export interface Skill<TInput = Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  category: SkillCategory;
  description: string;
  inputs: object;
  outputs: object;
  requiredConnectors: string[];
  requiredGraphs: string[];
  execute: (input: TInput, ctx: SkillContext) => Promise<SkillOutput>;
}

export interface ConnectorDef {
  slug: string;
  name: string;
  authType: "api_key" | "oauth2";
  credentialLabel: string;
  verify?: (credential: string) => Promise<boolean>;
}
