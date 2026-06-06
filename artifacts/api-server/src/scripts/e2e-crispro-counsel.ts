#!/usr/bin/env tsx
/**
 * e2e-crispro-counsel.ts — CrisPRO counsel E2E gate assertions against k30t production.
 *
 * Gates tested:
 *   C1  meta.orchestrator_mode === true (no ?mode= param)
 *   C2  corpus chunks ≥ 200 (via /v1/legal/corpus/status)
 *   C3  recall@5 ≥ 0.80 on CrisPRO query (≥8/10 required slugs in rag_sources)
 *   C4  ≥6 grounded findings; includes irc-83b and dgcl-144
 *   C5  Mutual Dependency labeled counterparty-favorable; no without-Cause redline when perspective=company
 *   C6  deal_memo present; deal_memo.sign_blockers.length ≥ 1
 *   C7  governance.governance_action present (evaluateGovernance wired)
 *   C8  (static) ≥5 counsel scenarios in legalPlaybook.ts — verified by import count
 *   C9  Full CrisPRO fixture returns 200 within 120s (or async poll completes)
 *   C10 meta.grounded_ratio ≥ 0.5
 *   C11 cofounder + len>8000 routes through counsel (not matter fallback)
 *   C12 run_id present in response
 *
 * Usage:
 *   BASE_URL=https://openclaw-api-k30t.onrender.com npx tsx src/scripts/e2e-crispro-counsel.ts
 *   BASE_URL=http://localhost:3000 npx tsx src/scripts/e2e-crispro-counsel.ts
 */

import { COUNSEL_SCENARIOS } from "../lib/legalPlaybook.js";

const BASE_URL = process.env.BASE_URL ?? "https://openclaw-api-k30t.onrender.com";
const TIMEOUT_MS = 120_000;

// ── CrisPRO fixture ───────────────────────────────────────────────────────────

const CRISPRO_FIXTURE = `RESTRICTED STOCK PURCHASE AGREEMENT

This Restricted Stock Purchase Agreement ("Agreement") is entered into as of January 1, 2025, between CrisPRO Therapeutics, Inc., a Delaware corporation ("Company"), and Dr. Jane Smith ("Purchaser"), a co-founder and Chief Medical Officer.

1. PURCHASE AND SALE. Company hereby sells to Purchaser 2,000,000 shares of Common Stock at a purchase price of $0.001 per share (aggregate $2,000). Purchaser acknowledges that the shares are restricted securities under the Securities Act of 1933.

2. VESTING SCHEDULE. Shares vest over 4 years: 25% cliff at 12 months, then monthly thereafter (1/48 per month). Unvested shares are subject to Company's right of repurchase at the original purchase price upon termination of Purchaser's service for any reason.

3. ACCELERATION. Upon a Change of Control, 100% of unvested shares shall accelerate if Purchaser is terminated without Cause within 12 months following the Change of Control (double trigger). "Change of Control" means a merger, acquisition, or sale of substantially all assets in which existing shareholders receive less than 50% of the surviving entity.

4. MUTUAL DEPENDENCY. The parties acknowledge that the Company's success is mutually dependent on Purchaser's continued service as Chief Medical Officer. In the event of termination without Cause, Company shall pay Purchaser a lump sum equal to 12 months base salary as liquidated damages for the loss of Purchaser's unique contributions.

5. IP ASSIGNMENT. Purchaser hereby assigns to Company all right, title, and interest in all inventions, discoveries, improvements, and works of authorship made or conceived by Purchaser during the term of service that relate to the Company's business. Schedule C (attached hereto) lists pre-existing intellectual property excluded from this assignment. Schedule C is currently blank pending completion by Purchaser.

6. IRC §83(b) ELECTION. Purchaser acknowledges the availability of an election under Internal Revenue Code Section 83(b) with respect to the shares. Purchaser agrees to consult with a qualified tax advisor regarding the advisability of making such an election. No specific deadline for the election is set forth in this Agreement.

7. QSBS ELIGIBILITY. Company represents that it is a Qualified Small Business Corporation under IRC §1202. Company's aggregate gross assets have not exceeded $50,000,000 at any time since August 10, 1993, qualifying the shares for potential exclusion of up to 100% of capital gains under §1202 upon a qualifying disposition.

8. PROTECTIVE PROVISIONS. The holders of a majority of the outstanding shares of Series A Preferred Stock shall have the right to approve: (a) any amendment to the Certificate of Incorporation or Bylaws; (b) any merger, consolidation, or sale of substantially all assets; (c) any increase in the authorized shares of Common Stock; (d) any issuance of equity securities senior to or pari passu with the Series A Preferred Stock.

9. DGCL §144 COMPLIANCE. The parties acknowledge that this Agreement constitutes a transaction between the Company and a director/officer. The Board of Directors, excluding Purchaser, has reviewed and approved this Agreement as fair and reasonable to the Company.

10. GOVERNING LAW. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to conflicts of law principles.

11. ENTIRE AGREEMENT. This Agreement, together with the exhibits and schedules hereto, constitutes the entire agreement between the parties with respect to the subject matter hereof.

EXHIBIT A — VESTING SCHEDULE
[Standard 4-year monthly vesting table]

SCHEDULE C — PRE-EXISTING IP EXCLUSIONS
[To be completed by Purchaser prior to execution]`;

