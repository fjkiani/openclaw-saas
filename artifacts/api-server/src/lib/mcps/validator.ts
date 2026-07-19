/**
 * validator.ts — MCP registration governance gate (L0-L4).
 *
 * This is the in-process validator that mirrors Archon's skill L0-L4 flow.
 * It runs whenever an MCP is submitted to the registry so that every entry
 * carries a gate grade (CERTIFIED | CONDITIONAL | FAILED | INCONCLUSIVE)
 * before it is exposed for install.
 *
 * Levels
 * ------
 *   L0 — Manifest sanity: entrypoint present, transport known, tools declared
 *   L1 — Tool schema conformance: declared_tools shape valid (name + input_schema per tool)
 *   L2 — Privilege honesty: declared_privileges shape sane, wildcard flagged
 *   L3 — Adversarial harness: run the governance_traps corpus questions dry
 *        (no live invocation of the MCP — the harness is inspection-only
 *         until a per-MCP sandbox is wired). Scored on manifest properties.
 *   L4 — Reviewer sign-off flag (never auto-passed; requires human)
 *
 * Design constraint: this validator is intentionally NOT a live-runner. It
 * inspects the declared surface only, so it is safe to run inline on the
 * request path. Live MCP invocation happens elsewhere (per-tenant runtime).
 */

export interface McpManifest {
  slug: string;
  name: string;
  description: string;
  category: string;
  vendor?: string;
  transport: "stdio" | "http" | "sse" | "websocket";
  entrypoint: string;
  entrypointType: "npm" | "pip" | "container" | "http";
  declaredTools: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
  }>;
  declaredPrivileges: {
    net?: string[];
    fs?: string[];
    env?: string[];
  };
  semver?: string;
}

export interface LevelResult {
  level: 0 | 1 | 2 | 3 | 4;
  name: string;
  pass: boolean;
  score: number; // 0..1
  notes: string[];
}

export interface McpGateReport {
  slug: string;
  overallScore: number; // 0..100
  grade: "CERTIFIED" | "CONDITIONAL" | "FAILED" | "INCONCLUSIVE";
  levels: LevelResult[];
  ranAt: string; // ISO
  durationMs: number;
}

