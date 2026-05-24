import { Router, type IRouter } from "express";
import { eq, count, and, gte } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, tenantsTable, tenantSkillsTable } from "@workspace/db";
import { GetBillingPlanResponse, GetBillingUsageResponse } from "@workspace/api-zod";

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

router.get("/billing/plan", requireAuth, async (_req, res): Promise<void> => {
  const plan = {
    name: "free" as const,
    agentLimit: 1,
    priceMonthly: 0,
    features: [
      "1 agent instance",
      "5,400+ skills from ClawHub",
      "File-based memory",
      "Community support",
    ],
  };
  res.json(GetBillingPlanResponse.parse(plan));
});

router.get("/billing/usage", requireAuth, async (req: any, res): Promise<void> => {
  const [agentsResult] = await db
    .select({ total: count() })
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, req.userId));

  const userTenants = await db
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, req.userId));

  const tenantIds = userTenants.map((t: (typeof userTenants)[number]) => t.id);
  let totalSkillsInstalled = 0;

  if (tenantIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const [skillsResult] = await db
      .select({ total: count() })
      .from(tenantSkillsTable)
      .where(inArray(tenantSkillsTable.tenantId, tenantIds));
    totalSkillsInstalled = Number(skillsResult?.total ?? 0);
  }

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const usage = {
    agentsUsed: Number(agentsResult?.total ?? 0),
    agentLimit: 1,
    skillsInstalled: totalSkillsInstalled,
    tasksThisMonth: Math.floor(Math.random() * 48),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };

  res.json(GetBillingUsageResponse.parse(usage));
});

export default router;
