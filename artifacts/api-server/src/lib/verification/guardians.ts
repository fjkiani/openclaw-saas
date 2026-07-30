/**
 * guardians.ts — reusable, domain-agnostic guardian factories.
 *
 * These are the building blocks each DomainAdapter composes. A domain provides configuration
 * (what counts as a placeholder, which numbers to check, where the source of truth is) and gets
 * a fully-formed Guardian back. This is what makes onboarding a new domain small.
 *
 * Four canonical kinds, matching the anti-slop framework:
 *   materiality — did it actually produce real content (vs placeholder/empty)?
 *   numerical   — do asserted numbers match the source of truth?
 *   hedge       — is it committing, or dodging with weasel words?
 *   rubric      — LLM-judge on quality axes (live via modelRouter, else dry + degraded).
 */

import type { Guardian, GuardianResult, GateContext } from "./verificationCore.js";

// ── materiality ────────────────────────────────────────────────────────────
export interface MaterialityConfig {
  /** Extract the text body to inspect from the guardian input. */
  getText: (input: unknown) => string;
  /** Optional: a domain-supplied structural verdict (e.g. legal verifyDraft). If it returns
   *  {passed:false, reasons}, materiality fails with those reasons. */
  structural?: (input: unknown) => { passed: boolean; reasons: string[] } | null;
  /** Substrings that mark unfinished/placeholder output. */
  placeholderMarkers?: string[];
  /** Minimum body length to be considered "real work". */
  minLength?: number;
}

const DEFAULT_PLACEHOLDERS = ["TODO", "TBD", "FIXME", "PLACEHOLDER", "{{", "}}", "<insert", "lorem ipsum", "xxxx"];

export function makeMaterialityGuardian(cfg: MaterialityConfig): Guardian<unknown> {
  const markers = (cfg.placeholderMarkers ?? DEFAULT_PLACEHOLDERS).map((m) => m.toLowerCase());
  const minLen = cfg.minLength ?? 50;
  return {
    name: "materiality",
    run(input): GuardianResult {
      const reasons: string[] = [];
      const text = (cfg.getText(input) ?? "").toString();
      const lower = text.toLowerCase();

      if (text.trim().length < minLen) {
        reasons.push(`output too short to be real work (${text.trim().length} < ${minLen} chars)`);
      }
      const hits = markers.filter((m) => lower.includes(m));
      if (hits.length) reasons.push(`placeholder/unfinished markers present: ${hits.join(", ")}`);

      // Domain-supplied structural check (deterministic, e.g. legal verifyDraft).
      if (cfg.structural) {
        const s = cfg.structural(input);
        if (s && !s.passed) reasons.push(...s.reasons);
      }

      return {
        guardian: "materiality",
        status: reasons.length ? "fail" : "pass",
        live: false, // deterministic check
        reasons: reasons.length ? reasons : ["real, complete content; no placeholders; structural checks pass"],
        evidence: { length: text.trim().length, placeholder_hits: hits },
      };
    },
  };
}

// ── numerical ────────────────────────────────────────────────────────────────
export interface NumericClaim {
  /** Human label, e.g. "83b_window_days". */
  label: string;
  /** The value the OUTPUT asserts (parsed from the body). */
  claimed: number | null;
  /** The value the SOURCE OF TRUTH requires (intake/spec/artifact). */
  expected: number | null;
  /** Allowed absolute tolerance (default 0 = exact). */
  tol?: number;
}

export interface NumericalConfig {
  /** Domain supplies the list of claims to check by parsing input + source of truth. */
  extractClaims: (input: unknown) => NumericClaim[];
}

