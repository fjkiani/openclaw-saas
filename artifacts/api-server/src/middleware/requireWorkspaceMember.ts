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

  // 3. Resolve authenticated user from Clerk middleware
  const userId: string | undefined = (req as any).auth?.userId;
  if (!userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // 4. Verify the user owns the tenant
  const tenantResult = await pool.query(
    `SELECT id FROM tenants WHERE id = $1 AND user_id = $2`,
    [workspace.tenantId, userId],
  );
  if (tenantResult.rows.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // 5. Attach resolved context and continue
  req.resolvedTenantId = workspace.tenantId;
  req.resolvedWorkspace = workspace;
  next();
}