// ── Required slugs for C3 recall gate ────────────────────────────────────────

const REQUIRED_SLUGS_C3 = [
  "irc-83b",
  "cuad-coc-acceleration",
  "cuad-ip-assignment-scoped",
  "cuad-noncompete-12-month",
  "cuad-indemnification-do",
  "cuad-governing-law-delaware",
  "irc-1202",
  "irc-409a",
  "dgcl-144",
  "nvca-protective-provisions",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

type GateResult = { gate: string; passed: boolean; detail: string };

function pass(gate: string, detail: string): GateResult {
  return { gate, passed: true, detail };
}

function fail(gate: string, detail: string): GateResult {
  return { gate, passed: false, detail };
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pollRun(runId: string, maxWaitMs: number): Promise<unknown> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${BASE_URL}/v1/legal/counsel/runs/${runId}`);
    const body = (await res.json()) as { status: string; result?: unknown; error?: string };
    if (body.status === "done") return body.result;
    if (body.status === "failed") throw new Error(`Run failed: ${body.error}`);
  }
  throw new Error(`Poll timeout after ${maxWaitMs}ms`);
}

// ── Gate checks ───────────────────────────────────────────────────────────────

async function checkC2(): Promise<GateResult> {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/v1/legal/corpus/status`,
      { method: "GET" },
      10_000,
    );
    const body = (await res.json()) as { chunks?: number };
    const chunks = body.chunks ?? 0;
    if (chunks >= 200) return pass("C2", `corpus chunks = ${chunks} ≥ 200`);
    return fail("C2", `corpus chunks = ${chunks} < 200 (need ≥200)`);
  } catch (err) {
    return fail("C2", `corpus status fetch failed: ${err}`);
  }
}

async function checkC8(): Promise<GateResult> {
  const count = COUNSEL_SCENARIOS.length;
  if (count >= 5) return pass("C8", `${count} counsel scenarios in legalPlaybook.ts ≥ 5`);
  return fail("C8", `only ${count} counsel scenarios — need ≥5`);
}

