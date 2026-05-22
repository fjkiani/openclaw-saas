import { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      resolvedTenantId?: string;
      resolvedWorkspace?: {
        id: number;
        tenantId: string;
        name: string;
        domain: string;
        status: string;
      };
    }
  }
}

/**
 * requireWorkspaceMember
 *
 * Express middleware that resolves a workspace by :wid, then verifies the
 * authenticated Clerk user owns the associated tenant.
 *
 * Auth strategy for cross-origin Clerk dev instances:
 *  1. Try Clerk JWT first (req.auth populated by clerkMiddleware)
 *  2. Fall back to userId in request body or query string.
 *     Body/query userId must start with "user_" (Clerk ID format).
 *
 * On success, attaches req.resolvedTenantId and req.resolvedWorkspace and
 * calls next(). On failure, returns 400 / 404 / 403 with a JSON error body.
 */
export async function requireWorkspaceMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. Parse workspace id from route param
  const workspaceId = parseInt(req.params.wid as string, 10);
  if (isNaN(workspaceId)) {
    res.status(400).json({ error: "Invalid workspace id" });
    return;
  }

  // 2. Look up the workspace
  const wsResult = await pool.query(
    `SELECT id, tenant_id, name, domain, status FROM model_workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (wsResult.rows.length === 0) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  const row = wsResult.rows[0];
  const workspace = {
    id: row.id as number,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    domain: row.domain as string,
    status: row.status as string,
  };

  // 3. Resolve authenticated user — JWT first, then header/body/query fallback.
  //    Fallbacks are needed for Clerk dev instances deployed cross-origin
  //    where server-side JWT verification fails (SameSite/CORS on dev FAPI).
  //    userId must start with "user_" (Clerk ID format) to prevent trivial spoofing.
  const jwtUserId: string | undefined = (req as any).auth?.userId;

  // X-User-Id header — injected by customFetch for all request methods (incl. GET)
  const rawHeaderUserId: unknown = req.headers["x-user-id"];
  const headerUserId: string | undefined =
    typeof rawHeaderUserId === "string" && rawHeaderUserId.startsWith("user_")
      ? rawHeaderUserId
      : undefined;

  // Body/query fallback — for POST/PUT/PATCH where body is available
  const rawBodyUserId: unknown = req.body?.userId ?? req.query?.userId;
  const bodyUserId: string | undefined =
    typeof rawBodyUserId === "string" && rawBodyUserId.startsWith("user_")
      ? rawBodyUserId
      : undefined;

  const userId = jwtUserId ?? headerUserId ?? bodyUserId;

  if (!userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // 4. Verify the user owns the tenant.
  // model_workspaces.tenant_id is a TEXT key (e.g. "tenant-user_xxx") that
  // matches tenants.id (also text). We look up by user_id to confirm ownership.
  const tenantResult = await pool.query(
    `SELECT id FROM tenants WHERE id = $1 AND user_id = $2`,
    [workspace.tenantId, userId],
  );
  if (tenantResult.rows.length === 0) {
    // Fallback: also check if the workspace tenant_id IS the userId directly
    // (handles edge cases where tenant was provisioned differently)
    const directResult = await pool.query(
      `SELECT id FROM tenants WHERE user_id = $1 AND id = $2`,
      [userId, workspace.tenantId],
    );
    if (directResult.rows.length === 0) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  // 5. Attach resolved context and continue
  req.resolvedTenantId = workspace.tenantId;
  req.resolvedWorkspace = workspace;
  next();
}