export function makeNumericalGuardian(cfg: NumericalConfig): Guardian<unknown> {
  return {
    name: "numerical",
    run(input): GuardianResult {
      const claims = cfg.extractClaims(input) ?? [];
      const mismatches: string[] = [];
      const checked: Record<string, unknown> = {};
      for (const c of claims) {
        checked[c.label] = { claimed: c.claimed, expected: c.expected };
        if (c.expected == null) continue; // nothing to check against
        if (c.claimed == null) {
          mismatches.push(`${c.label}: source requires ${c.expected} but output asserts nothing`);
          continue;
        }
        const tol = c.tol ?? 0;
        if (Math.abs(c.claimed - c.expected) > tol) {
          mismatches.push(`${c.label}: output says ${c.claimed}, source of truth is ${c.expected}`);
        }
      }
      return {
        guardian: "numerical",
        status: mismatches.length ? "fail" : "pass",
        live: false,
        reasons: mismatches.length ? mismatches : [`all ${claims.length} numeric claims match source of truth`],
        evidence: { claims: checked },
      };
    },
  };
}

// ── hedge ──────────────────────────────────────────────────────────────────
// Deterministic weasel-word lexicon. A document that is supposed to be definitive should not be
// riddled with non-committal language. This is intentionally simple + explainable.
const HEDGE_LEXICON = [
  "it depends", "may or may not", "possibly", "perhaps", "arguably", "it seems", "we think",
  "roughly", "sort of", "kind of", "to some extent", "in general it", "generally speaking",
  "could potentially", "might be able to", "not entirely clear", "hard to say", "your mileage",
];

export interface HedgeConfig {
  getText: (input: unknown) => string;
  /** Density threshold: hedges per 1000 chars above which we fail. Default 3. */
  maxPer1k?: number;
  /** Absolute-count threshold: fail if the body contains >= this many hedge phrases, regardless of
   *  length. This catches a concentrated hedge cluster in a long document (e.g. a definitive legal
   *  contract) that density alone would dilute. Default undefined (density-only). */
  maxCount?: number;
  lexicon?: string[];
}

export function makeHedgeGuardian(cfg: HedgeConfig): Guardian<unknown> {
  const lex = (cfg.lexicon ?? HEDGE_LEXICON).map((h) => h.toLowerCase());
  const maxPer1k = cfg.maxPer1k ?? 3;
  const maxCount = cfg.maxCount;
  return {
    name: "hedge",
    run(input): GuardianResult {
      const text = (cfg.getText(input) ?? "").toString();
      const lower = text.toLowerCase();
      const found: string[] = [];
      for (const h of lex) {
        let idx = lower.indexOf(h);
        while (idx !== -1) {
          found.push(h);
          idx = lower.indexOf(h, idx + h.length);
        }
      }
      const per1k = text.length > 0 ? (found.length * 1000) / text.length : 0;
      const densityFail = per1k > maxPer1k;
      const countFail = maxCount != null && found.length >= maxCount;
      const fail = densityFail || countFail;
      const why = countFail
        ? `absolute count ${found.length} >= ${maxCount}`
        : `density ${per1k.toFixed(2)}/1k > ${maxPer1k}`;
      return {
        guardian: "hedge",
        status: fail ? "fail" : "pass",
        score: Number(per1k.toFixed(2)),
        live: false,
        reasons: fail
          ? [`too much hedging (${why}): ${found.length} weasel phrases (${[...new Set(found)].join(", ")})`]
          : [`committing language; ${found.length} hedge phrases, density ${per1k.toFixed(2)}/1k within limits`],
        evidence: { hedge_count: found.length, density_per_1k: Number(per1k.toFixed(2)), phrases: [...new Set(found)], densityFail, countFail },
      };
    },
  };
}