async function runCrisPROAnalysis(): Promise<{
  body: Record<string, unknown>;
  statusCode: number;
  latencyMs: number;
}> {
  const t0 = Date.now();
  const res = await fetchWithTimeout(
    `${BASE_URL}/v1/legal/counsel/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: CRISPRO_FIXTURE,
        perspective: "company",
        // No mode param — C1 gate requires orchestrator_mode=true by default
      }),
    },
    TIMEOUT_MS,
  );

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = { _parse_error: true };
  }

  // If async (202), poll for result
  if (res.status === 202 && typeof body.run_id === "string") {
    const result = (await pollRun(body.run_id as string, TIMEOUT_MS)) as Record<string, unknown>;
    return { body: { ...result, run_id: body.run_id }, statusCode: 200, latencyMs: Date.now() - t0 };
  }

  return { body, statusCode: res.status, latencyMs: Date.now() - t0 };
}

function assertGates(
  body: Record<string, unknown>,
  statusCode: number,
  latencyMs: number,
): GateResult[] {
  const results: GateResult[] = [];
  const meta = (body.meta ?? {}) as Record<string, unknown>;
  const findingsGrounded = (body.findings_grounded as unknown[]) ?? [];
  const dealMemo = body.deal_memo as Record<string, unknown> | undefined;
  const ragSources = (body.rag_sources as string[]) ?? (meta.rag_sources as string[]) ?? [];
  const redlines = (body.redlines as Array<Record<string, unknown>>) ?? [];
  const governance = body.governance as Record<string, unknown> | undefined;

  // C1: meta.orchestrator_mode === true
  if (meta.orchestrator_mode === true) {
    results.push(pass("C1", "meta.orchestrator_mode = true"));
  } else {
    results.push(fail("C1", `meta.orchestrator_mode = ${meta.orchestrator_mode} (expected true)`));
  }

  // C3: recall@5 — ≥8/10 required slugs in rag_sources
  const foundSlugs = REQUIRED_SLUGS_C3.filter((s) => ragSources.includes(s));
  if (foundSlugs.length >= 8) {
    results.push(pass("C3", `recall@5: ${foundSlugs.length}/10 required slugs found`));
  } else {
    const missing = REQUIRED_SLUGS_C3.filter((s) => !ragSources.includes(s));
    results.push(
      fail("C3", `recall@5: only ${foundSlugs.length}/10 slugs found. Missing: ${missing.join(", ")}`),
    );
  }

  // C4: ≥6 grounded findings; includes irc-83b and dgcl-144
  const groundedSlugs = findingsGrounded.map((f) => (f as Record<string, unknown>).slug as string);
  const hasIrc83b = groundedSlugs.includes("irc-83b");
  const hasDgcl144 = groundedSlugs.includes("dgcl-144");
  if (findingsGrounded.length >= 6 && hasIrc83b && hasDgcl144) {
    results.push(
      pass("C4", `${findingsGrounded.length} grounded findings; irc-83b ✓; dgcl-144 ✓`),
    );
  } else {
    results.push(
      fail(
        "C4",
        `grounded=${findingsGrounded.length} (need ≥6); irc-83b=${hasIrc83b}; dgcl-144=${hasDgcl144}`,
      ),
    );
  }

  // C5: Mutual Dependency labeled counterparty-favorable; no without-Cause redline for company
  const mutualDepFinding = findingsGrounded.find(
    (f) =>
      typeof (f as Record<string, unknown>).issue === "string" &&
      ((f as Record<string, unknown>).issue as string).toLowerCase().includes("mutual dependency"),
  ) as Record<string, unknown> | undefined;

  const mutualDepOk =
    mutualDepFinding != null &&
    (mutualDepFinding.favors === "counterparty" ||
      (mutualDepFinding.issue as string).toLowerCase().includes("counterparty"));

  const badRedline = redlines.find(
    (r) =>
      r.favors === "company" &&
      typeof r.suggested_text === "string" &&
      /without.cause/i.test(r.suggested_text),
  );

  if (mutualDepOk && !badRedline) {
    results.push(pass("C5", "Mutual Dependency counterparty-favorable; no bad without-Cause redline"));
  } else {
    results.push(
      fail(
        "C5",
        `mutualDep=${mutualDepOk} (finding found=${mutualDepFinding != null}); badRedline=${badRedline != null}`,
      ),
    );
  }

  // C6: deal_memo present; sign_blockers.length ≥ 1
  const signBlockers = (dealMemo?.sign_blockers as unknown[]) ?? [];
  if (dealMemo != null && signBlockers.length >= 1) {
    results.push(pass("C6", `deal_memo present; sign_blockers.length = ${signBlockers.length}`));
  } else {
    results.push(
      fail("C6", `deal_memo=${dealMemo != null}; sign_blockers.length=${signBlockers.length}`),
    );
  }

  // C7: governance.governance_action present
  if (governance?.governance_action != null) {
    results.push(pass("C7", `governance.governance_action = "${governance.governance_action}"`));
  } else {
    results.push(fail("C7", "governance.governance_action missing — evaluateGovernance not wired"));
  }

  // C9: 200 within timeout
  if (statusCode === 200) {
    results.push(pass("C9", `HTTP 200 in ${latencyMs}ms`));
  } else {
    results.push(fail("C9", `HTTP ${statusCode} (expected 200)`));
  }

  // C10: meta.grounded_ratio ≥ 0.5
  const groundedRatio = typeof meta.grounded_ratio === "number" ? meta.grounded_ratio : -1;
  if (groundedRatio >= 0.5) {
    results.push(pass("C10", `meta.grounded_ratio = ${groundedRatio.toFixed(2)} ≥ 0.5`));
  } else {
    results.push(fail("C10", `meta.grounded_ratio = ${groundedRatio} < 0.5`));
  }

  // C11: cofounder + len>8000 routes through counsel (doc_class = cofounder_agreement)
  const docClass = body.doc_class as string | undefined;
  if (docClass === "cofounder_agreement") {
    results.push(pass("C11", `doc_class = "${docClass}" — cofounder routing confirmed`));
  } else {
    results.push(fail("C11", `doc_class = "${docClass}" (expected "cofounder_agreement")`));
  }

  // C12: run_id present
  if (typeof body.run_id === "string" && body.run_id.length > 10) {
    results.push(pass("C12", `run_id = "${body.run_id}"`));
  } else {
    results.push(fail("C12", `run_id missing or invalid: ${JSON.stringify(body.run_id)}`));
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`OpenClaw CrisPRO Counsel E2E — ${new Date().toISOString()}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`${"=".repeat(70)}\n`);

  const allResults: GateResult[] = [];

  // C2: corpus status (independent)
  process.stdout.write("Checking C2 (corpus chunks)... ");
  const c2 = await checkC2();
  allResults.push(c2);
  console.log(c2.passed ? `✅ ${c2.detail}` : `❌ ${c2.detail}`);

  // C8: static scenario count
  const c8 = await checkC8();
  allResults.push(c8);
  console.log(c8.passed ? `✅ C8: ${c8.detail}` : `❌ C8: ${c8.detail}`);

  // C1/C3/C4/C5/C6/C7/C9/C10/C11/C12: CrisPRO fixture analysis
  console.log(`\nRunning CrisPRO fixture analysis (timeout: ${TIMEOUT_MS / 1000}s)...`);
  let body: Record<string, unknown> = {};
  let statusCode = 0;
  let latencyMs = 0;

  try {
    const r = await runCrisPROAnalysis();
    body = r.body;
    statusCode = r.statusCode;
    latencyMs = r.latencyMs;
    console.log(`Response received in ${latencyMs}ms (HTTP ${statusCode})\n`);
  } catch (err) {
    console.error(`\n❌ CrisPRO analysis failed: ${err}\n`);
    // Mark all remaining gates as failed
    for (const gate of ["C1", "C3", "C4", "C5", "C6", "C7", "C9", "C10", "C11", "C12"]) {
      allResults.push(fail(gate, `Request failed: ${err}`));
    }
  }

  if (statusCode > 0) {
    const gateResults = assertGates(body, statusCode, latencyMs);
    allResults.push(...gateResults);
    for (const r of gateResults) {
      console.log(`${r.passed ? "✅" : "❌"} ${r.gate}: ${r.detail}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const passed = allResults.filter((r) => r.passed).length;
  const total = allResults.length;
  const failed = allResults.filter((r) => !r.passed);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULT: ${passed}/${total} gates passed`);
  if (failed.length > 0) {
    console.log(`\nFailed gates:`);
    for (const r of failed) {
      console.log(`  ❌ ${r.gate}: ${r.detail}`);
    }
  }
  console.log(`${"=".repeat(70)}\n`);

  // Print raw response excerpt for debugging
  if (Object.keys(body).length > 0) {
    console.log("── Raw response excerpt ──");
    const excerpt = {
      ok: body.ok,
      run_id: body.run_id,
      doc_class: body.doc_class,
      overall_risk: body.overall_risk,
      findings_grounded_count: ((body.findings_grounded as unknown[]) ?? []).length,
      findings_inferred_count: ((body.findings_inferred as unknown[]) ?? []).length,
      deal_memo_sign_blockers: ((body.deal_memo as Record<string, unknown>)?.sign_blockers as unknown[])?.length ?? 0,
      meta_orchestrator_mode: (body.meta as Record<string, unknown>)?.orchestrator_mode,
      meta_grounded_ratio: (body.meta as Record<string, unknown>)?.grounded_ratio,
      meta_lens_models: (body.meta as Record<string, unknown>)?.lens_models,
      rag_sources: body.rag_sources,
    };
    console.log(JSON.stringify(excerpt, null, 2));
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
