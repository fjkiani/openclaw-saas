/**
 * numerical.ts — Guardian B: Numerical Consistency (deterministic).
 *
 * Every number the answer_text asserts about a named metric must agree (within
 * RIGOR_NUM_TOLERANCE) with the same metric's value in the artifacts (JSON/CSV).
 * Canonical failure: answer says "ECE is now 0.03" but the artifact reports
 * {"ece": 0.22}. That is exactly the class of slop this catches.
 *
 * Approach:
 *   1. Flatten all numeric values found in artifacts, keyed by nearby token
 *      (JSON keys, CSV headers). Build metric -> number index.
 *   2. Extract "<metric-ish token> ... <number>" pairs from answer_text.
 *   3. For each text pair whose metric matches an artifact metric, compare.
 *      Any mismatch beyond tolerance → REJECT citing both values.
 *
 * No LLM. Pure. If there are no artifacts or no comparable metrics, the
 * guardian passes (it only fails on a *contradiction*, not on absence).
 */

import type { ExecutorEnvelope, GuardianVerdict } from "../types.js";

const TOLERANCE = Number(process.env.RIGOR_NUM_TOLERANCE ?? "0.01");

// Metric tokens we care about (extendable). Matched case-insensitively as whole
// words or JSON keys. Kept broad enough for the "agent creates a skill" +
// eval-metric use cases (ECE, accuracy, f1, latency, score, etc.).
const METRIC_TOKENS = [
  "ece", "accuracy", "acc", "precision", "recall", "f1", "auc", "auroc",
  "loss", "latency", "throughput", "score", "rate", "coverage", "mae", "rmse",
  "brier", "calibration", "pass", "fail", "count", "n", "tokens", "cost",
];

interface MetricValue {
  metric: string;
  value: number;
  source: string;
}

function flattenNumbers(obj: unknown, path: string, out: MetricValue[]): void {
  if (obj == null) return;
  if (typeof obj === "number" && Number.isFinite(obj)) {
    const key = path.split(/[.\[\]]/).filter(Boolean).pop() ?? path;
    out.push({ metric: key.toLowerCase(), value: obj, source: path });
    return;
  }
  if (typeof obj === "string") {
    const n = Number(obj.trim());
    if (obj.trim() !== "" && Number.isFinite(n)) {
      const key = path.split(/[.\[\]]/).filter(Boolean).pop() ?? path;
      out.push({ metric: key.toLowerCase(), value: n, source: path });
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenNumbers(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flattenNumbers(v, path ? `${path}.${k}` : k, out);
    }
  }
}

function parseCsvNumbers(csv: string, name: string, out: MetricValue[]): void {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return;
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(",");
    headers.forEach((h, c) => {
      const n = Number((cells[c] ?? "").trim());
      if (cells[c] != null && cells[c].trim() !== "" && Number.isFinite(n)) {
        out.push({ metric: h, value: n, source: `${name}:row${r}:${h}` });
      }
    });
  }
}

