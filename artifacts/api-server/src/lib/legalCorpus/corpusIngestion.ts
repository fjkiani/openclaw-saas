/**
 * corpusIngestion.ts — real legal corpus ingestion capability.
 *
 * Ingests genuine legal corpora into Postgres (BM25 + metadata) and Qdrant
 * (semantic vectors) so hybrid retrieval returns real contract/statute language
 * instead of a thin hand-written seed set.
 *
 * Sources supported:
 *   - "cuad"   : Contract Understanding Atticus Dataset v1 (510 commercial
 *                contracts, ~13k attorney-labeled clauses, 41 clause types),
 *                fetched from Zenodo at runtime.
 *   - "texts"  : caller-supplied array of { title, content, citation?, domain?, tags? }
 *                for ad-hoc corpus building (a user building their own domain corpus).
 *
 * Runs as a tracked background job with progress the front-end can poll.
 * Idempotent via source_hash (re-ingesting the same content updates, not duplicates).
 */

import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { chunkLegalText } from "./chunkText.js";
import { embedTextWithRetry } from "./embeddings.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilter,
  collectionInfo,
  LEGAL_CORPUS_COLLECTION,
  LEGAL_EMBED_DIM,
  type QdrantPoint,
} from "../qdrantClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// Job tracking (in-memory; single-process API)
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestionJob {
  id: string;
  source: string;
  status: "queued" | "running" | "done" | "error";
  docs_total: number;
  docs_ingested: number;
  chunks_ingested: number;
  embed_failures: number;
  skipped: number;
  error?: string;
  last_error?: string;
  started_at: string;
  finished_at?: string;
  qdrant_points?: number;
}

const jobs = new Map<string, IngestionJob>();

export function getIngestionJob(id: string): IngestionJob | undefined {
  return jobs.get(id);
}

export function listIngestionJobs(): IngestionJob[] {
  return [...jobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 25);
}

// ─────────────────────────────────────────────────────────────────────────────
// Source documents
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusSourceDoc {
  title: string;
  content: string;
  citation?: string;
  domain?: string;
  tags?: string[];
  sourceUrl?: string;
}

const CUAD_ZENODO_URL = "https://zenodo.org/records/4595826/files/CUAD_v1.zip";