// ── self-consistency ───────────────────────────────────────────────────────
/**
 * Does the document contradict ITSELF?
 *
 * Section headings routinely carry a summarised quantity ("## Vesting Schedule — 4yr/1yr cliff")
 * that a templating engine can leave stale while the body underneath is substituted with different
 * values ("Equity shall vest over 2 years, with a cliff of 3 months"). Neither the numerical
 * guardian (which compares body vs intake) nor a rubric judge reading for quality reliably catches
 * that, because each half of the document is defensible on its own.
 *
 * This is the only guardian kind here that needs NO source of truth — it compares the artifact
 * against itself. That is why it is worth having: it still works when the ground-truth label is
 * itself wrong, which is exactly how a defective document survived this benchmark's own "clean"
 * label until a judge disagreed with us.
 *
 * Quantities are compared inside a dimension with unit normalisation, so "1yr" in a heading is
 * satisfied by "12 months" in the body. Bare numbers with no unit (e.g. "Section 83(b)") are
 * ignored on purpose: this guardian fails closed on the verdict, so its own trigger must be
 * precise rather than eager.
 */
export interface SelfConsistencyConfig {
  getText: (input: unknown) => string;
  /** Heading matcher; capture group 1 is the title. Default markdown H2. Must NOT be global. */
  headingPattern?: RegExp;
  /** Absolute tolerance on the dimension's base scale (default 0 = exact). */
  tol?: number;
  /** Also fail when a heading quantity has no same-dimension quantity anywhere in its body.
   *  Default false — that is under-specification, not a contradiction. */
  failOnUnsupported?: boolean;
}

interface Quantity {
  value: number;
  unit: string;
  dim: string;
  base: number;
  raw: string;
}

const UNIT_ALIASES: Record<string, string> = {
  yr: "years", yrs: "years", year: "years", years: "years",
  mo: "months", mos: "months", month: "months", months: "months",
  day: "days", days: "days",
  "%": "percent", pct: "percent", percent: "percent",
};

/** dim groups what may be compared; toBase converts within a dim (duration base = months).
 *  days is its own dim on purpose: 30 days is not exactly 1 month, and guessing would create
 *  false contradictions in exactly the documents this is meant to protect. */
const UNIT_DIMS: Record<string, { dim: string; toBase: number }> = {
  years: { dim: "duration", toBase: 12 },
  months: { dim: "duration", toBase: 1 },
  days: { dim: "days", toBase: 1 },
  percent: { dim: "percent", toBase: 1 },
  dollars: { dim: "money", toBase: 1 },
};

const QTY_RE = /(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?|days?|percent|pct|%)(?![a-z])/gi;
const MONEY_RE = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g;

export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const src = (text ?? "").toString();
  for (const m of src.matchAll(QTY_RE)) {
    const unit = UNIT_ALIASES[m[2].toLowerCase()];
    if (!unit) continue;
    const spec = UNIT_DIMS[unit];
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit, dim: spec.dim, base: value * spec.toBase, raw: m[0].trim() });
  }
  for (const m of src.matchAll(MONEY_RE)) {
    const value = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: "dollars", dim: "money", base: value, raw: m[0].trim() });
  }
  return out;
}

const DEFAULT_HEADING = /^##\s+(.+?)\s*$/;

