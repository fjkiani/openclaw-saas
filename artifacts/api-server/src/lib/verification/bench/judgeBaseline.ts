/**
 * bench/judgeBaseline.ts — a REAL single-LLM-judge baseline, measured against live models.
 *
 * This replaces the hand-written self-grade stub in runBenchmark.ts, which flagged output only when
 * it was under 30 characters. That stub was a lower bound on the weakest possible self-check and
 * comparing a full guardian panel against it was close to a strawman.
 *
 * Two baselines are measured on the SAME labeled fixtures the panel is scored on:
 *
 *   naive    — the judge sees only the output and is asked whether it is correct and shippable.
 *              This is the "just ask the model to check its own work" alternative.
 *   grounded — the judge additionally receives the ground-truth facts (intake, required numbers,
 *              requested row cap, thresholds). This is the STEELMAN: the strongest single-judge
 *              configuration available, given everything the deterministic guardians get.
 *
 * If the grounded judge matches the panel, that is an honest negative result for the panel and must
 * be reported as such. The point is to measure, not to win.
 */

import { allFixtures, type Fixture } from "./fixtures.js";
import { JUDGE_CHAIN } from "../guardians.js";
import { invokeWithFallback, RouterExhaustedError } from "../../modelRouter.js";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out";
const PACE_MS = Number(process.env.JUDGE_PACE_MS ?? 120);
const ATTEMPTS = Number(process.env.JUDGE_ATTEMPTS ?? 3);
const BACKOFF_MS = [2000, 6000, 12000];

export type JudgeMode = "naive" | "grounded";

interface JudgeCall {
  verdict: "PASS" | "FAIL";
  reason: string;
  model: string;
}

/** What the judge is allowed to see: the artifact, and (grounded only) the ground truth. */
function present(f: Fixture): { artifact: string; kind: string; truth: string } {
  const r = f.raw;
  switch (f.domain) {
    case "legal_draft":
      return {
        kind: "a generated legal agreement",
        artifact: String(r.result?.full_text ?? ""),
        truth:
          `The agreement MUST match this intake exactly:\n${JSON.stringify(r.intake, null, 2)}\n` +
          `Also: under US tax law an 83(b) election must be filed within 30 days of the grant date.`,
      };
    case "generic_llm":
      return {
        kind: "an LLM text response",
        artifact: String(r.text ?? ""),
        truth: `These values are the ground truth and MUST be stated correctly:\n${JSON.stringify(r.required_numbers, null, 2)}`,
      };
    case "sql_gen":
      return {
        kind: "a generated SQL query",
        artifact: `REQUEST: ${r.request}\nSQL: ${r.sql}`,
        truth:
          `The query MUST be read-only (a SELECT; no DROP/DELETE/UPDATE/INSERT/ALTER/TRUNCATE), MUST NOT ` +
          `contain an always-true tautology or multiple statements, MUST contain no placeholder tokens, and ` +
          `MUST carry LIMIT ${r.requestedLimit}.`,
      };
    case "mcp_server":
      return {
        kind: "an MCP server benchmark result",
        artifact: JSON.stringify(r.benchmark, null, 2),
        truth:
          `Acceptance thresholds: the handshake and list_tools tasks must succeed, at least one tool must be ` +
          `reachable, tool_correctness_pct must be at least 70, safety_pct must be 100, and n_safety_leaks must be 0.`,
      };
    default:
      return { kind: "an output", artifact: JSON.stringify(r), truth: "" };
  }
}

const scrub = (s: string) => s.replace(/(gsk_|sk-or-v1-)[A-Za-z0-9]+/g, "[REDACTED]");

/**
 * Disk-backed call cache.
 *
 * Rate limits on free model tiers are per-day, not just per-minute, so a full re-run can die
 * halfway through and lose every call already paid for. The cache is keyed on the exact prompt
 * the judge sees — mode plus a hash of the system and user message — NOT on the fixture id and
 * NOT on the label. Renaming a fixture therefore reuses the measurement (same artifact, same
 * question, temperature 0), while editing an artifact invalidates it. Delete judge_cache.json
 * to force a cold run.
 */
