/**
 * CUAD ingestion — real legal corpus.
 *
 * Ingests the Contract Understanding Atticus Dataset (CUAD v1): 510 real
 * commercial contracts with ~13,000 attorney-labeled clauses across 41 clause
 * types. This replaces the thin hand-written seed corpus with genuine contract
 * language so hybrid retrieval (BM25 + Qdrant) returns real provisions.
 *
 * Reuses the repo's own chunkLegalText / embedText / qdrantClient helpers so
 * behavior is identical to the boot-seed path. Idempotent via source_hash.
 *
 * Usage:
 *   CUAD_DIR=/path/to/CUAD_v1/CUAD_v1 \
 *   DATABASE_URL=postgres://... \
 *   QDRANT_URL=https://... QDRANT_API_KEY=... GOOGLE_API_KEY=... \
 *   node --experimental-strip-types src/scripts/ingestCuad.ts
 *
 * Options (env):
 *   CUAD_MAX_DOCS   — cap number of contracts to ingest (default: all 510)
 *   CUAD_DOMAIN     — domain tag (default: "contract")
 *   CUAD_DRY_RUN=1  — parse + count only, no DB/Qdrant writes
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { chunkLegalText } from "../lib/legalCorpus/chunkText.js";
import { embedText } from "../lib/legalCorpus/embeddings.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilter,
  collectionInfo,
  LEGAL_CORPUS_COLLECTION,
  LEGAL_EMBED_DIM,
  type QdrantPoint,
} from "../lib/qdrantClient.js";

const CUAD_DIR = process.env.CUAD_DIR ?? "";
const MAX_DOCS = process.env.CUAD_MAX_DOCS ? Number(process.env.CUAD_MAX_DOCS) : Infinity;
const DOMAIN = process.env.CUAD_DOMAIN ?? "contract";
const DRY_RUN = process.env.CUAD_DRY_RUN === "1";
const BATCH = 8; // concurrent embed batches (Gemini free-tier friendly)

if (!CUAD_DIR || !fs.existsSync(CUAD_DIR)) {
  console.error(`CUAD_DIR not set or missing: "${CUAD_DIR}"`);
  process.exit(1);
}

const TXT_DIR = path.join(CUAD_DIR, "full_contract_txt");
const CSV_PATH = path.join(CUAD_DIR, "master_clauses.csv");

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Parse master_clauses.csv → map filename → { documentName, parties, clauseTypes[] } */
function parseMasterCsv(csvPath: string): Map<string, { docName: string; clauseTypes: string[] }> {
  const map = new Map<string, { docName: string; clauseTypes: string[] }>();
  if (!fs.existsSync(csvPath)) return map;
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return map;
  const header = parseCsvLine(lines[0]);
  // Clause-type columns are those with a matching "<col>-Answer" column.
  const answerCols = new Set(header.filter((h) => /- ?Answer$/i.test(h)).map((h) => h.replace(/- ?Answer$/i, "").trim()));
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols.length) continue;
    const filename = cols[0];
    const docName = (cols[1] ?? "").replace(/^\['|'\]$/g, "").replace(/','/g, ", ").trim() || filename;
    const clauseTypes: string[] = [];
    for (let c = 0; c < header.length; c++) {
      const col = header[c];
      if (/- ?Answer$/i.test(col)) continue;
      if (!answerCols.has(col.trim())) continue;
      const val = (cols[c] ?? "").trim();
      // Non-empty, non-"None" answer means this clause type is present.
      if (val && val !== "[]" && val.toLowerCase() !== "none" && val !== "['None']") {
        clauseTypes.push(col.trim());
      }
    }
    map.set(filename, { docName, clauseTypes });
  }
  return map;
}

