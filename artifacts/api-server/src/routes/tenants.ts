import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, tenantsTable, skillsTable, tenantSkillsTable, activityEntriesTable, skillBenchmarksTable } from "@workspace/db";
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
import {
  provisionTenant,
  startTenant,
  stopTenant,
  destroyTenant,
} from "@workspace/gateway-provisioner";
import { checkBenchmarkGate } from "../lib/benchmarkClient";

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

function hasRenderCreds(): boolean {
  return !!(process.env.RENDER_API_KEY && process.env.RENDER_OWNER_ID);
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

  const gatewayToken = `tok_${crypto.randomUUID().replace(/-/g, "")}`;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({
      userId: req.userId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      skillPack: parsed.data.skillPack ?? null,
      status: "provisioning",
      gatewayToken,
    })
    .returning();

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_started",
    message: `Provisioning agent instance "${parsed.data.name}"`,
  });

  if (hasRenderCreds()) {
    try {
      const { serviceId, wsEndpoint } = await provisionTenant(
        String(tenant.id),
        gatewayToken
      );
      await db
        .update(tenantsTable)
        .set({ renderServiceId: serviceId, wsEndpoint, status: "provisioning" })
        .where(eq(tenantsTable.id, tenant.id));
      await db.insert(activityEntriesTable).values({
        tenantId: tenant.id,
        type: "agent_started",
        message: `Render service ${serviceId} created — waiting for deploy`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      req.log?.error({ err, tenantId: tenant.id }, "provisionTenant failed");
      await db
        .update(tenantsTable)
        .set({ status: "error" })
        .where(eq(tenantsTable.id, tenant.id));
      await db.insert(activityEntriesTable).values({
        tenantId: tenant.id,
        type: "agent_stopped",
        message: `Provisioning failed: ${message}`,
      });
    }
  } else {
    req.log?.warn("RENDER_API_KEY/RENDER_OWNER_ID not set — skipping real provisioning");
    await db
      .update(tenantsTable)
      .set({ status: "stopped" })
      .where(eq(tenantsTable.id, tenant.id));
  }

  const [updated] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenant.id));

  res.status(201).json(GetTenantResponse.parse(updated ?? tenant));
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
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, params.data.id), eq(tenantsTable.userId, req.userId)));

  if (!tenant) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  if (tenant.renderServiceId && hasRenderCreds()) {
    try {
      await destroyTenant(tenant.renderServiceId);
    } catch (err) {
      req.log?.error({ err, serviceId: tenant.renderServiceId }, "destroyTenant failed");
    }
  }

  await db
    .delete(tenantsTable)
    .where(eq(tenantsTable.id, tenant.id));

  res.sendStatus(204);
});

router.post("/tenants/:id/start", requireAuth, async (req: any, res): Promise<void> => {
  const params = StartTenantParams.safeParse(req.params);
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

  if (tenant.renderServiceId && hasRenderCreds()) {
    try {
      await startTenant(tenant.renderServiceId);
    } catch (err) {
      req.log?.error({ err, serviceId: tenant.renderServiceId }, "startTenant failed");
    }
  }

  const [updated] = await db
    .update(tenantsTable)
    .set({ status: "running", memoryUsedKb: Math.floor(Math.random() * 50000) + 10000 })
    .where(eq(tenantsTable.id, tenant.id))
    .returning();

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_started",
    message: `Agent "${tenant.name}" started`,
  });

  res.json(GetTenantResponse.parse(updated));
});

router.post("/tenants/:id/stop", requireAuth, async (req: any, res): Promise<void> => {
  const params = StopTenantParams.safeParse(req.params);
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

  if (tenant.renderServiceId && hasRenderCreds()) {
    try {
      await stopTenant(tenant.renderServiceId);
    } catch (err) {
      req.log?.error({ err, serviceId: tenant.renderServiceId }, "stopTenant failed");
    }
  }

  const [updated] = await db
    .update(tenantsTable)
    .set({ status: "stopped", memoryUsedKb: 0 })
    .where(eq(tenantsTable.id, tenant.id))
    .returning();

  await db.insert(activityEntriesTable).values({
    tenantId: tenant.id,
    type: "agent_stopped",
    message: `Agent "${tenant.name}" stopped`,
  });

  res.json(GetTenantResponse.parse(updated));
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

  // Benchmark gate — check if skill passes before installing
  const BENCHMARK_GATE_ENABLED = process.env.BENCHMARK_GATE_ENABLED !== "false";
  if (BENCHMARK_GATE_ENABLED) {
    const [skillToCheck] = await db.select().from(skillsTable).where(eq(skillsTable.id, body.data.skillId)).limit(1);
    if (skillToCheck) {
      const gate = await checkBenchmarkGate(
        skillToCheck.id,
        skillToCheck.name,
        skillToCheck.description,
        skillToCheck.category,
      );
      if (!gate.passes) {
        res.status(422).json({
          error: "Skill failed benchmark — cannot install in production",
          grade: gate.result?.grade,
          overall_score: gate.result?.overall_score,
          level_scores: gate.result?.level_scores,
          reason: gate.reason,
        });
        return;
      }
      // Store benchmark result
      if (gate.result) {
        await db.insert(skillBenchmarksTable).values({
          skillId: skillToCheck.id,
          benchmarkId: gate.result.benchmark_id,
          grade: gate.result.grade,
          overallScore: gate.result.overall_score,
          levelScores: gate.result.level_scores as any,
          llmResults: gate.result.llm_results as any,
          testSuite: "quick",
          durationMs: gate.result.duration_ms,
          error: gate.result.error,
        }).onConflictDoNothing();
      }
    }
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