const KNOWN_TRANSPORTS = new Set(["stdio", "http", "sse", "websocket"]);
const KNOWN_ENTRYPOINT_TYPES = new Set(["npm", "pip", "container", "http"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function score(level: LevelResult, weight = 1): number {
  return level.pass ? level.score * weight : level.score * weight * 0.25;
}

function l0Manifest(m: McpManifest): LevelResult {
  const notes: string[] = [];
  let pass = true;
  if (!SLUG_RE.test(m.slug)) {
    notes.push(`slug '${m.slug}' fails ${SLUG_RE}`);
    pass = false;
  }
  if (!m.name || m.name.length < 3) {
    notes.push("name shorter than 3 chars");
    pass = false;
  }
  if (!m.description || m.description.length < 20) {
    notes.push("description under 20 chars — not enough for governance");
    pass = false;
  }
  if (!KNOWN_TRANSPORTS.has(m.transport)) {
    notes.push(`transport '${m.transport}' not recognised`);
    pass = false;
  }
  if (!KNOWN_ENTRYPOINT_TYPES.has(m.entrypointType)) {
    notes.push(`entrypointType '${m.entrypointType}' not recognised`);
    pass = false;
  }
  if (!m.entrypoint || m.entrypoint.length < 3) {
    notes.push("entrypoint missing");
    pass = false;
  }
  if (!Array.isArray(m.declaredTools) || m.declaredTools.length === 0) {
    notes.push("no declared_tools — MCP declares no capability surface");
    pass = false;
  }
  const s = pass ? 1 : Math.max(0, 1 - notes.length * 0.15);
  return { level: 0, name: "Manifest sanity", pass, score: s, notes };
}

function l1Tools(m: McpManifest): LevelResult {
  const notes: string[] = [];
  let pass = true;
  const seen = new Set<string>();
  for (const t of m.declaredTools || []) {
    if (!t || typeof t.name !== "string" || t.name.length === 0) {
      notes.push("tool with missing name");
      pass = false;
      continue;
    }
    if (seen.has(t.name)) {
      notes.push(`duplicate tool name '${t.name}'`);
      pass = false;
    }
    seen.add(t.name);
    if (!t.description || String(t.description).length < 10) {
      notes.push(`tool '${t.name}' has no meaningful description`);
      // not a hard fail but drops score
    }
    if (!t.input_schema) {
      notes.push(`tool '${t.name}' has no input_schema — untyped surface`);
      pass = false;
    }
  }
  const s = pass ? 1 : Math.max(0, 1 - notes.length * 0.15);
  return { level: 1, name: "Tool schema conformance", pass, score: s, notes };
}

function l2Privileges(m: McpManifest): LevelResult {
  const notes: string[] = [];
  let pass = true;
  const p = m.declaredPrivileges || {};
  const nets = p.net ?? [];
  const fss = p.fs ?? [];
  const envs = p.env ?? [];
  if (nets.includes("*") || nets.includes("0.0.0.0/0")) {
    notes.push("net wildcard declared — CONDITIONAL best case");
    pass = false;
  }
  if (fss.includes("/") || fss.includes("*")) {
    notes.push("fs wildcard declared — CONDITIONAL best case");
    pass = false;
  }
  if (envs.includes("*")) {
    notes.push("env wildcard declared — CONDITIONAL best case");
    pass = false;
  }
  if (nets.length === 0 && fss.length === 0 && envs.length === 0) {
    notes.push("no privileges declared — either truly-sandboxed or under-declared; verify with runtime probe");
  }
  const s = pass ? 1 : 0.5;
  return { level: 2, name: "Privilege honesty", pass, score: s, notes };
}

function l3Adversarial(m: McpManifest): LevelResult {
  // Inspection-only — checks for obvious governance red flags in the manifest.
  // A live-invocation harness is the next step (see mcp-training loop).
  const notes: string[] = [];
  let pass = true;
  const flagPatterns: Array<[RegExp, string]> = [
    [/(exec|eval|run_?shell|arbitrary_?code)/i, "tool name suggests arbitrary code exec"],
    [/(secrets|credentials|keys)/i, "tool exposes secrets — must be reviewer-gated"],
    [/(delete_?all|drop_?db|nuke)/i, "destructive tool name"],
  ];
  for (const t of m.declaredTools || []) {
    for (const [re, msg] of flagPatterns) {
      if (re.test(t.name) || (t.description && re.test(String(t.description)))) {
        notes.push(`${msg}: tool '${t.name}'`);
        pass = false;
      }
    }
  }
  const s = pass ? 1 : Math.max(0.2, 1 - notes.length * 0.3);
  return { level: 3, name: "Adversarial harness (static)", pass, score: s, notes };
}

function l4Reviewer(_m: McpManifest): LevelResult {
  // L4 is never auto-passed. A CERTIFIED grade requires a human reviewer to
  // set gate_grade to CERTIFIED explicitly through a separate endpoint.
  return {
    level: 4,
    name: "Reviewer sign-off",
    pass: false,
    score: 0,
    notes: ["awaiting human reviewer — POST /api/mcps/:slug/certify"],
  };
}

/** Grade the report using the standard L0-L4 rubric. */
function grade(overall: number, l0Pass: boolean, l4Pass: boolean): McpGateReport["grade"] {
  if (!l0Pass) return "FAILED";
  if (overall < 40) return "FAILED";
  if (overall < 65) return "CONDITIONAL";
  if (l4Pass) return "CERTIFIED";
  return "CONDITIONAL"; // capped without human sign-off
}

export function validateMcp(manifest: McpManifest): McpGateReport {
  const t0 = Date.now();
  const levels: LevelResult[] = [
    l0Manifest(manifest),
    l1Tools(manifest),
    l2Privileges(manifest),
    l3Adversarial(manifest),
    l4Reviewer(manifest),
  ];
  // Weighted score: L0 30, L1 20, L2 20, L3 20, L4 10
  const weights = [30, 20, 20, 20, 10];
  const overall = Math.round(
    levels.reduce((acc, lvl, i) => acc + score(lvl, 1) * weights[i], 0),
  );
  const g = grade(overall, levels[0].pass, levels[4].pass);
  return {
    slug: manifest.slug,
    overallScore: overall,
    grade: g,
    levels,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  };
}
