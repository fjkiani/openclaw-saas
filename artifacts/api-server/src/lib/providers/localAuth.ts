/**
 * localAuth.ts — self-contained auth provider for sovereign / air-gapped deploys.
 *
 * When a tenant deploys OpenClaw on-prem (hedge fund, hospital, compliance-bound),
 * there is no Clerk / external IdP reachable. This provider issues and verifies
 * its own HMAC-SHA256-signed JWTs against a local users table — real multi-user
 * auth with zero external dependency.
 *
 * Enabled via env:  AUTH_PROVIDER=local   (default: clerk)
 *   LOCAL_AUTH_SECRET     — HMAC signing secret (required when local; auto-generated
 *                           and persisted to DB on first boot if absent)
 *   LOCAL_AUTH_TOKEN_TTL  — seconds a session token lives (default: 43200 = 12h)
 *
 * Users are stored in `local_auth_users` (created by migration). Passwords are
 * salted PBKDF2 hashes — never plaintext, never a reversible encoding.
 *
 * The exported `localGetAuth(req)` mirrors Clerk's getAuth() return shape
 * ({ userId } | null) so routes can swap providers without changing call logic.
 */

import crypto from "node:crypto";
import type { Request } from "express";
import { pool } from "@workspace/db";
import { logger } from "../logger.js";

export const AUTH_PROVIDER = (process.env.AUTH_PROVIDER ?? "clerk").toLowerCase();
const TOKEN_TTL = Number(process.env.LOCAL_AUTH_TOKEN_TTL ?? 43200);
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = "sha256";

// ─────────────────────────────────────────────────────────────────────────────
// Signing secret (env, or generated+persisted)
// ─────────────────────────────────────────────────────────────────────────────

let cachedSecret: string | null = null;

async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const envSecret = process.env.LOCAL_AUTH_SECRET?.trim();
  if (envSecret) { cachedSecret = envSecret; return envSecret; }
  // Persist a generated secret so tokens survive restarts.
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS local_auth_kv (key text PRIMARY KEY, value text NOT NULL)`);
    const r = await client.query(`SELECT value FROM local_auth_kv WHERE key='signing_secret'`);
    if (r.rows.length) { cachedSecret = r.rows[0].value as string; return cachedSecret; }
    const gen = crypto.randomBytes(48).toString("hex");
    await client.query(`INSERT INTO local_auth_kv (key, value) VALUES ('signing_secret', $1)`, [gen]);
    cachedSecret = gen;
    logger.info("localAuth: generated and persisted new signing secret");
    return gen;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Password hashing (PBKDF2)
// ─────────────────────────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iters, salt, hash] = parts;
  const candidate = crypto.pbkdf2Sync(password, salt, Number(iters), PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT (HMAC-SHA256), self-contained
// ─────────────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const secret = await getSigningSecret();
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  const secret = await getSigningSecret();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// User store
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

export async function ensureLocalAuthTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS local_auth_users (
        id text PRIMARY KEY,
        email text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } finally {
    client.release();
  }
}

export async function createLocalUser(email: string, password: string, role = "member"): Promise<LocalUser> {
  await ensureLocalAuthTables();
  const id = "local_" + crypto.randomBytes(9).toString("hex");
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO local_auth_users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      [id, email.toLowerCase().trim(), hashPassword(password), role],
    );
    return { id, email: email.toLowerCase().trim(), role, created_at: new Date().toISOString() };
  } finally {
    client.release();
  }
}

export async function authenticateLocalUser(email: string, password: string): Promise<{ user: LocalUser; token: string } | null> {
  await ensureLocalAuthTables();
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, email, password_hash, role, created_at FROM local_auth_users WHERE email=$1`,
      [email.toLowerCase().trim()],
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    if (!verifyPassword(password, row.password_hash as string)) return null;
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: row.id, email: row.email, role: row.role, iat: now, exp: now + TOKEN_TTL });
    return {
      user: { id: row.id, email: row.email, role: row.role, created_at: row.created_at },
      token,
    };
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getAuth-compatible request resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the authenticated user from a request when AUTH_PROVIDER=local.
 * Mirrors Clerk's getAuth() shape: returns { userId } or null.
 * Reads `Authorization: Bearer <token>`.
 */
export async function localGetAuth(req: Request): Promise<{ userId: string; sessionClaims?: Record<string, unknown> } | null> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const payload = await verifyToken(token);
  if (!payload?.sub) return null;
  return { userId: payload.sub as string, sessionClaims: payload };
}

/** True when local auth is the active provider. */
export function isLocalAuthEnabled(): boolean {
  return AUTH_PROVIDER === "local";
}