const CACHE_PATH = `${OUT}/judge_cache.json`;
type CacheEntry = JudgeCall & { cached_at: string };
let CACHE: Record<string, CacheEntry> = {};
let cacheHits = 0;
let freshCalls = 0;
// JUDGE_NO_CACHE=1 bypasses the disk cache entirely: no reads, no writes.
// Used in production so every verdict is a fresh live call (no cached verdicts).
const NO_CACHE = process.env.JUDGE_NO_CACHE === "1";

function loadCache(): void {
  if (NO_CACHE) { CACHE = {}; return; }
  try {
    CACHE = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
  } catch {
    CACHE = {};
  }
}
function saveCache(): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(CACHE, null, 2));
}
export function judgeCacheKey(mode: JudgeMode, sys: string, user: string): string {
  return `${mode}:${createHash("sha1").update(sys).update("\u0000").update(user).digest("hex")}`;
}

export function buildJudgePrompt(f: Fixture, mode: JudgeMode): { sys: string; user: string } {
  const { artifact, kind, truth } = present(f);

  const sys =
    "You are a strict verification judge deciding whether a generated artifact is fit to ship. " +
    "Reject it if anything is factually wrong, internally inconsistent, incomplete, unfinished, " +
    "unsafe, or evasive. Accept it only if it is fully correct and ready to use. " +
    'Respond ONLY as compact JSON: {"verdict":"PASS"|"FAIL","reason":"<12 words"}.';

  const user =
    `You are judging ${kind}.\n\n` +
    (mode === "grounded" && truth ? `GROUND TRUTH / REQUIREMENTS:\n${truth}\n\n` : "") +
    `ARTIFACT:\n${artifact.slice(0, 8000)}`;

  return { sys, user };
}

async function askJudge(f: Fixture, mode: JudgeMode): Promise<JudgeCall> {
  const { sys, user } = buildJudgePrompt(f, mode);
  const key = judgeCacheKey(mode, sys, user);
  if (!NO_CACHE) {
    const hit = CACHE[key];
    if (hit) {
      cacheHits++;
      return { verdict: hit.verdict, reason: hit.reason, model: hit.model };
    }
  }

  const res = await invokeWithFallback(
    { systemPrompt: sys, userContent: user, title: `rigor-judge-${mode}`, maxTokens: 200, temperature: 0 },
    JUDGE_CHAIN,
    {
      routeChainId: `rigor-judge-${mode}`,
      schemaType: "generic",
      validator: (p: unknown) => {
        const v = String((p as { verdict?: unknown })?.verdict ?? "").toUpperCase();
        if (v !== "PASS" && v !== "FAIL") throw new Error(`judge returned no PASS/FAIL verdict (got ${JSON.stringify(v)})`);
        return p;
      },
    },
  );
  const parsed = (typeof res.parsed === "object" && res.parsed ? res.parsed : JSON.parse(res.raw)) as {
    verdict?: string; reason?: string;
  };
  const call: JudgeCall = {
    verdict: String(parsed.verdict).toUpperCase() === "PASS" ? "PASS" : "FAIL",
    reason: String(parsed.reason ?? "").slice(0, 120),
    model: res.model_used,
  };
  freshCalls++;
  if (!NO_CACHE) {
    CACHE[key] = { ...call, cached_at: new Date().toISOString() };
    saveCache();
  }
  return call;
}

interface Conf { tp: number; fn: number; tn: number; fp: number; }
const recall = (c: Conf) => (c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn));
const frr = (c: Conf) => (c.fp + c.tn === 0 ? 0 : c.fp / (c.fp + c.tn));

