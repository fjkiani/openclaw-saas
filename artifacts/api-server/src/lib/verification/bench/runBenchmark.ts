/**
 * bench/runBenchmark.ts — multi-domain anti-slop benchmark.
 *
 * Runs the fixture corpus through the verification gate and reports, per domain and overall:
 *   - confusion matrix TP/FN/TN/FP   (positive = "slop", i.e. the gate SHOULD reject)
 *   - panel recall (caught slop), false-reject rate (wrongly blocked clean)
 *   - per-guardian recall (defense-in-depth: show no single guardian catches everything)
 *   - self-grade baseline: a single non-independent rubric-style judge, no deterministic checks →
 *     reproduces the "model grading its own work catches ~nothing" contrast.
 *
 * Offline mode scores the DETERMINISTIC panel (materiality/numerical/hedge + domain-specific).
 * The rubric guardian is live-only; when no key is present it is excluded here and that is stated
 * plainly in the output (rubric_mode: "excluded_offline").
 */

import { verify, getDomain } from "../verificationCore.js";
import { registerAllDomains } from "../registerAll.js";
import { allFixtures, type Fixture } from "./fixtures.js";

export interface Confusion { tp: number; fn: number; tn: number; fp: number; }
export interface DomainReport {
  domain: string;
  n: number; n_clean: number; n_slop: number;
  confusion: Confusion;
  recall: number; // TP / (TP+FN)
  false_reject_rate: number; // FP / (FP+TN)
  per_guardian_recall: Record<string, { caught: number; of: number; recall: number }>;
}
export interface BenchReport {
  generated_at: string;
  rubric_mode: string;
  live: boolean;
  overall: DomainReport;
  by_domain: DomainReport[];
  self_grade_baseline: { recall: number; tp: number; fn: number; note: string };
  /** Live only: how many fixtures got a non-degraded rubric answer, and how many did not. */
  live_rubric?: { n_scored: number; n_degraded: number; attempts_used: number };
  fixtures: Array<{
    id: string; domain: string; label: string; defect?: string; verdict: string; verified: boolean; caught_by: string[];
    /** Live only. Present when the domain has a rubric guardian, so a FAIL can be attributed to a
     *  real low score versus an unavailable judge. Without this a rate-limited run and a
     *  mis-calibrated threshold produce the same headline number. */
    rubric?: { status: string; score: number | null; model: string; reason: string };
  }>;
}

const EXCLUDE_OFFLINE = ["rubric"];
/** Live retry/pacing. Free model tiers rate-limit by tokens per minute and per day, and a single
 *  degraded call becomes a FAIL under the fail-closed law, so an unpaced run measures the quota
 *  rather than the guardian. Deterministic (offline) runs need neither. */
const LIVE_ATTEMPTS = Number(process.env.RIGOR_ATTEMPTS ?? 3);
const LIVE_PACE_MS = Number(process.env.RIGOR_PACE_MS ?? 0);
const LIVE_BACKOFF_MS = [3000, 9000, 20000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emptyConfusion(): Confusion { return { tp: 0, fn: 0, tn: 0, fp: 0 }; }

function recall(c: Confusion): number { return c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn); }
function frr(c: Confusion): number { return c.fp + c.tn === 0 ? 0 : c.fp / (c.fp + c.tn); }

