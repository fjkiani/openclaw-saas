import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_BYTES) as Buffer;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a base64 string: salt(16) + iv(12) + tag(16) + ciphertext
 */
export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(secret, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64 string produced by encrypt().
 */
export function decrypt(ciphertext: string, secret: string): string {
  const buf = Buffer.from(ciphertext, "base64");

  let offset = 0;
  const salt = buf.subarray(offset, (offset += SALT_BYTES));
  const iv = buf.subarray(offset, (offset += IV_BYTES));
  const tag = buf.subarray(offset, (offset += TAG_BYTES));
  const encrypted = buf.subarray(offset);

  const key = deriveKey(secret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
