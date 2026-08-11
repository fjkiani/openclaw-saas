/**
 * Zeta L2 vault client — encrypted PII store, token-only downstream.
 *
 * Mirrors the Python vault (l2_vault/vault.py) contract: store -> token +
 * evidenceHash; never return raw PII downstream. AES-256-GCM at rest, key from
 * env ZETA_VAULT_KEY. Swap point for a live databunker service behind the same
 * interface.
 */
import { createCipheriv, createHash, randomBytes, createDecipheriv } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const VAULT_DIR = process.env.ZETA_VAULT_DIR || "/tmp/zeta_vault_ts";

function loadKey(): Buffer {
  const raw = (process.env.ZETA_VAULT_KEY || "").trim();
  if (raw) return createHash("sha256").update(raw).digest();
  mkdirSync(VAULT_DIR, { recursive: true });
  const kf = join(VAULT_DIR, ".dev_key");
  if (existsSync(kf)) return Buffer.from(readFileSync(kf, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(kf, key.toString("hex"), { mode: 0o600 });
  return key;
}

export interface VaultToken {
  token: string;
  record_type: string;
  subject_ref: string;
  evidence_hash: string;
  stored_at: string;
}

class Vault {
  private key: Buffer;
  constructor() {
    mkdirSync(VAULT_DIR, { recursive: true });
    this.key = loadKey();
  }

  async storePii(docBytes: Buffer, recordType: string, subjectRef: string): Promise<VaultToken> {
    if (!docBytes || docBytes.length === 0) throw new Error("empty document refused");
    const evidenceHash = createHash("sha256").update(docBytes).digest("hex");
    const token = crypto.randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(docBytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileSync(join(VAULT_DIR, `${token}.bin`), Buffer.concat([iv, tag, ct]));
    return { token, record_type: recordType, subject_ref: subjectRef, evidence_hash: evidenceHash, stored_at: new Date().toISOString() };
  }

  async reveal(token: string, authz: string): Promise<Buffer> {
    if (!process.env.ZETA_VAULT_REVEAL_AUTHZ || authz !== process.env.ZETA_VAULT_REVEAL_AUTHZ) {
      throw new Error("reveal denied: missing/invalid authorization");
    }
    const raw = readFileSync(join(VAULT_DIR, `${token}.bin`));
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

let _vault: Vault | null = null;
export function getVault(): Vault {
  if (!_vault) _vault = new Vault();
  return _vault;
}
