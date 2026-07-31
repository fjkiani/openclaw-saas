/**
 * localAuth.ts — routes for the local (sovereign) auth provider.
 *
 * Active only when AUTH_PROVIDER=local. Provides register / login / status /
 * me against the self-contained HMAC-JWT provider (no external IdP).
 *
 * Routes:
 *   POST /api/auth/local/register  — create a local user (first user becomes admin)
 *   POST /api/auth/local/login     — authenticate, receive a session token
 *   GET  /api/auth/local/me        — resolve the current token → user
 *   GET  /api/auth/provider        — which auth provider is active (public)
 */

import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  isLocalAuthEnabled,
  createLocalUser,
  authenticateLocalUser,
  localGetAuth,
  ensureLocalAuthTables,
} from "../lib/providers/localAuth.js";

const router = Router();

function localOnly(res: Response): boolean {
  if (!isLocalAuthEnabled()) {
    res.status(404).json({ error: "local auth provider not enabled (AUTH_PROVIDER != local)" });
    return false;
  }
  return true;
}

/** GET /api/auth/provider — active provider (public, used by front-end to pick login UI) */
router.get("/provider", (_req: Request, res: Response) => {
  res.json({ provider: isLocalAuthEnabled() ? "local" : "clerk" });
});

/** POST /api/auth/local/register */
router.post("/local/register", async (req: Request, res: Response) => {
  if (!localOnly(res)) return;
  const { email, password, role } = (req.body ?? {}) as { email?: string; password?: string; role?: string };
  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: "email and password (>=8 chars) required" });
    return;
  }
  try {
    await ensureLocalAuthTables();
    // First user becomes admin; subsequent users default to member unless an
    // existing admin sets their role (role elevation via this endpoint is restricted).
    const count = await pool.query(`SELECT count(*)::int AS n FROM local_auth_users`);
    const isFirst = (count.rows[0]?.n ?? 0) === 0;
    const assignedRole = isFirst ? "admin" : "member";
    const user = await createLocalUser(email, password, isFirst ? "admin" : assignedRole);
    logger.info({ email, role: user.role }, "[localAuth] user registered");
    res.status(201).json({ user });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate") || msg.includes("unique")) {
      res.status(409).json({ error: "email already registered" });
      return;
    }
    logger.error({ err }, "[localAuth] register failed");
    res.status(500).json({ error: msg });
  }
});

/** POST /api/auth/local/login */
router.post("/local/login", async (req: Request, res: Response) => {
  if (!localOnly(res)) return;
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const result = await authenticateLocalUser(email, password);
  if (!result) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({ user: result.user, token: result.token, token_type: "Bearer" });
});

/** GET /api/auth/local/me */
router.get("/local/me", async (req: Request, res: Response) => {
  if (!localOnly(res)) return;
  const auth = await localGetAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ userId: auth.userId, claims: auth.sessionClaims });
});

export default router;