/** Fetch CUAD from Zenodo, extract txt contracts + clause metadata. */
async function fetchCuadDocs(maxDocs: number): Promise<CorpusSourceDoc[]> {
  const { default: AdmZip } = await import("adm-zip");
  logger.info({ url: CUAD_ZENODO_URL }, "corpusIngestion: downloading CUAD from Zenodo");
  const res = await fetch(CUAD_ZENODO_URL, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`CUAD download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();

  // Parse master_clauses.csv for titles + clause-type tags.
  const csvEntry = entries.find((e) => e.entryName.endsWith("master_clauses.csv"));
  const meta = new Map<string, { docName: string; clauseTypes: string[] }>();
  if (csvEntry) {
    const raw = csvEntry.getData().toString("utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 2) {
      const header = parseCsvLine(lines[0]);
      const answerCols = new Set(
        header.filter((h) => /- ?Answer$/i.test(h)).map((h) => h.replace(/- ?Answer$/i, "").trim()),
      );
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        if (!cols.length) continue;
        const filename = cols[0];
        const docName =
          (cols[1] ?? "").replace(/^\['|'\]$/g, "").replace(/','/g, ", ").trim() || filename;
        const clauseTypes: string[] = [];
        for (let c = 0; c < header.length; c++) {
          const col = header[c];
          if (/- ?Answer$/i.test(col) || !answerCols.has(col.trim())) continue;
          const val = (cols[c] ?? "").trim();
          if (val && val !== "[]" && val.toLowerCase() !== "none" && val !== "['None']") {
            clauseTypes.push(col.trim());
          }
        }
        meta.set(filename, { docName, clauseTypes });
      }
    }
  }

  // Extract txt contracts.
  const txtEntries = entries
    .filter((e) => /full_contract_txt\/[^/]+\.txt$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName))
    .slice(0, maxDocs);

  const docs: CorpusSourceDoc[] = [];
  for (const e of txtEntries) {
    const content = e.getData().toString("utf-8").trim();
    if (content.length < 200) continue;
    const base = e.entryName.split("/").pop() ?? e.entryName;
    const pdfName = base.replace(/\.txt$/, ".pdf");
    const m = meta.get(pdfName) ?? meta.get(base);
    docs.push({
      title: m?.docName || base.replace(/\.txt$/, "").replace(/_/g, " "),
      content,
      citation: "CUAD v1 (Atticus Project)",
      domain: "contract",
      tags: (m?.clauseTypes ?? []).slice(0, 20),
      sourceUrl: "https://zenodo.org/records/4595826",
    });
  }
  return docs;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion core
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_BATCH = 8;

async function ingestOneDoc(
  doc: CorpusSourceDoc,
  sourceType: string,
  corpusVersion: string,
  job: IngestionJob,
): Promise<void> {
  const content = doc.content.trim();
  if (content.length < 200) { job.skipped++; return; }
  const chunks = chunkLegalText(content);
  if (!chunks.length) { job.skipped++; return; }

  const sourceHash = sha256(content);
  const slug = `${sourceType}-` + slugify(doc.title) + "-" + sourceHash.slice(0, 8);
  const domain = doc.domain ?? "contract";

  // Idempotency: identical content already ingested (same source_hash) → skip.
  // The partial unique index on source_hash rejects duplicate content, so check
  // first and treat re-ingestion of identical content as a no-op rather than an error.
  const existing = await pool.query(
    `SELECT id FROM legal_corpus_documents WHERE source_hash = $1 LIMIT 1`,
    [sourceHash],
  );
  if (existing.rows.length > 0) { job.skipped++; return; }

  const client = await pool.connect();
  let documentId: number;
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO legal_corpus_documents
         (slug, title, citation, domain, tags, priority, corpus_version, content, source_type, source_url, source_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (slug) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        slug,
        doc.title,
        doc.citation ?? null,
        domain,
        doc.tags ?? [],
        "normal",
        corpusVersion,
        content,
        sourceType,
        doc.sourceUrl ?? null,
        sourceHash,
      ],
    );
    documentId = ins.rows[0].id as number;
    await client.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content) VALUES ($1,$2,$3)
         ON CONFLICT (document_id, chunk_index) DO UPDATE SET content = EXCLUDED.content`,
        [documentId, i, chunks[i]],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  }
  client.release();

  // Embed + upsert to Qdrant.
  await deleteByFilter(LEGAL_CORPUS_COLLECTION, {
    must: [{ key: "document_id", match: { value: documentId } }],
  });
  const points: QdrantPoint[] = [];
  for (let b = 0; b < chunks.length; b += EMBED_BATCH) {
    const batch = chunks.slice(b, b + EMBED_BATCH);
    const vecs = await Promise.all(batch.map((c) => embedTextWithRetry(c)));
    for (let k = 0; k < batch.length; k++) {
      const vec = vecs[k];
      const idx = b + k;
      if (!vec) { job.embed_failures++; continue; }
      points.push({
        id: documentId * 10000 + idx,
        vector: vec,
        payload: {
          document_id: documentId,
          chunk_id: idx,
          chunk_index: idx,
          slug,
          title: doc.title,
          citation: doc.citation ?? null,
          domain,
          priority: "normal",
          content: batch[k],
        },
      });
    }
  }
  if (points.length) await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
  job.docs_ingested++;
  job.chunks_ingested += chunks.length;
}

/**
 * Start a corpus ingestion job. Returns immediately; runs in background.
 */
export async function startCorpusIngestion(opts: {
  source: "cuad" | "texts";
  texts?: CorpusSourceDoc[];
  maxDocs?: number;
}): Promise<IngestionJob> {
  const id = "ingest-" + crypto.randomBytes(6).toString("hex");
  const job: IngestionJob = {
    id,
    source: opts.source,
    status: "queued",
    docs_total: 0,
    docs_ingested: 0,
    chunks_ingested: 0,
    embed_failures: 0,
    skipped: 0,
    started_at: new Date().toISOString(),
  };
  jobs.set(id, job);

  // Run async (do not await).
  void (async () => {
    job.status = "running";
    try {
      await ensureCollection(LEGAL_CORPUS_COLLECTION, LEGAL_EMBED_DIM);
      let docs: CorpusSourceDoc[];
      if (opts.source === "cuad") {
        docs = await fetchCuadDocs(opts.maxDocs ?? 510);
      } else {
        docs = (opts.texts ?? []).filter((t) => t.content && t.title);
      }
      job.docs_total = docs.length;
      const corpusVersion = opts.source === "cuad" ? "legal-corpus-cuad-v1" : `legal-corpus-custom-${Date.now()}`;
      for (const doc of docs) {
        try {
          await ingestOneDoc(doc, opts.source, corpusVersion, job);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, title: doc.title }, "corpusIngestion: doc failed");
          job.embed_failures++;
          job.last_error = `${doc.title}: ${msg}`;
        }
      }
      const info = await collectionInfo(LEGAL_CORPUS_COLLECTION);
      job.qdrant_points = info?.points_count;
      job.status = "done";
      job.finished_at = new Date().toISOString();
      logger.info({ job }, "corpusIngestion: done");
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finished_at = new Date().toISOString();
      logger.error({ err, job }, "corpusIngestion: failed");
    }
  })();

  return job;
}
