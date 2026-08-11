/**
 * Zeta L3 VC client — W3C KyBDecisionCredential issuance (Ed25519).
 *
 * Mirrors l3_ledger/vc_issue.py. Issues a signed credential wrapping the minimal
 * claim (never raw PII). Swap point for digitalbazaar/vc (ecdsa-sd-2023 / bbs-2023)
 * when a JS wallet runtime is wired.
 */
import { generateKeyPairSync, sign as edSign, createHash, randomUUID } from "node:crypto";

const VC_CONTEXT = "https://www.w3.org/2018/credentials/v1";
const KYB_CONTEXT = "https://zeta.clearance/contexts/kyb-v1";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ISSUER_DID = "did:key:z" + createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64url");

function canon(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o, Object.keys(o as object).sort()));
}

export interface KyBVCInput {
  subjectDid: string;
  decision: string;
  riskTier: string;
  uboVerified: boolean;
  expiresAt: string;
  evidenceHash: string;
  cantonContractId: string;
}

export async function issueKyBVC(input: KyBVCInput): Promise<Record<string, unknown>> {
  const credential: Record<string, unknown> = {
    "@context": [VC_CONTEXT, KYB_CONTEXT],
    id: `urn:uuid:${randomUUID()}`,
    type: ["VerifiableCredential", "KyBDecisionCredential"],
    issuer: ISSUER_DID,
    issuanceDate: new Date().toISOString(),
    expirationDate: input.expiresAt,
    credentialSubject: {
      id: input.subjectDid,
      decision: input.decision,
      riskTier: input.riskTier,
      uboVerified: input.uboVerified,
      evidenceHash: input.evidenceHash,
      cantonContractId: input.cantonContractId,
    },
  };
  const sig = edSign(null, canon(credential), privateKey);
  credential.proof = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-2022",
    created: new Date().toISOString(),
    verificationMethod: `${ISSUER_DID}#key-1`,
    proofPurpose: "assertionMethod",
    proofValue: "z" + sig.toString("base64url"),
  };
  return credential;
}
