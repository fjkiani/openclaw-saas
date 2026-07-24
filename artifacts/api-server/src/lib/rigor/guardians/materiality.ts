/**
 * materiality.ts — Guardian A: Materiality (deterministic).
 *
 * The core anti-slop guardian: a claim of success/fix must correspond to a real
 * materialized change, and any code that IS materialized must not itself be slop.
 *
 * Three sub-engines (AND-combined):
 *   (i)   Claim-vs-artifact: if answer_text claims success ("PASS", "now passes",
 *         "fixed", "resolved", "implemented"), there must be at least one artifact
 *         or an applicable edit block. A success claim with nothing materialized
 *         is the canonical slop → REJECT.
 *   (ii)  SEARCH/REPLACE applicability (Aider port): every edit_block must apply
 *         cleanly to the virtual artifact FS. A non-applicable diff → REJECT with
 *         SearchReplaceNoExactMatch feedback.
 *   (iii) aislop (real dep): write code artifacts to a temp dir, run
 *         `aislop scan --json`, REJECT if score < RIGOR_AISLOP_MIN or any
 *         high-confidence ai-slop error fires (swallowed exception, `as any`,
 *         dead code, TODO stub, hallucinated import, oversized fn, …).
 *
 * aislop is invoked as an EXTERNAL CLI (local bin, npx fallback) over a temp
 * dir — never bundled into the server. If aislop cannot run (not installed / no
 * code artifacts), sub-engine (iii) is skipped and reported honestly.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ExecutorEnvelope, GuardianVerdict, RigorArtifact } from "../types.js";
import { parseEditBlocks, applyEditBlocks } from "../searchReplace.js";
import { logger } from "../../logger.js";

const AISLOP_MIN = Number(process.env.RIGOR_AISLOP_MIN ?? "70");
// How many `ai-slop/*` indicators (of ANY severity) are tolerated before REJECT.
// aislop's ai-slop engine rules ARE the anti-slop signal we wired in, so even
// "warning"/"info" indicators (unsafe `as any`, TODO stubs, dead code, narrative
// comments) count. Default 0 → any ai-slop indicator fails materiality.
const AISLOP_MAX_INDICATORS = Number(process.env.RIGOR_AISLOP_MAX_INDICATORS ?? "0");

// Success-claim lexicon: presence of these + no materialization = slop.
const SUCCESS_CLAIM_RE =
  /\b(pass(?:es|ed)?|now (?:passes|works)|fixed|resolved|implemented|completed|works now|is (?:correct|working)|succeeds?|done)\b/i;

const CODE_EXT_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|scala|sh|mjs|cjs)$/i;

function isCodeArtifact(a: RigorArtifact): boolean {
  const nameLc = (a.name || "").toLowerCase();
  const mimeLc = (a.mime || "").toLowerCase();
  return (
    CODE_EXT_RE.test(nameLc) ||
    mimeLc.includes("typescript") ||
    mimeLc.includes("javascript") ||
    mimeLc.includes("python") ||
    mimeLc.includes("text/x-") ||
    mimeLc.includes("application/x-")
  );
}

// ── aislop runner (real dependency, external CLI) ─────────────────────────────
interface AislopResult {
  ran: boolean;
  score?: number;
  label?: string;
  aiSlopIndicators?: Array<{
    rule: string;
    message: string;
    line: number;
    severity: string;
    confidence: string;
  }>;
  reason?: string;
}

function resolveAislopBin(): { cmd: string; args: string[] } | null {
  // Prefer the api-server's own node_modules/.bin, then repo root, then npx.
  const candidates = [
    join(process.cwd(), "node_modules", ".bin", "aislop"),
    join(process.cwd(), "..", "..", "node_modules", ".bin", "aislop"),
    "/workspace/openclaw-saas/node_modules/.bin/aislop",
    "/workspace/openclaw-saas/artifacts/api-server/node_modules/.bin/aislop",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: c, args: [] };
  }
  // npx fallback (offline-tolerant: --no-install so it never hits the network mid-request)
  return { cmd: "npx", args: ["--no-install", "aislop"] };
}

function runAislop(codeArtifacts: RigorArtifact[]): AislopResult {
  if (codeArtifacts.length === 0) {
    return { ran: false, reason: "no code artifacts to scan" };
  }
  const bin = resolveAislopBin();
  if (!bin) return { ran: false, reason: "aislop binary not resolvable" };

  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "rigor-aislop-"));
    for (const art of codeArtifacts) {
      const safeName = art.name.replace(/\.\.(\/|\\)/g, "").replace(/^(\/|\\)+/, "");
      const full = join(dir, safeName);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, art.content, "utf8");
    }
    const proc = spawnSync(bin.cmd, [...bin.args, "scan", "--json", dir], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (proc.error || typeof proc.stdout !== "string" || proc.stdout.trim() === "") {
      return {
        ran: false,
        reason: `aislop did not produce JSON (${proc.error ? String(proc.error) : "empty stdout"})`,
      };
    }
    const parsed = JSON.parse(proc.stdout) as {
      score?: number;
      label?: string;
      diagnostics?: Array<{
        rule: string;
        message: string;
        line: number;
        severity: string;
        engine: string;
        assessment?: { confidence?: string; kind?: string };
      }>;
    };
    // Every `ai-slop/*` engine diagnostic is an anti-slop signal we deliberately
    // wired in — regardless of severity. aislop's own severity depends on project
    // context (a swallowed exception can surface as error, warning, or info), so
    // gating on severity alone is too lenient. We count ALL ai-slop indicators and
    // let RIGOR_AISLOP_MAX_INDICATORS decide tolerance. Other engines (eslint, tsc)
    // are advisory here and do not gate materiality.
    const aiSlopIndicators = (parsed.diagnostics ?? [])
      .filter((d) => d.engine === "ai-slop")
      .map((d) => ({
        rule: d.rule,
        message: d.message,
        line: d.line,
        severity: d.severity ?? "n/a",
        confidence: d.assessment?.confidence ?? "n/a",
      }));
    return {
      ran: true,
      score: typeof parsed.score === "number" ? parsed.score : undefined,
      label: parsed.label,
      aiSlopIndicators,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "[rigor.materiality] aislop run failed");
    return { ran: false, reason: `aislop run threw: ${String(err)}` };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

export function materialityGuardian(env: ExecutorEnvelope): GuardianVerdict {
  const evidence: string[] = [];
  const detail: Record<string, unknown> = {};
  const text = env.answer_text ?? "";
  const artifacts = env.artifacts ?? [];
  const editBlocks = env.edit_blocks ?? [];
  const claimsSuccess =
    SUCCESS_CLAIM_RE.test(text) ||
    (env.claims ?? []).some((c) => c.kind === "success");
  const hasMaterialization = artifacts.length > 0 || editBlocks.length > 0;

  // ── (i) Claim-vs-artifact ───────────────────────────────────────────────────
  if (claimsSuccess && !hasMaterialization) {
    evidence.push(
      `answer claims success/fix but produced no artifact and no edit block: "${text.slice(0, 160)}"`,
    );
    return {
      guardian: "materiality",
      pass: false,
      reason: "Claim of success/fix with nothing materialized (no artifact, no applicable edit).",
      evidence,
      severity: "critical",
      score: 0,
      mode: "deterministic",
      detail: { claimsSuccess, hasMaterialization },
    };
  }

  // ── (ii) SEARCH/REPLACE applicability ───────────────────────────────────────
  if (editBlocks.length > 0) {
    // Build the virtual FS from artifacts (name -> content), so an edit can
    // target an artifact the executor also shipped, or a pre-existing file the
    // caller seeded as an artifact.
    const vfs: Record<string, string> = {};
    for (const a of artifacts) vfs[a.name] = a.content;
    const blocks = parseEditBlocks(editBlocks.join("\n\n"));
    if (blocks.length === 0) {
      evidence.push("edit_blocks were provided but no valid SEARCH/REPLACE block could be parsed");
      return {
        guardian: "materiality",
        pass: false,
        reason: "Edit blocks present but unparseable as SEARCH/REPLACE.",
        evidence,
        severity: "high",
        score: 0,
        mode: "deterministic",
        detail: { editBlockCount: editBlocks.length },
      };
    }
    const applied = applyEditBlocks(blocks, vfs);
    detail.searchReplace = {
      blocks: blocks.length,
      applied: applied.applications.filter((a) => a.applied).length,
      failures: applied.failures.length,
    };
    if (!applied.ok) {
      for (const f of applied.failures.slice(0, 3)) evidence.push(f);
      return {
        guardian: "materiality",
        pass: false,
        reason: `${applied.failures.length} SEARCH/REPLACE block(s) did not apply cleanly.`,
        evidence,
        severity: "high",
        score: 0,
        mode: "deterministic",
        detail,
      };
    }
    evidence.push(`${blocks.length} edit block(s) applied cleanly to the artifact FS`);
  }

  // ── (iii) aislop code-quality ───────────────────────────────────────────────
  const codeArtifacts = artifacts.filter(isCodeArtifact);
  const aislop = runAislop(codeArtifacts);
  detail.aislop = aislop;
  if (aislop.ran) {
    const score = aislop.score ?? 0;
    const indicators = aislop.aiSlopIndicators ?? [];
    evidence.push(
      `aislop score ${score}/100 (${aislop.label ?? "n/a"}) over ${codeArtifacts.length} code artifact(s); ${indicators.length} ai-slop indicator(s)`,
    );
    detail.aislopIndicatorCount = indicators.length;
    const scoreFails = score < AISLOP_MIN;
    const indicatorsFail = indicators.length > AISLOP_MAX_INDICATORS;
    if (scoreFails || indicatorsFail) {
      for (const d of indicators.slice(0, 5)) {
        evidence.push(`aislop ${d.rule} @L${d.line} (${d.severity}/${d.confidence}): ${d.message}`);
      }
      const reasons: string[] = [];
      if (scoreFails) reasons.push(`aislop score ${score} < ${AISLOP_MIN}`);
      if (indicatorsFail)
        reasons.push(
          `${indicators.length} ai-slop indicator(s) > ${AISLOP_MAX_INDICATORS} tolerated`,
        );
      return {
        guardian: "materiality",
        pass: false,
        reason: `Code quality gate failed: ${reasons.join("; ")}.`,
        evidence,
        severity: "high",
        score: Math.max(0, Math.min(1, score / 100)),
        mode: "deterministic",
        detail,
      };
    }
  } else {
    evidence.push(`aislop not run: ${aislop.reason}`);
  }

  return {
    guardian: "materiality",
    pass: true,
    reason: hasMaterialization
      ? "Claims are materialized; edits apply; code quality acceptable."
      : "No success claim requiring materialization; nothing to reject.",
    evidence,
    severity: "low",
    score: 1,
    mode: "deterministic",
    detail,
  };
}