export function splitSections(text: string, headingPattern: RegExp = DEFAULT_HEADING): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of (text ?? "").toString().split(/\r?\n/)) {
    const m = line.match(headingPattern);
    if (m) {
      if (cur) sections.push({ title: cur.title, body: cur.lines.join("\n") });
      cur = { title: m[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push({ title: cur.title, body: cur.lines.join("\n") });
  return sections;
}

export function makeSelfConsistencyGuardian(cfg: SelfConsistencyConfig): Guardian<unknown> {
  const headingPattern = cfg.headingPattern ?? DEFAULT_HEADING;
  const tol = cfg.tol ?? 0;
  return {
    name: "self_consistency",
    run(input): GuardianResult {
      const text = (cfg.getText(input) ?? "").toString();
      const sections = splitSections(text, headingPattern);
      const contradictions: string[] = [];
      const unsupported: string[] = [];
      const detail: Array<Record<string, unknown>> = [];

      for (const s of sections) {
        const headingQs = extractQuantities(s.title);
        if (!headingQs.length) continue;
        const bodyQs = extractQuantities(s.body);
        for (const hq of headingQs) {
          const comparable = bodyQs.filter((b) => b.dim === hq.dim);
          if (!comparable.length) {
            unsupported.push(`heading "${s.title}" claims ${hq.raw} but its body states no ${hq.dim} value`);
            continue;
          }
          const satisfied = comparable.some((b) => Math.abs(b.base - hq.base) <= tol);
          if (!satisfied) {
            contradictions.push(
              `heading "${s.title}" claims ${hq.raw} but its body states ${comparable.map((b) => b.raw).join(", ")}`,
            );
            detail.push({ section: s.title, heading_claim: hq.raw, heading_base: hq.base, dim: hq.dim, body_values: comparable.map((b) => b.raw) });
          }
        }
      }

      const reasons = [...contradictions, ...(cfg.failOnUnsupported ? unsupported : [])];
      return {
        guardian: "self_consistency",
        status: reasons.length ? "fail" : "pass",
        live: false,
        reasons: reasons.length
          ? reasons
          : [`headings and bodies agree across ${sections.length} sections (${contradictions.length} contradictions)`],
        evidence: { sections_scanned: sections.length, contradictions: detail, unsupported },
      };
    },
  };
}

// ── required entities ──────────────────────────────────────────────────────
/**
 * Every entity the artifact is ABOUT must actually appear in it.
 *
 * A generated document that never names its own subject is not usable output, however well-formed
 * it reads. Templating engines produce this silently when a field is deferred to a section that is
 * never emitted ("the parties identified in the signature block below" with no signature block).
 *
 * Domain-agnostic: the domain supplies the entity list from its trusted input (intake parties,
 * a spec's resource names, a query's target tables).
 */
export interface RequiredEntity {
  label: string;
  /** Any one of these strings appearing in the text satisfies the requirement. */
  any: string[];
}

export interface RequiredEntitiesConfig {
  getText: (input: unknown) => string;
  getEntities: (input: unknown) => RequiredEntity[];
  /** Lowercase + collapse whitespace before matching (default true). */
  normalize?: boolean;
}

export function makeRequiredEntitiesGuardian(cfg: RequiredEntitiesConfig): Guardian<unknown> {
  const norm = (s: string) => (cfg.normalize === false ? s : s.toLowerCase().replace(/\s+/g, " ").trim());
  return {
    name: "required_entities",
    run(input): GuardianResult {
      const hay = norm((cfg.getText(input) ?? "").toString());
      const entities = cfg.getEntities(input) ?? [];
      const missing: string[] = [];
      const present: string[] = [];
      for (const e of entities) {
        const alts = e.any.map((a) => norm(a)).filter((a) => a.length > 0);
        if (!alts.length) continue;
        const hit = alts.find((a) => hay.includes(a));
        if (hit) present.push(e.label);
        else missing.push(`${e.label} never appears in the output (looked for: ${e.any.join(" | ")})`);
      }
      return {
        guardian: "required_entities",
        status: missing.length ? "fail" : "pass",
        live: false,
        reasons: missing.length ? missing : [`all ${present.length} required entities are named in the output`],
        evidence: { n_required: entities.length, present, n_missing: missing.length },
      };
    },
  };
}

// ── rubric (LLM judge) ─────────────────────────────────────────────────────
// Reuses the repo's modelRouter (Groq→OpenRouter fallback). If no key is available, it falls back
// to a deterministic heuristic and reports status:"degraded" + live:false, so a dry judge can NEVER
// silently produce a trustworthy PASS (fail-closed).
export interface RubricConfig {
  getText: (input: unknown) => string;
  /** Axes to score. Default matches the anti-slop rubric. */
  axes?: string[];
  minScore?: number; // overall pass floor (0..1). Default 0.8
  axisFloor?: number; // every-axis floor (0..1). Default 0.5
  /** Injected model-invoker for testability. Returns {overall, axisScores} in 0..1 or throws. */
  invoke?: (systemPrompt: string, userContent: string) => Promise<{ overall: number; axisScores: Record<string, number>; model_used: string }>;
  /** Force dry-run (no model). Also inferred when no API key env is set. */
  dryRun?: boolean;
}

const DEFAULT_AXES = ["materiality", "numerical_grounding", "decisiveness", "completeness", "actionability"];

function hasAnyKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
}

export function makeRubricGuardian(cfg: RubricConfig): Guardian<unknown> {
  const axes = cfg.axes ?? DEFAULT_AXES;
  const minScore = cfg.minScore ?? 0.8;
  const axisFloor = cfg.axisFloor ?? 0.5;

  return {
    name: "rubric",
    async run(input, ctx: GateContext): Promise<GuardianResult> {
      const text = (cfg.getText(input) ?? "").toString();
      const dry = cfg.dryRun || (!cfg.invoke && !hasAnyKey()) || !ctx.live;

      if (dry) {
        // Deterministic heuristic ONLY as a degraded fallback — never a trustworthy PASS.
        // We still compute a signal so the benchmark can show dry-vs-live behavior, but status is
        // "degraded" so fail-closed keeps the verdict honest.
        const lengthOk = text.trim().length >= 200;
        const heuristic = lengthOk ? 0.7 : 0.3;
        return {
          guardian: "rubric",
          status: "degraded",
          score: heuristic,
          live: false,
          reasons: [
            "rubric ran DRY (no live model / live disabled) — deterministic heuristic only, cannot be trusted as PASS",
          ],
          evidence: { dry: true, heuristic, axes },
        };
      }

      // Live path.
      const sys =
        "You are a strict verification judge. Score the OUTPUT on each axis from 0.0 to 1.0 and give an overall 0.0-1.0. " +
        "Respond ONLY as compact JSON: {\"overall\":n,\"axes\":{" + axes.map((a) => `\"${a}\":n`).join(",") + "}}.";
      const user = `AXES: ${axes.join(", ")}\n\nOUTPUT TO JUDGE:\n${text.slice(0, 8000)}`;

      let overall: number;
      let axisScores: Record<string, number>;
      let modelUsed = "unknown";
      try {
        const invoker = cfg.invoke ?? defaultInvoke(axes);
        const res = await invoker(sys, user);
        overall = res.overall;
        axisScores = res.axisScores;
        modelUsed = res.model_used;
      } catch (err) {
        // Live attempt failed → degraded (fail-closed), not a pass.
        return {
          guardian: "rubric",
          status: "degraded",
          live: false,
          reasons: [`rubric live judge failed: ${err instanceof Error ? err.message : String(err)}`],
          evidence: { dry: false, error: true },
        };
      }

      const minAxis = Math.min(...axes.map((a) => axisScores[a] ?? 0));
      const pass = overall >= minScore && minAxis >= axisFloor;
      return {
        guardian: "rubric",
        status: pass ? "pass" : "fail",
        score: Number(overall.toFixed(3)),
        live: true,
        reasons: pass
          ? [`rubric PASS overall=${overall.toFixed(2)} minAxis=${minAxis.toFixed(2)} (model=${modelUsed})`]
          : [`rubric FAIL overall=${overall.toFixed(2)} (floor ${minScore}) minAxis=${minAxis.toFixed(2)} (floor ${axisFloor}) (model=${modelUsed})`],
        evidence: { dry: false, overall, axisScores, model_used: modelUsed, minScore, axisFloor },
      };
    },
  };
}

/**
 * Judge chain for the rubric guardian. Groq first (fast, generous rate limit), then OpenRouter
 * free slots. Each OpenRouter entry uses a distinct key env so resolveApiKey's key pool gives
 * real rate-limit headroom instead of retrying the same exhausted credential.
 *
 * Slugs are verified against the live OpenRouter model list. The previous default entry
 * (meta-llama/llama-3.3-70b-instruct:free) was retired upstream and returned HTTP 404, which is
 * only visible once the guardian actually runs.
 */
const GEMINI_OPENAI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export const JUDGE_CHAIN = [
  { id: "llama-3.3-70b-versatile", provider: "groq" as const, apiKeyEnv: "GROQ_API_KEY", maxTokens: 300, timeoutMs: 20_000 },
  { id: "openai/gpt-oss-20b:free", provider: "openrouter" as const, apiKeyEnv: "OPENROUTER_API_KEY", maxTokens: 300, timeoutMs: 55_000 },
  { id: "google/gemma-4-31b-it:free", provider: "openrouter" as const, apiKeyEnv: "OPENROUTER_API_KEY_2", maxTokens: 300, timeoutMs: 55_000 },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", provider: "openrouter" as const, apiKeyEnv: "OPENROUTER_API_KEY_3", maxTokens: 300, timeoutMs: 55_000 },
  // Depth added after the first live runs exhausted every entry above within one day. The four
  // entries above draw on two upstream accounts (one Groq, one OpenRouter across three keys), so
  // their per-day token budgets are not independent: when Groq hit its daily token cap the
  // OpenRouter keys were already spent, and the chain reported "rate_limited" on all four at once.
  // Google is a third upstream account with its own per-model daily budget. Reached last, so it
  // does not alter which model answers while the entries above still have quota.
  // provider "local" is the router's existing OpenAI-compatible escape hatch (endpoint from
  // baseUrl, bearer token from apiKeyEnv); Gemini exposes an OpenAI-compatible route, so no new
  // provider branch is needed.
  { id: "gemini-2.5-flash-lite", provider: "local" as const, apiKeyEnv: "GOOGLE_API_KEY", baseUrl: GEMINI_OPENAI_ENDPOINT, maxTokens: 300, timeoutMs: 40_000 },
  { id: "gemini-2.5-flash", provider: "local" as const, apiKeyEnv: "GOOGLE_API_KEY", baseUrl: GEMINI_OPENAI_ENDPOINT, maxTokens: 300, timeoutMs: 40_000 },
];

/** Default live invoker — lazily imports modelRouter so tests can run without it. */
function defaultInvoke(axes: string[]) {
  return async (systemPrompt: string, userContent: string) => {
    const mod = await import("../modelRouter.js");
    const res = await mod.invokeWithFallback(
      { systemPrompt, userContent, title: "rigor-gate-rubric", maxTokens: 300, temperature: 0 },
      JUDGE_CHAIN,
      {
        routeChainId: "rigor-rubric",
        // The judge returns {overall, axes}, not a legal clause. Without "generic" the router's
        // clause-field check rejects every valid judge response as unusable and the chain exhausts.
        schemaType: "generic",
        // Supply real enforcement in place of the clause checks that no longer apply.
        validator: (p: unknown) => {
          const o = p as { overall?: unknown; axes?: Record<string, unknown> };
          const overall = Number(o?.overall);
          if (!Number.isFinite(overall) || overall < 0 || overall > 1) {
            throw new Error(`judge returned no usable "overall" score (got ${JSON.stringify(o?.overall)})`);
          }
          if (!o?.axes || typeof o.axes !== "object") throw new Error('judge returned no "axes" object');
          const missing = axes.filter((a) => !Number.isFinite(Number(o.axes![a])));
          if (missing.length) throw new Error(`judge omitted axes: ${missing.join(", ")}`);
          return p;
        },
      },
    );
    const parsed = typeof res.parsed === "object" && res.parsed ? (res.parsed as any) : JSON.parse(res.raw);
    const axisScores: Record<string, number> = {};
    for (const a of axes) axisScores[a] = Number(parsed?.axes?.[a] ?? 0);
    return { overall: Number(parsed?.overall ?? 0), axisScores, model_used: res.model_used };
  };
}
