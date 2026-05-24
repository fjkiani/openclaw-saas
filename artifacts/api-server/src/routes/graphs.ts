import { Router, type IRouter } from "express";
import { eq, and, count, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import multer from "multer";
import pdfParse from "pdf-parse";
import {
  db,
  tenantsTable,
  knowledgeGraphsTable,
  graphDocumentsTable,
  graphChunksTable,
} from "@workspace/db";
import {
  ListKnowledgeGraphsParams,
  CreateKnowledgeGraphParams,
  CreateKnowledgeGraphBody,
  DeleteKnowledgeGraphParams,
  ListGraphDocumentsParams,
  QueryKnowledgeGraphParams,
  QueryKnowledgeGraphBody,
  ListKnowledgeGraphsResponse,
  ListKnowledgeGraphsResponseItem,
  ListGraphDocumentsResponse,
  QueryKnowledgeGraphResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const CHUNK_WORDS = 300;
const CHUNK_OVERLAP = 50;

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

function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + CHUNK_WORDS);
    chunks.push(slice.join(" "));
    i += CHUNK_WORDS - CHUNK_OVERLAP;
    if (i < 0) break;
  }
  return chunks.filter((c) => c.trim().length > 20);
}

async function verifyTenantOwnership(tenantId: number, userId: string): Promise<boolean> {
  const rows = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.id, tenantId), eq(tenantsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

router.get("/tenants/:id/graphs", requireAuth, async (req: any, res): Promise<void> => {
  const params = ListKnowledgeGraphsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { id } = params.data;

  if (!(await verifyTenantOwnership(id, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

  const graphs = await db.select().from(knowledgeGraphsTable)
    .where(eq(knowledgeGraphsTable.tenantId, id));

  const withCounts = await Promise.all(
    graphs.map(async (g: (typeof graphs)[number]) => {
      const [{ cnt }] = await db
        .select({ cnt: count() })
        .from(graphDocumentsTable)
        .where(eq(graphDocumentsTable.graphId, g.id));
      return { ...g, documentCount: Number(cnt) };
    }),
  );

  res.json(ListKnowledgeGraphsResponse.parse(withCounts));
});

router.post("/tenants/:id/graphs", requireAuth, async (req: any, res): Promise<void> => {
  const params = CreateKnowledgeGraphParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { id } = params.data;

  const body = CreateKnowledgeGraphBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "name is required" }); return; }

  if (!(await verifyTenantOwnership(id, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

  const [graph] = await db
    .insert(knowledgeGraphsTable)
    .values({
      tenantId: id,
      name: body.data.name,
      description: body.data.description ?? null,
      graphType: body.data.graphType ?? "document",
    })
    .returning();

  res.status(201).json(ListKnowledgeGraphsResponseItem.parse({ ...graph, documentCount: 0 }));
});

router.delete("/tenants/:id/graphs/:graphId", requireAuth, async (req: any, res): Promise<void> => {
  const params = DeleteKnowledgeGraphParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { id, graphId } = params.data;

  if (!(await verifyTenantOwnership(id, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

  await db.delete(knowledgeGraphsTable)
    .where(and(eq(knowledgeGraphsTable.id, graphId), eq(knowledgeGraphsTable.tenantId, id)));

  res.status(204).send();
});

router.get("/tenants/:id/graphs/:graphId/documents", requireAuth, async (req: any, res): Promise<void> => {
  const params = ListGraphDocumentsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { id, graphId } = params.data;

  if (!(await verifyTenantOwnership(id, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

  const docs = await db.select().from(graphDocumentsTable)
    .where(eq(graphDocumentsTable.graphId, graphId));

  res.json(ListGraphDocumentsResponse.parse(docs));
});

router.post(
  "/tenants/:id/graphs/:graphId/documents",
  requireAuth,
  upload.single("file"),
  async (req: any, res): Promise<void> => {
    const tenantId = Number(req.params.id);
    const graphId = Number(req.params.graphId);

    if (isNaN(tenantId) || isNaN(graphId)) { res.status(400).json({ error: "Invalid params" }); return; }
    if (!(await verifyTenantOwnership(tenantId, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

    const graph = await db.select().from(knowledgeGraphsTable)
      .where(and(eq(knowledgeGraphsTable.id, graphId), eq(knowledgeGraphsTable.tenantId, tenantId)))
      .limit(1);
    if (!graph.length) { res.status(404).json({ error: "Graph not found" }); return; }

    const file = req.file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }

    const [doc] = await db
      .insert(graphDocumentsTable)
      .values({
        graphId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        status: "processing",
      })
      .returning();

    res.status(202).json(doc);

    setImmediate(async () => {
      try {
        let text = "";
        if (file.mimetype === "application/pdf") {
          const parsed = await pdfParse(file.buffer);
          text = parsed.text;
        } else {
          text = file.buffer.toString("utf-8");
        }

        const chunks = chunkText(text);

        if (chunks.length > 0) {
          await db.insert(graphChunksTable).values(
            chunks.map((content, chunkIndex) => ({
              documentId: doc.id,
              graphId,
              chunkIndex,
              content,
            })),
          );
        }

        await db
          .update(graphDocumentsTable)
          .set({ status: "ready", chunkCount: chunks.length, updatedAt: new Date() })
          .where(eq(graphDocumentsTable.id, doc.id));
      } catch (err: any) {
        await db
          .update(graphDocumentsTable)
          .set({ status: "error", errorMessage: err?.message ?? "Processing failed", updatedAt: new Date() })
          .where(eq(graphDocumentsTable.id, doc.id));
      }
    });
  },
);

router.post("/tenants/:id/graphs/:graphId/query", requireAuth, async (req: any, res): Promise<void> => {
  const params = QueryKnowledgeGraphParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { id, graphId } = params.data;

  const body = QueryKnowledgeGraphBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "query is required" }); return; }
  const { query, limit = 10 } = body.data;

  if (!(await verifyTenantOwnership(id, req.userId))) { res.status(404).json({ error: "Tenant not found" }); return; }

  const rows = await db.execute(sql`
    SELECT
      id,
      document_id AS "documentId",
      chunk_index AS "chunkIndex",
      content,
      ts_rank(tsv, plainto_tsquery('english', ${query})) AS rank
    FROM graph_chunks
    WHERE graph_id = ${graphId}
      AND tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `) as { rows: Array<{ id: number; documentId: number; chunkIndex: number; content: string; rank: string }> };

  const chunks = rows.rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    chunkIndex: r.chunkIndex,
    content: r.content,
    rank: parseFloat(r.rank),
  }));

  res.json(QueryKnowledgeGraphResponse.parse({ chunks, totalFound: chunks.length }));
});

export default router;
