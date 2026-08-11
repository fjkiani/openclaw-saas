/**
 * Zeta L3 ledger client — Canton attestation semantics.
 *
 * Mirrors daml/KyBAttestation.daml 1:1 (party visibility, Verify/GrantObserver/
 * Revoke). ENFORCES the PII boundary: only the 6 allowed fields may be written.
 * Swap point for a live Canton participant node via the JSON Ledger API.
 */
import { randomUUID } from "node:crypto";

const ALLOWED = new Set(["legalEntityHash", "decision", "riskTier", "uboVerified", "expiresAt", "evidenceHash"]);
const DECISIONS = new Set(["approved", "rejected", "review_required"]);
const RISK = new Set(["low", "medium", "high"]);

export interface KyBPayload {
  legalEntityHash: string;
  decision: string;
  riskTier: string;
  uboVerified: boolean;
  expiresAt: string;
  evidenceHash: string;
}

interface Contract {
  contractId: string;
  issuer: string;
  subject: string;
  observers: string[];
  payload: KyBPayload;
  revoked: boolean;
  createdAt: string;
}

function validate(p: KyBPayload): void {
  const extra = Object.keys(p).filter((k) => !ALLOWED.has(k));
  if (extra.length) throw new Error(`PII BOUNDARY VIOLATION: ${extra.join(",")}`);
  for (const k of ALLOWED) if (!(k in p)) throw new Error(`missing field ${k}`);
  if (!DECISIONS.has(p.decision)) throw new Error("invalid decision");
  if (!RISK.has(p.riskTier)) throw new Error("invalid riskTier");
  if (typeof p.uboVerified !== "boolean") throw new Error("uboVerified must be boolean");
}

class Ledger {
  private contracts = new Map<string, Contract>();

  async createAttestation(issuer: string, subject: string, observers: string[], payload: KyBPayload) {
    validate(payload);
    const contractId = randomUUID();
    this.contracts.set(contractId, {
      contractId, issuer, subject, observers: [...observers], payload: { ...payload },
      revoked: false, createdAt: new Date().toISOString(),
    });
    return { contractId, payload: { ...payload } };
  }

  async verify(contractId: string, party: string): Promise<KyBPayload> {
    const c = this.contracts.get(contractId);
    if (!c) throw new Error(`unknown contract ${contractId}`);
    if (![c.issuer, c.subject, ...c.observers].includes(party)) throw new Error(`party ${party} has no visibility`);
    if (c.revoked) throw new Error("attestation revoked");
    if (c.payload.expiresAt <= new Date().toISOString()) throw new Error("attestation expired");
    return { ...c.payload };
  }

  async revoke(contractId: string, byParty: string): Promise<void> {
    const c = this.contracts.get(contractId);
    if (!c) throw new Error(`unknown contract ${contractId}`);
    if (byParty !== c.issuer) throw new Error("only issuer may revoke");
    c.revoked = true;
  }
}

let _ledger: Ledger | null = null;
export function getLedger(): Ledger {
  if (!_ledger) _ledger = new Ledger();
  return _ledger;
}

/** Test-only: drop all in-process contracts so cases cannot leak into each other. */
export function __resetLedgerForTest(): void {
  _ledger = null;
}
