import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/webhooks/render", async (req, res): Promise<void> => {
  const { service, type } = req.body as {
    service?: { id?: string };
    type?: string;
  };

  if (!service?.id || !type) {
    res.status(400).json({ error: "Missing service.id or type" });
    return;
  }

  if (type === "deploy_ended") {
    await db
      .update(tenantsTable)
      .set({ status: "running" })
      .where(eq(tenantsTable.renderServiceId, service.id));
  }

  if (type === "service_suspended") {
    await db
      .update(tenantsTable)
      .set({ status: "stopped" })
      .where(eq(tenantsTable.renderServiceId, service.id));
  }

  if (type === "service_deleted") {
    await db
      .update(tenantsTable)
      .set({ status: "stopped", renderServiceId: null })
      .where(eq(tenantsTable.renderServiceId, service.id));
  }

  res.json({ ok: true });
});

export default router;
