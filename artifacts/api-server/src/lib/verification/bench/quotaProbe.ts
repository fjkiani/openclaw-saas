/**
 * bench/quotaProbe.ts — asks every entry in JUDGE_CHAIN one minimal question and records what the
 * upstream said.
 *
 * Why this exists. The live rubric guardian degraded on 33 of 39 calls in one benchmark run, and
 * "the judge was unavailable" has at least four very different causes: a missing key, a per-minute
 * rate limit, a per-day budget, and a decommissioned model id. They demand opposite responses —
 * pace slower, wait for tomorrow, buy credits, or change the slug — so collapsing them into one
 * "degraded" count is not good enough to act on. Each probe sends about ten tokens, so the probe
 * itself does not meaningfully consume the budget it is measuring.
 *
 * The probe deliberately drives the SAME router the guardian uses, one chain entry at a time, so a
 * result here is evidence about the production path and not about a hand-rolled fetch.
 *
 * Run:  RIGOR_OUT=/path tsx bench/quotaProbe.ts
 */

import { JUDGE_CHAIN } from "../guardians.js";
import { invokeWithFallback, RouterExhaustedError } from "../../modelRouter.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.RIGOR_OUT || "/workspace/rigor_out";

/** Statuses that prove the credential and model id are live, whatever the reply looked like. */
const REACHABLE = new Set(["success", "parse_error", "schema_error", "unusable", "refusal"]);

export interface ProbeResult {
  model: string;
  provider: string;
  api_key_env: string;
  /** "ping" is ~10 tokens; "judge_sized" is the size a real rubric call sends. */
  payload: "ping" | "judge_sized";
  status: string;
  reachable: boolean;
  /** Verbatim upstream text, scrubbed of anything key-shaped. Says which limit was hit. */
  detail: string;
  latency_ms: number;
}

const scrub = (s: string) =>
  s.replace(/(gsk_|sk-or-v1-|ghp_)[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/AQ\.[A-Za-z0-9_-]+/g, "[REDACTED]");

/**
 * A ~10-token ping and a judge-sized request are different questions. A live credential with an
 * almost-spent daily token budget answers the ping and refuses the real request, and only the
 * second answer predicts whether the guardian can run. Both are recorded.
 */
const JUDGE_SIZED_FILLER = "The quick brown fox jumped over the lazy dog. ".repeat(140);

export async function probeChain(): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const payloads: Array<{ kind: "ping" | "judge_sized"; content: string }> = [
    { kind: "ping", content: "ping" },
    { kind: "judge_sized", content: `Ignore this text, it only sets the request size.\n${JUDGE_SIZED_FILLER}` },
  ];

  for (const entry of JUDGE_CHAIN) {
    for (const p of payloads) {
      const t0 = Date.now();
      let status = "success";
      let detail = "";
      try {
        const res = await invokeWithFallback(
          {
            systemPrompt: 'Reply only with the JSON {"ok":true}.',
            userContent: p.content,
            title: "rigor-quota-probe",
            maxTokens: 8,
            temperature: 0,
          },
          [entry],
          { routeChainId: "rigor-quota-probe", schemaType: "generic", validator: (v: unknown) => v },
        );
        detail = scrub(String(res.raw ?? "")).slice(0, 120);
      } catch (e) {
        if (e instanceof RouterExhaustedError) {
          const a = e.attempt_log[0];
          status = a?.status ?? "unknown";
          detail = scrub(a?.error ?? "").slice(0, 300);
        } else {
          status = "probe_error";
          detail = scrub(e instanceof Error ? e.message : String(e)).slice(0, 300);
        }
      }
      out.push({
        model: entry.id,
        provider: entry.provider,
        api_key_env: entry.apiKeyEnv,
        payload: p.kind,
        status,
        reachable: REACHABLE.has(status),
        detail,
        latency_ms: Date.now() - t0,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const results = await probeChain();

  // Distinct upstream accounts matter more than distinct keys: three keys on one account share one
  // budget, so key rotation buys nothing once that account's daily cap is reached.
  const accountOf = (r: ProbeResult) => (r.provider === "openrouter" ? "openrouter" : r.provider === "groq" ? "groq" : "google");
  const byAccount: Record<string, { n_entries: number; ping_reachable: number; judge_sized_reachable: number }> = {};
  for (const r of results) {
    const k = accountOf(r);
    byAccount[k] = byAccount[k] ?? { n_entries: 0, ping_reachable: 0, judge_sized_reachable: 0 };
    if (r.payload === "ping") { byAccount[k].n_entries++; if (r.reachable) byAccount[k].ping_reachable++; }
    else if (r.reachable) byAccount[k].judge_sized_reachable++;
  }

  const report = {
    generated_at: new Date().toISOString(),
    note:
      "One ~10-token request per JUDGE_CHAIN entry, through the same router the rubric guardian " +
      "uses. 'reachable' means the credential and model id are live, regardless of reply quality. " +
      "A rate_limited status here with the upstream text quoted in 'detail' is the evidence for " +
      "why the live rubric degraded, and distinguishes a per-day budget from a per-minute rate.",
    n_entries: JUDGE_CHAIN.length,
    n_reachable_ping: results.filter((r) => r.payload === "ping" && r.reachable).length,
    /** The number that predicts whether the live rubric can actually run right now. */
    n_reachable_judge_sized: results.filter((r) => r.payload === "judge_sized" && r.reachable).length,
    by_account: byAccount,
    results,
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/quota_probe.json`, JSON.stringify(report, null, 2));

  console.log(
    `judge chain: ${JUDGE_CHAIN.length} entries | reachable with a 10-token ping: ${report.n_reachable_ping} | ` +
    `reachable with a judge-sized request: ${report.n_reachable_judge_sized}`,
  );
  for (const r of results) {
    console.log(`  ${r.provider}/${r.model} [${r.payload}]`.padEnd(62) + `${r.reachable ? "OK  " : "DOWN"} ${r.status} (${r.latency_ms}ms)`);
    if (r.detail) console.log(`      ${r.detail.replace(/\s+/g, " ").slice(0, 220)}`);
  }
  for (const [acct, s] of Object.entries(byAccount)) {
    console.log(`  account ${acct}: ping ${s.ping_reachable}/${s.n_entries}, judge-sized ${s.judge_sized_reachable}/${s.n_entries}`);
  }
  console.log(`\nwrote ${OUT}/quota_probe.json`);
}

if ((process.argv[1] ?? "").includes("quotaProbe")) {
  main().catch((e) => { console.error("PROBE ERROR:", scrub(e instanceof Error ? e.message : String(e))); process.exit(1); });
}
