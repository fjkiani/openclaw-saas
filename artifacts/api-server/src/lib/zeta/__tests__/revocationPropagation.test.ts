/**
 * Zeta L3 -> L4 revocation propagation.
 *
 * The defect: revoking on the Canton ledger alone left the EVM oracle entry
 * posted at attest time with revoked=false, so isCleared stayed TRUE and
 * POST /api/zeta/verify kept telling a permissioned pool a revoked entity was
 * cleared to trade. The route's own docstring claimed "(propagates to EVM
 * oracle)" and did not.
 *
 * The identical bug shipped in the Python engine (POST /zeta/revoke) and was
 * found there first, live on build c6caf0a, against entity_key 0xdfb35610...
 * Finding the same fault twice in two hand-written implementations of the same
 * layer is the argument for collapsing these clients onto the engine.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { getLedger, __resetLedgerForTest } from "../ledgerClient.js";
import { relayToEvm, evmIsCleared, evmRevoke, __resetOracleForTest } from "../relayerClient.js";

const HASH = (s: string) => createHash("sha256").update(s).digest("hex");
const EVIDENCE = HASH("evidence-bundle");

function payload(entity: string, over: Record<string, unknown> = {}) {
  return {
    legalEntityHash: HASH(entity),
    decision: "approved",
    riskTier: "low",
    uboVerified: true,
    expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
    evidenceHash: EVIDENCE,
    ...over,
  };
}

async function attestAndRelay(entity: string, over: Record<string, unknown> = {}) {
  const p = payload(entity, over);
  const att = await getLedger().createAttestation("zeta_agent", `entity_${entity}`, ["aave_arc_pool"], p);
  const { entityHash } = await relayToEvm(att.contractId, "aave_arc_pool");
  return { contractId: att.contractId, entityHash, legalEntityHash: p.legalEntityHash as string };
}

describe("L4 revocation propagation", () => {
  beforeEach(() => {
    __resetLedgerForTest();
    __resetOracleForTest();
  });

  it("clears an entity on chain after attest + relay", async () => {
    const { legalEntityHash } = await attestAndRelay("acme");
    expect(await evmIsCleared(legalEntityHash)).toBe(true);
  });

  it("THE BUG: a ledger-only revoke leaves the clearance bit standing", async () => {
    const { contractId, legalEntityHash } = await attestAndRelay("acme");
    // Exactly what the route used to do, and nothing else.
    await getLedger().revoke(contractId, "zeta_agent");
    await expect(getLedger().verify(contractId, "aave_arc_pool")).rejects.toThrow(/revoked/);
    // Ledger says no. Oracle still says yes. A pool gating on this takes the money.
    expect(await evmIsCleared(legalEntityHash)).toBe(true);
  });

  it("evmRevoke tears the bit down and reports what it did", async () => {
    const { contractId, legalEntityHash, entityHash } = await attestAndRelay("acme");
    await getLedger().revoke(contractId, "zeta_agent");
    const r = await evmRevoke(legalEntityHash);
    expect(r).toEqual({ entityHash, revoked: true, isCleared: false });
    expect(await evmIsCleared(legalEntityHash)).toBe(false);
  });

  it("is idempotent — revoking twice does not throw and stays uncleared", async () => {
    const { contractId, legalEntityHash } = await attestAndRelay("acme");
    await getLedger().revoke(contractId, "zeta_agent");
    await evmRevoke(legalEntityHash);
    const second = await evmRevoke(legalEntityHash);
    expect(second.isCleared).toBe(false);
    expect(await evmIsCleared(legalEntityHash)).toBe(false);
  });

  it("revoking an entity that was never relayed reports revoked=false, not a crash", async () => {
    const r = await evmRevoke(HASH("never_relayed"));
    expect(r.revoked).toBe(false);
    expect(r.isCleared).toBe(false);
  });

  it("revocation is scoped to one entity", async () => {
    const a = await attestAndRelay("acme");
    const b = await attestAndRelay("beta");
    expect(a.entityHash).not.toBe(b.entityHash);
    await getLedger().revoke(a.contractId, "zeta_agent");
    await evmRevoke(a.legalEntityHash);
    expect(await evmIsCleared(a.legalEntityHash)).toBe(false);
    expect(await evmIsCleared(b.legalEntityHash)).toBe(true);
  });

  it("only the issuer may revoke on the ledger", async () => {
    const { contractId } = await attestAndRelay("acme");
    await expect(getLedger().revoke(contractId, "aave_arc_pool")).rejects.toThrow(/issuer/);
  });

  it("isCleared already refuses non-approved and unverified-UBO attestations", async () => {
    const rev = await attestAndRelay("gamma", { decision: "review_required" });
    expect(await evmIsCleared(rev.legalEntityHash)).toBe(false);
    const noUbo = await attestAndRelay("delta", { uboVerified: false });
    expect(await evmIsCleared(noUbo.legalEntityHash)).toBe(false);
  });

  it("an expired attestation never reaches the oracle at all", async () => {
    const p = payload("epsilon", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const att = await getLedger().createAttestation("zeta_agent", "entity_epsilon", ["aave_arc_pool"], p);
    // The ledger refuses to release the claim, so relayToEvm cannot post it.
    await expect(relayToEvm(att.contractId, "aave_arc_pool")).rejects.toThrow(/expired/);
    expect(await evmIsCleared(p.legalEntityHash as string)).toBe(false);
  });
});