/** Minimal CSV line parser handling quoted fields with embedded commas/quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
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

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
}

async function main(): Promise<void> {
  const meta = parseMasterCsv(CSV_PATH);
  const txtFiles = fs.readdirSync(TXT_DIR).filter((f) => f.endsWith(".txt")).sort();
  const files = txtFiles.slice(0, MAX_DOCS === Infinity ? undefined : MAX_DOCS);
  console.log(`[cuad] ${txtFiles.length} contracts found; ingesting ${files.length}; dry_run=${DRY_RUN}`);

  if (!DRY_RUN) {
    await ensureCollection(LEGAL_CORPUS_COLLECTION, LEGAL_EMBED_DIM);
    const info = await collectionInfo(LEGAL_CORPUS_COLLECTION);
    console.log(`[cuad] Qdrant collection "${LEGAL_CORPUS_COLLECTION}" current points: ${info?.points_count ?? "?"}`);
  }

  let docsIngested = 0;
  let chunksIngested = 0;
  let embedFailures = 0;
  let skipped = 0;

  for (const txtFile of files) {
    const pdfName = txtFile.replace(/\.txt$/, ".pdf");
    const content = fs.readFileSync(path.join(TXT_DIR, txtFile), "utf-8").trim();
    if (content.length < 200) { skipped++; continue; }

    const m = meta.get(pdfName) ?? meta.get(txtFile);
    const title = m?.docName || txtFile.replace(/\.txt$/, "").replace(/_/g, " ");
    const clauseTypes = m?.clauseTypes ?? [];
    const sourceHash = sha256(content);
    const slug = "cuad-" + slugify(txtFile.replace(/\.txt$/, ""));

    const chunks = chunkLegalText(content);
    if (!chunks.length) { skipped++; continue; }

    if (DRY_RUN) {
      docsIngested++;
      chunksIngested += chunks.length;
      if (docsIngested % 50 === 0) console.log(`[cuad][dry] ${docsIngested} docs, ${chunksIngested} chunks`);
      continue;
    }

    const client = await pool.connect();
    let documentId: number;
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO legal_corpus_documents
           (slug, title, citation, domain, tags, priority, corpus_version, content, source_type, source_url, source_hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cuad',$9,$10, now())
         ON CONFLICT (source_hash) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          slug,
          title,
          "CUAD v1 (Atticus Project)",
          DOMAIN,
          clauseTypes.slice(0, 20),
          "normal",
          "legal-corpus-cuad-v1",
          content,
          "https://zenodo.org/records/4595826",
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
      console.error(`[cuad] DB error on ${txtFile}:`, (err as Error).message);
      client.release();
      continue;
    }
    client.release();

    // Embed + upsert to Qdrant in small batches.
    await deleteByFilter(LEGAL_CORPUS_COLLECTION, { must: [{ key: "document_id", match: { value: documentId } }] });
    const points: QdrantPoint[] = [];
    for (let b = 0; b < chunks.length; b += BATCH) {
      const batch = chunks.slice(b, b + BATCH);
      const vecs = await Promise.all(batch.map((c) => embedText(c)));
      for (let k = 0; k < batch.length; k++) {
        const vec = vecs[k];
        const idx = b + k;
        if (!vec) { embedFailures++; continue; }
        points.push({
          id: documentId * 10000 + idx,
          vector: vec,
          payload: {
            document_id: documentId,
            chunk_id: idx,
            chunk_index: idx,
            slug,
            title,
            citation: "CUAD v1 (Atticus Project)",
            domain: DOMAIN,
            priority: "normal",
            content: batch[k],
          },
        });
      }
    }
    if (points.length) {
      const up = await upsertPoints(LEGAL_CORPUS_COLLECTION, points);
      if (!up) console.error(`[cuad] Qdrant upsert failed for doc ${documentId}`);
    }
    docsIngested++;
    chunksIngested += chunks.length;
    if (docsIngested % 10 === 0) {
      console.log(`[cuad] ${docsIngested}/${files.length} docs, ${chunksIngested} chunks, ${embedFailures} embed failures`);
    }
  }

  if (!DRY_RUN) {
    const info = await collectionInfo(LEGAL_CORPUS_COLLECTION);
    console.log(`[cuad] DONE. docs=${docsIngested} chunks=${chunksIngested} embed_failures=${embedFailures} skipped=${skipped}`);
    console.log(`[cuad] Qdrant collection now: ${info?.points_count ?? "?"} points`);
  } else {
    console.log(`[cuad][dry] DONE. docs=${docsIngested} chunks=${chunksIngested} skipped=${skipped}`);
  }
  // Shared pool from @workspace/db — do not end() here (owned by the process).
}

main().catch((e) => { console.error(e); process.exit(1); });
