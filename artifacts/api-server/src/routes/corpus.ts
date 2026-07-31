/**
 * corpus.ts — Legal corpus management API.
 *
 * Lets an admin ingest a REAL legal corpus (CUAD, or caller-supplied texts)
 * into Postgres + Qdrant so hybrid retrieval returns genuine contract language.
 * This is the capability that turns retrieval from a thin seed matcher into a
 * real corpus-backed RAG.
 *
 * Routes:
 *   POST /api/corpus/ingest        — start an ingestion job (admin token)
 *   GET  /api/corpus/ingest/:id    — poll a job's progress (admin token)
 *   GET  /api/corpus/ingest        — list recent ingestion jobs (admin token)
 *   GET  /api/corpus/stats         — corpus + Qdrant collection stats (public)
 *
 * Auth: OPENCLAW_ADMIN_TOKEN via x-openclaw-admin-token header (or Clerk JWT).
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  startCorpusIngestion,
  getIngestionJob,
  listIngestionJobs,
  type CorpusSourceDoc,
} from "../lib/legalCorpus/corpusIngestion.js";
import {
  collectionInfo,
  LEGAL_CORPUS_COLLECTION,
} from "../lib/qdrantClient.js";

const router = Router();

function isAdminTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!envToken) return false;
  const headerToken = req.headers["x-openclaw-admin-token"] as string | undefined;
  return !!headerToken && headerToken === envToken;
}

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (isAdminTokenRequest(req)) { next(); return; }
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * POST /api/corpus/ingest
 * Body: { source: "cuad" | "texts", maxDocs?: number, texts?: CorpusSourceDoc[] }
 */
router.post("/ingest", requireAuth, async (req: Request, res: Response) => {
  const { source, maxDocs, texts } = (req.body ?? {}) as {
    source?: "cuad" | "texts";
    maxDocs?: number;
    texts?: CorpusSourceDoc[];
  };
  if (source !== "cuad" && source !== "texts") {
    res.status(400).json({ error: "source must be 'cuad' or 'texts'" });
    return;
  }
  if (source === "texts" && (!Array.isArray(texts) || !texts.length)) {
    res.status(400).json({ error: "texts[] required when source='texts'" });
    return;
  }
  try {
    const job = await startCorpusIngestion({ source, maxDocs, texts });
    logger.info({ jobId: job.id, source }, "[corpus] ingestion started");
    res.status(202).json(job);
  } catch (err) {
    logger.error({ err }, "[corpus] failed to start ingestion");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /api/corpus/ingest/:id — poll job progress */
router.get("/ingest/:id", requireAuth, (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const job = getIngestionJob(id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

/** GET /api/corpus/ingest — list recent jobs */
router.get("/ingest", requireAuth, (_req: Request, res: Response) => {
  res.json({ jobs: listIngestionJobs() });
});

/** GET /api/corpus/stats — corpus + Qdrant stats (public) */
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const docCount = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE source_type='cuad')::int AS cuad FROM legal_corpus_documents`,
    );
    const chunkCount = await pool.query(`SELECT count(*)::int AS n FROM legal_corpus_chunks`);
    const bySource = await pool.query(
      `SELECT source_type, count(*)::int AS n FROM legal_corpus_documents GROUP BY source_type ORDER BY n DESC`,
    );
    const qdrant = await collectionInfo(LEGAL_CORPUS_COLLECTION);
    res.json({
      documents: docCount.rows[0]?.n ?? 0,
      cuad_documents: docCount.rows[0]?.cuad ?? 0,
      chunks: chunkCount.rows[0]?.n ?? 0,
      by_source: bySource.rows,
      qdrant: qdrant
        ? { collection: LEGAL_CORPUS_COLLECTION, points: qdrant.points_count, dims: qdrant.dims, status: qdrant.status }
        : null,
    });
  } catch (err) {
    logger.error({ err }, "[corpus] stats failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
