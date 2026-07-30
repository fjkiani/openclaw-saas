/**
 * verificationCore.ts — domain-agnostic anti-slop verification core.
 *
 * One idea: an AI/pipeline output is not "done" when it is produced; it is done when it is
 * VERIFIED. This module runs any output through a panel of independent guardians and returns a
 * single FAIL-CLOSED verdict. It is domain-agnostic: legal drafts, MCP servers, and generic LLM
 * output all plug in through the same DomainAdapter contract, and new domains onboard the same way.
 *
 * No DB dependency, no external runtime deps — pure TypeScript. (The repo's judgePair.ts is
 * Postgres-coupled; the rubric guardian reuses modelRouter directly instead.)
 */

// ── Guardian primitives ─────────────────────────────────────────────────────
export type GuardianStatus = "pass" | "fail" | "degraded";
// "degraded" = the guardian could NOT actually perform its check (e.g. no model key and no
// deterministic fallback strong enough to trust). It is not the same as "fail".

export interface GuardianResult {
  guardian: string;
  status: GuardianStatus;
  score?: number; // 0..1 where meaningful
  live: boolean; // true = a real check ran (live model / real probe); false = dry/deterministic fallback
  reasons: string[];
  evidence?: Record<string, unknown>; // machine-checkable detail (claimed vs found, etc.)
}

export interface GateContext {
  domain: string;
  live: boolean; // caller intent: attempt live checks (model calls / network probes) when true
  meta?: Record<string, unknown>;
}

export interface Guardian<TInput> {
  name: string;
  /**
   * Independent check. Contract:
   *  - MUST NOT throw for domain-expected failures — return status:"fail" with reasons.
   *  - MUST return status:"degraded" + live:false when it could not truly perform its check.
   *  - If it throws unexpectedly, runGate() converts the throw into a degraded result (fail-closed).
   */
  run(input: TInput, ctx: GateContext): Promise<GuardianResult> | GuardianResult;
}

// ── Verdict ──────────────────────────────────────────────────────────────────
export interface GateVerdict {
  verdict: "PASS" | "FAIL";
  verified: boolean; // true only if NO guardian is degraded (fail-closed)
  n_verified: number; // count of guardians that ran live (live === true)
  n_total: number;
  per_guardian: GuardianResult[];
  reasons: string[];
  domain: string;
}

/**
 * FAIL-CLOSED law (the whole point of the system):
 *   verdict = PASS  iff  every guardian.status === "pass"
 *                        (ANY "fail" OR ANY "degraded" ⇒ verdict = FAIL)
 *   verified = true iff  NO guardian.status === "degraded"
 *                        (a run that could not be truly checked can NEVER be a trustworthy PASS)
 * Consequence: a single degraded guardian forces verdict=FAIL AND verified=false. You cannot get
 * a green light from a gate that could not actually look.
 */
export async function runGate<T>(
  input: T,
  guardians: Guardian<T>[],
  ctx: GateContext,
): Promise<GateVerdict> {
  const per_guardian: GuardianResult[] = [];

  for (const g of guardians) {
    try {
      const r = await g.run(input, ctx);
      // Defensive normalization: a guardian that returns a malformed result is treated as degraded.
      if (!r || (r.status !== "pass" && r.status !== "fail" && r.status !== "degraded")) {
        per_guardian.push({
          guardian: g.name,
          status: "degraded",
          live: false,
          reasons: [`guardian '${g.name}' returned a malformed result`],
        });
      } else {
        per_guardian.push({ ...r, guardian: r.guardian || g.name });
      }
    } catch (err) {
      // An uncaught throw means we could not complete the check → degraded, never a silent pass.
      per_guardian.push({
        guardian: g.name,
        status: "degraded",
        live: false,
        reasons: [`guardian '${g.name}' threw: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }

  const anyFail = per_guardian.some((r) => r.status === "fail");
  const anyDegraded = per_guardian.some((r) => r.status === "degraded");
  const n_verified = per_guardian.filter((r) => r.live).length;

  const verdict: "PASS" | "FAIL" = anyFail || anyDegraded ? "FAIL" : "PASS";
  const verified = !anyDegraded;

  const reasons: string[] = [];
  if (anyDegraded) {
    reasons.push(
      "FAIL (fail-closed): one or more guardians could not truly verify the output; a run that " +
        "could not be checked cannot PASS.",
    );
  }
  if (anyFail) {
    for (const r of per_guardian.filter((x) => x.status === "fail")) {
      reasons.push(`FAIL [${r.guardian}]: ${r.reasons.join("; ")}`);
    }
  }
  if (verdict === "PASS") {
    reasons.push(`PASS: all ${per_guardian.length} guardians passed (${n_verified} ran live).`);
  }

  return {
    verdict,
    verified,
    n_verified,
    n_total: guardians.length,
    per_guardian,
    reasons,
    domain: ctx.domain,
  };
}

// ── Domain adapter + registry ─────────────────────────────────────────────────
export interface DomainAdapter<TRaw, TInput> {
  domain: string;
  /** Normalize a raw domain object into the guardians' input shape. */
  prepare(raw: TRaw): TInput;
  /** The panel for this domain (defense-in-depth: several independent guardians). */
  guardians: Guardian<TInput>[];
}

const REGISTRY = new Map<string, DomainAdapter<any, any>>();

export function registerDomain(a: DomainAdapter<any, any>): void {
  if (!a.domain) throw new Error("DomainAdapter.domain is required");
  if (!Array.isArray(a.guardians) || a.guardians.length === 0) {
    throw new Error(`domain '${a.domain}' must register at least one guardian`);
  }
  REGISTRY.set(a.domain, a);
}

export function getDomain(id: string): DomainAdapter<any, any> | undefined {
  return REGISTRY.get(id);
}

export function listDomains(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function clearDomains(): void {
  REGISTRY.clear(); // used by tests
}

/**
 * Verify any raw domain object by id. This is the single entry point an application calls:
 *   const verdict = await verify("legal_draft", { result, intake }, { live: false });
 */
export async function verify<TRaw>(
  domain: string,
  raw: TRaw,
  opts: {
    live?: boolean;
    meta?: Record<string, unknown>;
    /** Restrict the panel to these guardian names (e.g. deterministic-only offline scoring).
     *  Use with care: dropping a guardian narrows what "PASS" attests to. */
    only?: string[];
    /** Exclude these guardian names from the panel. */
    exclude?: string[];
  } = {},
): Promise<GateVerdict> {
  const adapter = REGISTRY.get(domain);
  if (!adapter) {
    // Unknown domain is itself a fail-closed condition: we cannot verify what we do not understand.
    return {
      verdict: "FAIL",
      verified: false,
      n_verified: 0,
      n_total: 0,
      per_guardian: [],
      reasons: [`FAIL: no adapter registered for domain '${domain}'. Registered: ${listDomains().join(", ") || "(none)"}`],
      domain,
    };
  }
  let guardians = adapter.guardians;
  if (opts.only?.length) guardians = guardians.filter((g) => opts.only!.includes(g.name));
  if (opts.exclude?.length) guardians = guardians.filter((g) => !opts.exclude!.includes(g.name));
  const input = adapter.prepare(raw);
  const ctx: GateContext = { domain, live: opts.live ?? false, meta: opts.meta };
  return runGate(input, guardians, ctx);
}
