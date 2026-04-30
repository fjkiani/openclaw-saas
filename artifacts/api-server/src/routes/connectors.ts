import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, connectorsTable, tenantConnectorsTable, tenantsTable } from "@workspace/db";
import { encrypt } from "@workspace/crypto-utils";
import {
  ListTenantConnectorsParams,
  InstallConnectorOnTenantParams,
  InstallConnectorOnTenantBody,
  RemoveConnectorFromTenantParams,
  ListConnectorRegistryResponse,
  ListTenantConnectorsResponse,
  ListTenantConnectorsResponseItem,
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

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

router.get("/connectors", requireAuth, async (_req: any, res): Promise<void> => {
  const connectors = await db.select().from(connectorsTable);
  res.json(ListConnectorRegistryResponse.parse(connectors));
});

router.get("/tenants/:id/connectors", requireAuth, async (req: any, res): Promise<void> => {
  const params = ListTenantConnectorsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { id } = params.data;

  const tenant = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, req.userId))).limit(1);
  if (!tenant.length) { res.status(404).json({ error: "Tenant not found" }); return; }

  const rows = await db
    .select({
      id: tenantConnectorsTable.id,
      tenantId: tenantConnectorsTable.tenantId,
      connectorId: tenantConnectorsTable.connectorId,
      connectorSlug: connectorsTable.slug,
      connectorName: connectorsTable.name,
      verified: tenantConnectorsTable.verified,
      createdAt: tenantConnectorsTable.createdAt,
    })
    .from(tenantConnectorsTable)
    .innerJoin(connectorsTable, eq(tenantConnectorsTable.connectorId, connectorsTable.id))
    .where(eq(tenantConnectorsTable.tenantId, id));

  res.json(ListTenantConnectorsResponse.parse(rows));
});

router.post("/tenants/:id/connectors", requireAuth, async (req: any, res): Promise<void> => {
  const params = InstallConnectorOnTenantParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { id } = params.data;

  const body = InstallConnectorOnTenantBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "connectorId and credential required" }); return; }
  const { connectorId, credential } = body.data;

  const tenant = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, req.userId))).limit(1);
  if (!tenant.length) { res.status(404).json({ error: "Tenant not found" }); return; }

  const connector = await db.select().from(connectorsTable)
    .where(eq(connectorsTable.id, connectorId)).limit(1);
  if (!connector.length) { res.status(404).json({ error: "Connector not found" }); return; }

  const encryptedCredential = encrypt(credential, getSecret());

  const [row] = await db
    .insert(tenantConnectorsTable)
    .values({ tenantId: id, connectorId, encryptedCredential, verified: false })
    .returning();

  const result = {
    id: row.id,
    tenantId: row.tenantId,
    connectorId: row.connectorId,
    connectorSlug: connector[0].slug,
    connectorName: connector[0].name,
    verified: row.verified,
    createdAt: row.createdAt,
  };

  res.status(201).json(ListTenantConnectorsResponseItem.parse(result));
});

router.delete("/tenants/:id/connectors/:connectorId", requireAuth, async (req: any, res): Promise<void> => {
  const params = RemoveConnectorFromTenantParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { id, connectorId } = params.data;

  const tenant = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, req.userId))).limit(1);
  if (!tenant.length) { res.status(404).json({ error: "Tenant not found" }); return; }

  await db.delete(tenantConnectorsTable)
    .where(and(
      eq(tenantConnectorsTable.tenantId, id),
      eq(tenantConnectorsTable.id, connectorId),
    ));

  res.status(204).send();
});

export default router;
