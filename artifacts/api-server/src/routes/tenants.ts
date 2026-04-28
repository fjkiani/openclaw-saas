import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, tenantsTable, skillsTable, tenantSkillsTable, activityEntriesTable } from "@workspace/db";
import {
  CreateTenantBody,
  UpdateTenantBody,
  GetTenantParams,
  UpdateTenantParams,
  DeleteTenantParams,
  StartTenantParams,
  StopTenantParams,
  ListTenantSkillsParams,
  InstallSkillOnTenantParams,
  InstallSkillOnTenantBody,
  UninstallSkillFromTenantParams,
  GetTenantActivityParams,
  GetTenantResponse,
  ListTenantsResponse,
  ListTenantSkillsResponse,
  GetTenantActivityResponse,
} from "@workspace/api-zod";

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

router.get("/tenants", requireAuth, async (req: any, res): Promise<void> => {
  const tenants = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, req.userId))
    .orderBy(desc(tenantsTable.createdAt));
  res.json(ListTenantsResponse.parse(tenants));
});

router.post("/tenants", requireAuth, async (req: any, res): Promise<void> => {
  const parsed = CreateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [tenant] = await db
    .insert(tenantsTable)
    .values({
      userId: req.userId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      skillPack: parsed.data.skillPack ?? null,
      status: "provisioning",
    })
    .returning();

  // Simulate provisioning completing after a moment
  setTimeout(async () => {
    await db
      .update(tenantsTable)
      .set({ status: "stopped", wsEndpoint: `ws://gateway-${tenant.id}.openclaw.internal:18789`, gatewayToken: `tok_${Math.random().toString(36).slice(2)}` })
      .where(eq(tenantsTable.id, tenant.id));
    await db.insert(activityEntriesTable).values({
      tenantId: tenant.id,
      type: "agent_started",
      message: `Agent instance "${parsed.data.name}" provisioned successfully`,
    });
  }, 2000);

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_started",
    message: `Provisioning agent instance "${parsed.data.name}"`,
  });

  res.status(201).json(GetTenantResponse.parse(tenant));
});

router.get("/tenants/:id", requireAuth, async (req: any, res): Promise<void> => {
  const params = GetTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json(GetTenantResponse.parse(tenant));
});

router.patch("/tenants/:id", requireAuth, async (req: any, res): Promise<void> => {
  const params = UpdateTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateTenantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description;

  const [tenant] = await db
    .update(tenantsTable)
    .set(updates)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)))
    .returning();

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json(GetTenantResponse.parse(tenant));
});

router.delete("/tenants/:id", requireAuth, async (req: any, res): Promise<void> => {
  const params = DeleteTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .delete(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)))
    .returning();

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/tenants/:id/start", requireAuth, async (req: any, res): Promise<void> => {
  const params = StartTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .update(tenantsTable)
    .set({ status: "running", memoryUsedKb: Math.floor(Math.random() * 50000) + 10000 })
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)))
    .returning();

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_started",
    message: `Agent "${tenant.name}" started`,
  });

  res.json(GetTenantResponse.parse(tenant));
});

router.post("/tenants/:id/stop", requireAuth, async (req: any, res): Promise<void> => {
  const params = StopTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .update(tenantsTable)
    .set({ status: "stopped", memoryUsedKb: 0 })
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)))
    .returning();

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_stopped",
    message: `Agent "${tenant.name}" stopped`,
  });

  res.json(GetTenantResponse.parse(tenant));
});

router.get("/tenants/:id/skills", requireAuth, async (req: any, res): Promise<void> => {
  const params = ListTenantSkillsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const installed = await db
    .select({
      id: tenantSkillsTable.id,
      tenantId: tenantSkillsTable.tenantId,
      skillId: tenantSkillsTable.skillId,
      skillName: skillsTable.name,
      skillSlug: skillsTable.slug,
      category: skillsTable.category,
      installedAt: tenantSkillsTable.installedAt,
    })
    .from(tenantSkillsTable)
    .innerJoin(skillsTable, eq(tenantSkillsTable.skillId, skillsTable.id))
    .where(eq(tenantSkillsTable.tenantId, params.data.id))
    .orderBy(desc(tenantSkillsTable.installedAt));

  res.json(ListTenantSkillsResponse.parse(installed));
});

router.post("/tenants/:id/skills", requireAuth, async (req: any, res): Promise<void> => {
  const params = InstallSkillOnTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = InstallSkillOnTenantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, body.data.skillId));
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const [tenantSkill] = await db
    .insert(tenantSkillsTable)
    .values({ tenantId: params.data.id, skillId: body.data.skillId })
    .returning();

  await db
    .update(skillsTable)
    .set({ installs: skill.installs + 1 })
    .where(eq(skillsTable.id, body.data.skillId));

  await db.insert(activityEntriesTable).values({
    tenantId: params.data.id,
    type: "skill_installed",
    message: `Skill "${skill.name}" installed on "${tenant.name}"`,
  });

  res.status(201).json({
    id: tenantSkill.id,
    tenantId: tenantSkill.tenantId,
    skillId: tenantSkill.skillId,
    skillName: skill.name,
    skillSlug: skill.slug,
    category: skill.category,
    installedAt: tenantSkill.installedAt.toISOString(),
  });
});

router.delete("/tenants/:id/skills/:skillId", requireAuth, async (req: any, res): Promise<void> => {
  const params = UninstallSkillFromTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const [removed] = await db
    .delete(tenantSkillsTable)
    .where(and(eq(tenantSkillsTable.tenantId, params.data.id), eq(tenantSkillsTable.skillId, params.data.skillId)))
    .returning();

  if (!removed) {
    res.status(404).json({ error: "Skill not installed" });
    return;
  }

  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, params.data.skillId));
  if (skill) {
    await db.insert(activityEntriesTable).values({
      tenantId: params.data.id,
      type: "skill_uninstalled",
      message: `Skill "${skill.name}" uninstalled from "${tenant.name}"`,
    });
  }

  res.sendStatus(204);
});

router.get("/tenants/:id/activity", requireAuth, async (req: any, res): Promise<void> => {
  const params = GetTenantActivityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const entries = await db
    .select()
    .from(activityEntriesTable)
    .where(eq(activityEntriesTable.tenantId, params.data.id))
    .orderBy(desc(activityEntriesTable.createdAt))
    .limit(50);

  res.json(GetTenantActivityResponse.parse(entries));
});

export default router;
