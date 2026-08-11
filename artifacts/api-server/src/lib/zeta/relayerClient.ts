/**
 * Zeta L4 relayer client — Canton -> EVM oracle.
 *
 * Reads a Canton attestation and mirrors the minimal claim to the EVM
 * AttestationOracle. The in-process oracle reproduces AttestationOracle.sol
 * isCleared() semantics exactly; relayToEvm is the single swap point for a
 * web3.js signer when a live EVM RPC is provided.
 */
import { createHash } from "node:crypto";
import { getLedger } from "./ledgerClient.js";

const DECISION_MAP: Record<string, number> = { rejected: 0, review_required: 1, approved: 2 };

interface EvmAttestation {
  decision: number; riskTier: number; uboVerified: boolean;
  expiresAt: number; evidenceHash: string; revoked: boolean;
}

function toBytes32(s: string): string {
  const clean = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return "0x" + clean.toLowerCase();
  return "0x" + createHash("sha256").update(s).digest("hex");
}

class EvmOracle {
  relayer = "zeta_relayer";
  private attestations = new Map<string, EvmAttestation>();

  post(entityHash: string, a: EvmAttestation, by: string): void {
    if (by !== this.relayer) throw new Error("not relayer");
    this.attestations.set(entityHash, a);
  }
  revoke(entityHash: string, by: string): void {
    if (by !== this.relayer) throw new Error("not relayer");
    const a = this.attestations.get(entityHash);
    if (a) a.revoked = true;
  }
  isCleared(entityHash: string): boolean {
    const a = this.attestations.get(entityHash);
    if (!a) return false;
    return !a.revoked && a.decision === 2 && a.uboVerified && a.expiresAt > Math.floor(Date.now() / 1000);
  }
}

let _oracle: EvmOracle | null = null;
function getOracle(): EvmOracle {
  if (!_oracle) _oracle = new EvmOracle();
  return _oracle;
}

/** Read Canton attestation -> post to EVM oracle. Returns the on-chain entity key. */
export async function relayToEvm(cantonContractId: string, relyingParty: string): Promise<{ entityHash: string }> {
  const ledger = getLedger();
  const claim = await ledger.verify(cantonContractId, relyingParty);
  const entityHash = toBytes32(claim.legalEntityHash);
  getOracle().post(entityHash, {
    decision: DECISION_MAP[claim.decision],
    riskTier: { low: 0, medium: 1, high: 2 }[claim.riskTier] ?? 2,
    uboVerified: claim.uboVerified,
    expiresAt: Math.floor(new Date(claim.expiresAt).getTime() / 1000),
    evidenceHash: toBytes32(claim.evidenceHash),
    revoked: false,
  }, getOracle().relayer);
  return { entityHash };
}

/** The permissioned-pool gate: is this entity cleared to trade right now? */
export async function evmIsCleared(legalEntityHash: string): Promise<boolean> {
  return getOracle().isCleared(toBytes32(legalEntityHash));
}