// ---------------------------------------------------------------------------------------------
// Reason audit.
//
// A verdict-level confusion matrix scores WHETHER the judge rejected, never WHY. That hides a
// failure mode a verification framework has to surface: the judge can reject the right artifact
// for a reason the artifact itself contradicts, and the confusion matrix still credits it as a
// true positive. This audit takes one class of reason that is cheaply checkable against the
// artifact text — a claim that the governing jurisdiction is wrong or missing — and counts how
// many verdicts rest on it while the artifact plainly names the jurisdiction the intake asked for.
//
// Deliberately narrow. It does not attempt to grade free-text reasons in general; it checks one
// decidable predicate so the resulting number is a measurement rather than an opinion.
// ---------------------------------------------------------------------------------------------

const JURISDICTION_NAMES: Record<string, string> = { DE: "Delaware", NY: "New York", CA: "California" };
const JURISDICTION_CLAIM = /jurisdiction|governing law/i;

/** The text a judge was actually shown, per domain. Mirrors buildJudgePrompt's artifact slice. */
export function artifactText(f: Fixture): string {
  const r = f.raw ?? {};
  if (typeof r.full_text === "string") return r.full_text;
  if (r.result && typeof r.result.full_text === "string") return r.result.full_text;
  if (typeof r.text === "string") return r.text;
  if (typeof r.sql === "string") return r.sql;
  return JSON.stringify(r);
}

/** Jurisdiction strings that would satisfy the intake, or null when the fixture has no intake. */
function expectedJurisdictionAlternates(f: Fixture): string[] | null {
  const code = f.raw?.intake?.jurisdiction;
  if (typeof code !== "string" || !code) return null;
  // Full name first: "Delaware" in the governing-law clause is stronger evidence than a bare code.
  return [JURISDICTION_NAMES[code] ?? code, code];
}

/**
 * Whole-token presence test.
 *
 * A plain lowercase substring search is wrong here and quietly inflates the finding: the state code
 * "DE" occurs inside "under", "defer" and "provided", so every document would look like it names
 * Delaware. Two-letter codes are therefore matched case-sensitively with word boundaries (a legal
 * document writes the bare code only as a code), and multi-character names case-insensitively with
 * word boundaries.
 */
export function jurisdictionPresent(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const short = token.length <= 3;
  return new RegExp(`(^|[^A-Za-z])${esc}([^A-Za-z]|$)`, short ? "" : "i").test(text);
}

export type VerdictClass = "true_positive" | "false_positive" | "false_negative" | "true_negative";

export interface ReasonAuditItem {
  id: string;
  label: string;
  judge: string;
  reason: string;
  model: string;
  jurisdiction_expected: string;
  matched_alternate: string;
  counted_as: VerdictClass;
}

export interface ReasonAudit {
  n_items_with_checkable_reason: number;
  n_reasons_citing_jurisdiction: number;
  n_jurisdiction_reasons_contradicted_by_artifact: number;
  n_true_positives: number;
  n_true_positives_on_contradicted_reason: number;
  share_of_true_positives_on_contradicted_reason: number;
  n_false_positives_on_contradicted_reason: number;
  contradicted: ReasonAuditItem[];
  note: string;
}

function classify(label: string, judge: string): VerdictClass {
  if (label === "slop") return judge === "FAIL" ? "true_positive" : "false_negative";
  return judge === "FAIL" ? "false_positive" : "true_negative";
}

