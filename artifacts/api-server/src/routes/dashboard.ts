import { Router, type IRouter } from "express";
import { eq, count, and } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, tenantsTable, tenantSkillsTable, activityEntriesTable } from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function requireAuth(req: any, res: any, next: any) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}

router.get("/dashboard/summary", requireAuth, async (req: any, res): Promise<void> => {
  const [tenantsResult] = await db
    .select({ total: count() })
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, req.userId));

  const [runningResult] = await db
    .select({ total: count() })
    .from(tenantsTable)
    .where(and(eq(tenantsTable.userId, req.userId), eq(tenantsTable.status, "running")));

  // Count total skills installed across all user tenants
  const userTenants = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, req.userId));

  const tenantIds = userTenants.map((t) => t.id);
  let totalSkillsInstalled = 0;
  let totalTasksCompleted = 0;

  if (tenantIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const [skillsResult] = await db
      .select({ total: count() })
      .from(tenantSkillsTable)
      .where(inArray(tenantSkillsTable.tenantId, tenantIds));
    totalSkillsInstalled = Number(skillsResult?.total ?? 0);

    const [tasksResult] = await db
      .select({ total: count() })
      .from(activityEntriesTable)
      .where(
        and(
          inArray(activityEntriesTable.tenantId, tenantIds),
          eq(activityEntriesTable.type, "task_completed"),
        ),
      );
    totalTasksCompleted = Number(tasksResult?.total ?? 0);
  }

  const summary = {
    totalAgents: Number(tenantsResult?.total ?? 0),
    runningAgents: Number(runningResult?.total ?? 0),
    totalSkillsInstalled,
    totalTasksCompleted,
    planName: "free",
    agentLimit: 1,
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

export default router;
