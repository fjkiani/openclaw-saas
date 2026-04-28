import { Router, type IRouter } from "express";
import { eq, and, asc } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, tenantsTable, chatMessagesTable } from "@workspace/db";
import {
  GetChatHistoryParams,
  SendChatMessageParams,
  SendChatMessageBody,
  GetChatHistoryResponse,
  SendChatMessageResponse,
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

router.get("/tenants/:id/chat", requireAuth, async (req: any, res): Promise<void> => {
  const params = GetChatHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tenant id" });
    return;
  }
  const { id } = params.data;

  const tenant = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, req.userId)))
    .limit(1);

  if (!tenant.length) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.tenantId, id))
    .orderBy(asc(chatMessagesTable.createdAt));

  res.json(GetChatHistoryResponse.parse(messages));
});

router.post("/tenants/:id/chat", requireAuth, async (req: any, res): Promise<void> => {
  const params = SendChatMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tenant id" });
    return;
  }
  const { id } = params.data;

  const body = SendChatMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const { message } = body.data;

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, req.userId)))
    .limit(1);

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  if (tenant.status !== "running") {
    res.status(409).json({ error: "Agent must be running to chat. Start it first." });
    return;
  }

  const [userMsg] = await db
    .insert(chatMessagesTable)
    .values({ tenantId: id, role: "user", content: message })
    .returning();

  let assistantContent: string;
  let assistantRole: "assistant" | "error" = "assistant";

  if (tenant.wsEndpoint && tenant.gatewayToken) {
    const httpBase = tenant.wsEndpoint
      .replace(/^wss?:\/\//, "https://")
      .replace(/\/$/, "");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const gwRes = await fetch(`${httpBase}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tenant.gatewayToken}`,
        },
        body: JSON.stringify({ message, conversationId: String(id) }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!gwRes.ok) {
        const text = await gwRes.text().catch(() => "");
        req.log.warn({ status: gwRes.status, body: text }, "Gateway returned non-OK");
        assistantContent = `Gateway error ${gwRes.status}: ${text || gwRes.statusText}`;
        assistantRole = "error";
      } else {
        const json = await gwRes.json() as Record<string, unknown>;
        assistantContent =
          (json.response as string) ??
          (json.message as string) ??
          (json.content as string) ??
          (json.text as string) ??
          JSON.stringify(json);
      }
    } catch (err: any) {
      clearTimeout(timeout);
      const isTimeout = err?.name === "AbortError";
      req.log.warn({ err }, "Gateway proxy error");
      assistantContent = isTimeout
        ? "Gateway timed out. The agent may be starting up — try again in a moment."
        : `Could not reach gateway: ${err?.message ?? "unknown error"}`;
      assistantRole = "error";
    }
  } else {
    assistantContent = "No gateway endpoint configured for this agent.";
    assistantRole = "error";
  }

  const [assistantMsg] = await db
    .insert(chatMessagesTable)
    .values({ tenantId: id, role: assistantRole, content: assistantContent })
    .returning();

  res.json(SendChatMessageResponse.parse(assistantMsg));

  void userMsg;
});

export default router;
