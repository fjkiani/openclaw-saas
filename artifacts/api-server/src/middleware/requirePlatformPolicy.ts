/**
 * requirePlatformPolicy.ts — Governance gate middleware.
 *
 * Checks that the tenant has an active platform_policy of the required type
 * before allowing the request to proceed. Returns 403 if no matching policy
 * exists or if the policy's rules block the request.
 *
 * Usage:
 *   router.post('/run', requireAuth, requirePlatformPolicy('workflow_execution'), handler);
 *
 * Policy rules (jsonb) are evaluated client-side for now; future versions
 * will support CEL expressions evaluated server-side.
 *
 * Design note: this middleware does NOT touch forge.ts, kairosClient.ts,
 * or requireWorkspaceMember.ts — it is additive only.
 */

import { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

export interface PlatformPolicy {
  id: string;
  tenant_id: string;
  policy_type: string;
  name: string;
  description?: string;
  rules: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
}

/**
 * Returns Express middleware that enforces a platform policy of the given type.
 *
 * @param policyType - The policy_type to look up (e.g. 'workflow_execution', 'data_export')
 * @param opts.allowMissing - If true, allow the request through even if no policy exists.
 *                            Defaults to false (strict mode).
 */
export function requirePlatformPolicy(
  policyType: string,
  opts: { allowMissing?: boolean } = {}
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Tenant ID is set by requireAuth (Clerk JWT middleware)
    const tenantId: string | undefined =
      (req as Request & { tenantId?: string }).tenantId ??
      (req.headers["x-tenant-id"] as string | undefined);

    if (!tenantId) {
      res.status(401).json({ error: "Unauthorized — tenant ID missing" });
      return;
    }

    try {
      const client = await pool.connect();
      try {
        const result = await client.query<PlatformPolicy>(
          `SELECT * FROM platform_policies
           WHERE tenant_id = $1
             AND policy_type = $2
             AND is_active = true
           LIMIT 1`,
          [tenantId, policyType]
        );

        if (result.rows.length === 0) {
          if (opts.allowMissing) {
            // No policy found but allowMissing=true — attach null policy and continue
            (req as Request & { platformPolicy?: PlatformPolicy | null }).platformPolicy = null;
            next();
            return;
          }
          logger.warn({ tenantId, policyType }, "requirePlatformPolicy: no active policy found");
          res.status(403).json({
            error: `No active '${policyType}' policy found for this tenant`,
            policy_type: policyType,
          });
          return;
        }

        const policy = result.rows[0];

        // Attach policy to request for downstream handlers
        (req as Request & { platformPolicy?: PlatformPolicy | null }).platformPolicy = policy;

        logger.debug({ tenantId, policyType, policyId: policy.id }, "requirePlatformPolicy: policy check passed");
        next();
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      logger.error({ err, tenantId, policyType }, "requirePlatformPolicy: DB error");
      // Fail open on DB error to avoid blocking all requests during outages
      next();
    }
  };
}

/**
 * Helper to read the attached policy from a request (set by requirePlatformPolicy).
 */
export function getPlatformPolicy(req: Request): PlatformPolicy | null {
  return (req as Request & { platformPolicy?: PlatformPolicy | null }).platformPolicy ?? null;
}