export async function runBenchmark(opts: { live?: boolean } = {}): Promise<BenchReport> {
  registerAllDomains();
  const live = opts.live ?? false;
  const fixtures = allFixtures();

  const domains = [...new Set(fixtures.map((f) => f.domain))].sort();
  const byDomainConf: Record<string, Confusion> = {};
  const perGuardian: Record<string, Record<string, { caught: number; of: number }>> = {};
  const counts: Record<string, { n: number; clean: number; slop: number }> = {};
  for (const d of domains) { byDomainConf[d] = emptyConfusion(); perGuardian[d] = {}; counts[d] = { n: 0, clean: 0, slop: 0 }; }

  const fixtureRows: BenchReport["fixtures"] = [];
  let sgTp = 0, sgFn = 0; // self-grade baseline

  let liveScored = 0, liveDegraded = 0, attemptsUsed = 0;

  for (const f of fixtures) {
    const exclude = live ? [] : EXCLUDE_OFFLINE;
    let v = await verify(f.domain, f.raw, { live, exclude });
    let rub = v.per_guardian.find((g) => g.guardian === "rubric");
    if (live) {
      attemptsUsed++;
      for (let a = 0; a < LIVE_ATTEMPTS - 1 && rub?.status === "degraded"; a++) {
        await sleep(LIVE_BACKOFF_MS[a] ?? 20000);
        v = await verify(f.domain, f.raw, { live, exclude });
        rub = v.per_guardian.find((g) => g.guardian === "rubric");
        attemptsUsed++;
      }
      if (rub) { if (rub.status === "degraded") liveDegraded++; else liveScored++; }
      if (LIVE_PACE_MS > 0) await sleep(LIVE_PACE_MS);
    }
    const rejected = v.verdict === "FAIL";
    const caughtBy = v.per_guardian.filter((g) => g.status === "fail").map((g) => g.guardian);

    counts[f.domain].n++;
    counts[f.domain][f.label]++;

    const c = byDomainConf[f.domain];
    if (f.label === "slop") {
      if (rejected) c.tp++; else c.fn++;
      // per-guardian recall: did the EXPECTED guardian catch it?
      if (f.expectGuardian) {
        perGuardian[f.domain][f.expectGuardian] = perGuardian[f.domain][f.expectGuardian] || { caught: 0, of: 0 };
        perGuardian[f.domain][f.expectGuardian].of++;
        if (caughtBy.includes(f.expectGuardian)) perGuardian[f.domain][f.expectGuardian].caught++;
      }
    } else {
      if (rejected) c.fp++; else c.tn++;
    }

    // ── self-grade baseline ──
    // Simulates asking the model to grade its own output with a single holistic judgment and NO
    // independent deterministic checks. A same-source judge is optimistic and, crucially, has no
    // ground-truth to compare numbers against, so it passes deterministically-detectable slop.
    // We model it as: it only "catches" a defect a naive self-review would obviously notice —
    // here, an essentially empty/truncated body. Everything else it waves through.
    if (f.label === "slop") {
      const text = extractText(f);
      const obviouslyEmpty = text.trim().length < 30;
      if (obviouslyEmpty) sgTp++; else sgFn++;
    }

    fixtureRows.push({
      id: f.id, domain: f.domain, label: f.label, defect: f.defect, verdict: v.verdict, verified: v.verified, caught_by: caughtBy,
      ...(rub
        ? { rubric: {
              status: rub.status,
              score: typeof rub.score === "number" ? rub.score : null,
              model: String((rub.evidence as Record<string, unknown> | undefined)?.model_used ?? "none"),
              reason: String(rub.reasons?.[0] ?? "").slice(0, 200),
            } }
        : {}),
    });
  }

  const by_domain: DomainReport[] = domains.map((d) => {
    const c = byDomainConf[d];
    const pgr: DomainReport["per_guardian_recall"] = {};
    for (const [g, s] of Object.entries(perGuardian[d])) pgr[g] = { caught: s.caught, of: s.of, recall: s.of ? s.caught / s.of : 1 };
    return { domain: d, n: counts[d].n, n_clean: counts[d].clean, n_slop: counts[d].slop, confusion: c, recall: recall(c), false_reject_rate: frr(c), per_guardian_recall: pgr };
  });

  const overallConf = by_domain.reduce((acc, d) => ({ tp: acc.tp + d.confusion.tp, fn: acc.fn + d.confusion.fn, tn: acc.tn + d.confusion.tn, fp: acc.fp + d.confusion.fp }), emptyConfusion());
  const overall: DomainReport = {
    domain: "ALL", n: fixtures.length, n_clean: overallConf.tn + overallConf.fp, n_slop: overallConf.tp + overallConf.fn,
    confusion: overallConf, recall: recall(overallConf), false_reject_rate: frr(overallConf),
    per_guardian_recall: {},
  };

  return {
    generated_at: new Date().toISOString(),
    rubric_mode: live ? "live" : "excluded_offline",
    live,
    overall,
    by_domain,
    ...(live ? { live_rubric: { n_scored: liveScored, n_degraded: liveDegraded, attempts_used: attemptsUsed } } : {}),
    self_grade_baseline: { recall: sgTp + sgFn ? sgTp / (sgTp + sgFn) : 0, tp: sgTp, fn: sgFn, note: "NOT a measured LLM judge. This is a hand-written stub that flags output only when it is obviously empty (<30 chars), i.e. a lower bound on the weakest possible self-check with no independent ground truth. It misses every numeric, hedge, placeholder and safety defect. Use bench/rigorAudit.ts ablation for the measured per-guardian value. A REAL model-as-judge baseline is measured separately in bench/judgeBaseline.ts (judge_baseline.json): a naive single judge reaches far higher recall than this stub, and a ground-truth-grounded single judge matches the panel on recall while false-rejecting clean output. Do not cite this stub as the LLM-judge comparison." },
    fixtures: fixtureRows,
  };
}

function extractText(f: Fixture): string {
  const r = f.raw;
  if (f.domain === "legal_draft") return r.result?.full_text ?? "";
  if (f.domain === "generic_llm") return r.text ?? "";
  if (f.domain === "sql_gen") return r.sql ?? "";
  if (f.domain === "mcp_server") return JSON.stringify(r.benchmark ?? {});
  return "";
}