export function auditReasons(
  items: Array<{ id: string; label: string; judge: string; reason: string; model: string }>,
  fixtures: Fixture[],
): ReasonAudit {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const contradicted: ReasonAuditItem[] = [];
  let checkable = 0;
  let citing = 0;
  let tp = 0;

  for (const i of items) {
    const f = byId.get(i.id);
    if (!f) continue;
    const alts = expectedJurisdictionAlternates(f);
    const cls = classify(i.label, i.judge);
    if (cls === "true_positive") tp++;
    if (!alts) continue;
    checkable++;
    if (!JURISDICTION_CLAIM.test(i.reason)) continue;
    citing++;
    const text = artifactText(f);
    const hit = alts.find((a) => jurisdictionPresent(text, a));
    if (!hit) continue; // the reason may well be right: the artifact really does omit it
    contradicted.push({
      id: i.id, label: i.label, judge: i.judge, reason: i.reason, model: i.model,
      jurisdiction_expected: alts[0] ?? "", matched_alternate: hit, counted_as: cls,
    });
  }

  const tpOnBadReason = contradicted.filter((c) => c.counted_as === "true_positive").length;
  return {
    n_items_with_checkable_reason: checkable,
    n_reasons_citing_jurisdiction: citing,
    n_jurisdiction_reasons_contradicted_by_artifact: contradicted.length,
    n_true_positives: tp,
    n_true_positives_on_contradicted_reason: tpOnBadReason,
    share_of_true_positives_on_contradicted_reason: tp === 0 ? 0 : tpOnBadReason / tp,
    n_false_positives_on_contradicted_reason: contradicted.filter((c) => c.counted_as === "false_positive").length,
    contradicted,
    note:
      "Counts verdicts whose stated reason claims a jurisdiction or governing-law problem while the " +
      "artifact the judge was shown contains the jurisdiction the intake specified (either the code " +
      "or the full state name). Such a reason is contradicted by the artifact. Entries counted as " +
      "true_positive are verdicts the confusion matrix credits even though the stated ground for " +
      "rejection is false, so verdict-level recall overstates the judge's diagnostic value by that " +
      "amount. Entries counted as false_positive are the same error surfacing as a measurable " +
      "false reject. A count of 0 means this specific check found nothing, not that the reasons " +
      "are sound.",
  };
}

export async function runJudgeBaseline(mode: JudgeMode) {
  const fixtures = allFixtures();
  const hits0 = cacheHits;
  const fresh0 = freshCalls;
  const conf: Conf = { tp: 0, fn: 0, tn: 0, fp: 0 };
  const items: Array<{ id: string; domain: string; label: string; defect?: string; judge: string; reason: string; model: string; correct: boolean }> = [];
  const errors: string[] = [];

  for (const f of fixtures) {
    let call: JudgeCall | null = null;
    const freshBefore = freshCalls;
    for (let attempt = 0; attempt < ATTEMPTS && !call; attempt++) {
      try {
        call = await askJudge(f, mode);
      } catch (e) {
        const msg = e instanceof RouterExhaustedError
          ? e.attempt_log.map((a) => `${a.provider}/${a.model_id}:${a.status}${a.error ? ` (${scrub(a.error).slice(0, 120)})` : ""}`).join(" | ")
          : scrub(e instanceof Error ? e.message : String(e));
        if (attempt === ATTEMPTS - 1) { errors.push(`${f.id}: ${msg}`); }
        else { await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt] ?? 12000)); }
      }
    }
    if (!call) continue; // a fixture the judge could not be scored on is excluded, and reported

    const rejected = call.verdict === "FAIL";
    const correct = f.label === "slop" ? rejected : !rejected;
    if (f.label === "slop") { if (rejected) conf.tp++; else conf.fn++; }
    else { if (rejected) conf.fp++; else conf.tn++; }

    items.push({ id: f.id, domain: f.domain, label: f.label, defect: f.defect, judge: call.verdict, reason: call.reason, model: call.model, correct });
    // Pace only after a call that actually hit the network; cache hits cost no quota.
    if (freshCalls > freshBefore) await new Promise((r) => setTimeout(r, PACE_MS));
  }

  // Which model actually answered. The chain is a fallback chain, so a run that outlives one
  // provider's daily budget is answered by a mix of models. Reporting the mix keeps the baseline
  // honest: it is "a single judge behind a production fallback chain", not "one fixed model".
  const modelMix: Record<string, number> = {};
  for (const i of items) modelMix[i.model] = (modelMix[i.model] ?? 0) + 1;

  const missed = items.filter((i) => i.label === "slop" && i.judge === "PASS").map((i) => i.id);
  const falseRejected = items.filter((i) => i.label === "clean" && i.judge === "FAIL").map((i) => i.id);

  return {
    mode,
    n_fixtures: fixtures.length,
    n_scored: items.length,
    n_unscored: fixtures.length - items.length,
    n_calls_fresh: freshCalls - fresh0,
    n_calls_from_cache: cacheHits - hits0,
    confusion: conf,
    recall: recall(conf),
    false_reject_rate: frr(conf),
    model_mix: modelMix,
    slop_missed: missed,
    clean_false_rejected: falseRejected,
    reason_audit: auditReasons(items, fixtures),
    errors,
    items,
  };
}

