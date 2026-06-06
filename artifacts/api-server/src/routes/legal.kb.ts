/**
 * legal.kb.ts — Legal counsel knowledge base (hybrid RAG)
 *
 * GET  /api/v1/legal/kb/status
 * POST /api/v1/legal/kb/search
 * POST /api/v1/legal/kb/ingest
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { legalCorpusHybridRetrieve } from "../lib/legalCorpus/hybridRetrieve.js";
import { legalCorpusStatus } from "../lib/legalCorpus/retrieve.js";
import { ingestLegalDocument } from "../lib/legalCorpus/ingest.js";

const router = Router();

const SearchSchema = z.object({
  query: z.string().min(3),
  domains: z
    .array(z.enum(["cofounder", "contract", "tax", "delaware", "regulatory"]))
    .optional(),
  limit: z.number().int().min(1).max(20).optional().default(8),
  max_chars: z.number().int().min(500).max(12000).optional().default(8000),
});

const IngestSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  title: z.string().min(3),
  citation: z.string().optional(),
  domain: z.enum(["cofounder", "contract", "tax", "delaware", "regulatory"]),
  tags: z.array(z.string()).optional(),
  priority: z.enum(["critical", "normal"]).optional(),
  content: z.string().min(100),
});

router.get("/v1/legal/kb/status", async (_req: Request, res: Response): Promise<void> => {
  const status = await legalCorpusStatus();
  res.json({ ok: true, ...status, hybrid: true });
});

router.post("/v1/legal/kb/search", async (req: Request, res: Response): Promise<void> => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { query, domains, limit, max_chars } = parsed.data;
  const result = await legalCorpusHybridRetrieve({
    query,
    domains,
    topK: limit,
    maxChars: max_chars,
    forceCofounderCritical: domains?.includes("cofounder") ?? false,
  });

  res.json({
    ok: true,
    corpus_version: result.corpus_version,
    retrieval_mode: result.retrieval_mode,
    truncated: result.truncated,
    hits: result.hits.map((h) => ({
      slug: h.slug,
      title: h.title,
      citation: h.citation,
      domain: h.domain,
      rank: h.rank,
      excerpt: h.content.slice(0, 400),
    })),
    context_block: result.context_block,
  });
});

router.post("/v1/legal/kb/ingest", async (req: Request, res: Response): Promise<void> => {
  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const doc = await ingestLegalDocument(parsed.data);
  res.status(201).json({ ok: true, ...doc });
});

export default router;