function artifactMetrics(env: ExecutorEnvelope): MetricValue[] {
  const out: MetricValue[] = [];
  for (const art of env.artifacts ?? []) {
    const mime = (art.mime || "").toLowerCase();
    const nameLc = (art.name || "").toLowerCase();
    if (mime.includes("json") || nameLc.endsWith(".json")) {
      try {
        flattenNumbers(JSON.parse(art.content), "", out);
      } catch {
        /* not valid JSON — skip */
      }
    } else if (mime.includes("csv") || nameLc.endsWith(".csv")) {
      parseCsvNumbers(art.content, art.name, out);
    } else {
      // Try JSON anyway (many artifacts are JSON without a mime).
      try {
        flattenNumbers(JSON.parse(art.content), "", out);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// Extract (metric, number) assertions from prose.
interface TextClaim {
  metric: string;
  value: number;
  snippet: string;
}

// Tokenize the text into an ordered stream of {kind, ...} positions for metric
// tokens and numbers, then bind each metric to the NEAREST number — but never
// across an intervening metric token. This prevents "Accuracy reached 0.91 and
// F1 was 0.88" from binding 0.91 to f1: the accuracy token sits between 0.91
// and f1 on the left, and 0.88 is the nearest number to f1 on the right.
interface Tok {
  kind: "metric" | "number";
  index: number;
  end: number;
  metric?: string;
  value?: number;
  raw?: string;
}

// A number NOT glued to a letter. The leading (?<![A-Za-z]) drops the "1" in
// "F1"/"auc2" (which is part of a metric name, not a measurement); the trailing
// (?![A-Za-z]) drops "3d" etc. Capture group 1 is the numeric literal.
const NUM_G = /(?<![A-Za-z])([-+]?\d*\.?\d+(?:e[-+]?\d+)?%?)(?![A-Za-z])/gi;

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  // numbers
  let m: RegExpExecArray | null;
  NUM_G.lastIndex = 0;
  while ((m = NUM_G.exec(text)) !== null) {
    const raw = m[1];
    let value = Number(raw.replace("%", ""));
    if (raw.includes("%")) value = value / 100;
    if (Number.isFinite(value)) {
      toks.push({ kind: "number", index: m.index, end: m.index + m[0].length, value, raw });
    }
  }
  // metric tokens (whole-word, case-insensitive)
  for (const token of METRIC_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`, "gi");
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text)) !== null) {
      toks.push({
        kind: "metric",
        index: mm.index,
        end: mm.index + mm[0].length,
        metric: token.toLowerCase(),
      });
    }
  }
  toks.sort((a, b) => a.index - b.index);
  return toks;
}

function textClaims(text: string): TextClaim[] {
  const toks = tokenize(text);
  const claims: TextClaim[] = [];
  const AFTER_WINDOW = 24; // chars: "metric ... = 0.9"
  const BEFORE_WINDOW = 16; // chars: "0.03 ECE", "92% accuracy"

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "metric") continue;

    // Look right for the nearest number, stopping at the next metric token.
    let right: Tok | null = null;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].kind === "metric") break; // barrier
      if (toks[j].kind === "number") {
        right = toks[j];
        break;
      }
    }
    // Look left for the nearest number, stopping at the previous metric token.
    let left: Tok | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (toks[j].kind === "metric") break; // barrier
      if (toks[j].kind === "number") {
        left = toks[j];
        break;
      }
    }

    // Prefer a number AFTER the metric within the after-window; else a number
    // BEFORE within the (tighter) before-window; else the closer of the two.
    let chosen: Tok | null = null;
    const rightGap = right ? right.index - t.end : Infinity;
    const leftGap = left ? t.index - left.end : Infinity;
    if (right && rightGap <= AFTER_WINDOW) chosen = right;
    else if (left && leftGap <= BEFORE_WINDOW) chosen = left;
    else if (right && rightGap <= leftGap && rightGap <= AFTER_WINDOW) chosen = right;
    else if (left && leftGap <= BEFORE_WINDOW) chosen = left;

    if (chosen && chosen.value !== undefined) {
      const lo = Math.min(t.index, chosen.index);
      const hi = Math.max(t.end, chosen.end);
      claims.push({
        metric: t.metric as string,
        value: chosen.value,
        snippet: text.slice(lo, hi).trim(),
      });
    }
  }
  return claims;
}

function withinTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= TOLERANCE) return true;
  // also allow relative tolerance for large magnitudes (latency, tokens…)
  const rel = diff / Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return rel <= TOLERANCE;
}

export function numericalGuardian(env: ExecutorEnvelope): GuardianVerdict {
  const artMetrics = artifactMetrics(env);
  const claims = textClaims(env.answer_text ?? "");

  const evidence: string[] = [];
  const mismatches: Array<{ metric: string; text: number; artifact: number; snippet: string }> = [];
  let comparisons = 0;

  for (const claim of claims) {
    const candidates = artMetrics.filter((a) => a.metric === claim.metric);
    if (candidates.length === 0) continue;
    // A claim is satisfied if it matches ANY artifact value for that metric.
    const anyMatch = candidates.some((c) => withinTolerance(claim.value, c.value));
    comparisons++;
    if (!anyMatch) {
      const closest = candidates.reduce((p, c) =>
        Math.abs(c.value - claim.value) < Math.abs(p.value - claim.value) ? c : p,
      );
      mismatches.push({
        metric: claim.metric,
        text: claim.value,
        artifact: closest.value,
        snippet: claim.snippet,
      });
    }
  }

  if (mismatches.length > 0) {
    for (const mm of mismatches) {
      evidence.push(
        `text asserts ${mm.metric.toUpperCase()}=${mm.text} ("${mm.snippet}") but artifact reports ${mm.metric.toUpperCase()}=${mm.artifact}`,
      );
    }
    return {
      guardian: "numerical",
      pass: false,
      reason: `Numerical inconsistency: ${mismatches.length} metric value(s) in the answer contradict the artifacts (tolerance ${TOLERANCE}).`,
      evidence,
      severity: "high",
      score: 0,
      mode: "deterministic",
      detail: { mismatches, comparisons, artifact_metric_count: artMetrics.length },
    };
  }

  return {
    guardian: "numerical",
    pass: true,
    reason:
      comparisons > 0
        ? `All ${comparisons} numeric claim(s) agree with artifacts within tolerance ${TOLERANCE}.`
        : "No comparable numeric metric claims to verify against artifacts.",
    evidence,
    severity: "low",
    score: 1,
    mode: "deterministic",
    detail: { comparisons, artifact_metric_count: artMetrics.length },
  };
}