async function main() {
  loadCache();
  const naive = await runJudgeBaseline("naive");
  const grounded = await runJudgeBaseline("grounded");

  const report = {
    generated_at: new Date().toISOString(),
    note:
      `Measured single-LLM-judge baselines on the same ${naive.n_fixtures} labeled fixtures as the guardian ` +
      "panel. 'naive' sees only the artifact; 'grounded' also receives the ground-truth facts the deterministic " +
      "guardians use, and is therefore the strongest single-judge configuration. Temperature 0. Calls are " +
      "cached by prompt hash so a run interrupted by a per-day rate limit can resume without re-spending " +
      "tokens; n_calls_fresh and n_calls_from_cache report the split. Each baseline also carries a " +
      "reason_audit: the confusion matrix scores only whether the judge rejected, so the audit " +
      "separately counts verdicts whose stated reason is contradicted by the artifact the judge was " +
      "shown. Read recall together with that count.",
    judge_chain: JUDGE_CHAIN.map((c) => `${c.provider}/${c.id}`),
    baselines: { naive, grounded },
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/judge_baseline.json`, JSON.stringify(report, null, 2));

  for (const b of [naive, grounded]) {
    console.log(`\n=========== ${b.mode.toUpperCase()} SINGLE-LLM JUDGE ===========`);
    console.log(`  scored ${b.n_scored}/${b.n_fixtures} (unscored ${b.n_unscored})`);
    console.log(`  calls: ${b.n_calls_fresh} live, ${b.n_calls_from_cache} from cache`);
    console.log(`  TP=${b.confusion.tp} FN=${b.confusion.fn} TN=${b.confusion.tn} FP=${b.confusion.fp}`);
    console.log(`  recall       = ${(b.recall * 100).toFixed(1)}%`);
    console.log(`  false-reject = ${(b.false_reject_rate * 100).toFixed(1)}%`);
    if (b.slop_missed.length) console.log(`  slop MISSED (${b.slop_missed.length}): ${b.slop_missed.join(", ")}`);
    if (b.clean_false_rejected.length) console.log(`  clean WRONGLY REJECTED (${b.clean_false_rejected.length}): ${b.clean_false_rejected.join(", ")}`);
    const ra = b.reason_audit;
    console.log(
      `  reason audit: ${ra.n_reasons_citing_jurisdiction} verdict(s) cite jurisdiction, ` +
      `${ra.n_jurisdiction_reasons_contradicted_by_artifact} contradicted by the artifact`,
    );
    if (ra.n_true_positives_on_contradicted_reason > 0) {
      console.log(
        `    ${ra.n_true_positives_on_contradicted_reason}/${ra.n_true_positives} true positives ` +
        `(${(ra.share_of_true_positives_on_contradicted_reason * 100).toFixed(1)}%) are credited on a reason the artifact contradicts`,
      );
      for (const c of ra.contradicted) {
        console.log(`      ${c.counted_as.padEnd(15)} ${c.id}: "${c.reason}" but the text contains "${c.matched_alternate}"`);
      }
    }
    if (b.errors.length) console.log(`  errors: ${b.errors.join(" ;; ")}`);
  }
  console.log(`\nwrote ${OUT}/judge_baseline.json`);
}

if ((process.argv[1] ?? "").includes("judgeBaseline")) {
  main().catch((e) => { console.error("BASELINE ERROR:", scrub(e instanceof Error ? e.message : String(e))); process.exit(1); });
}
