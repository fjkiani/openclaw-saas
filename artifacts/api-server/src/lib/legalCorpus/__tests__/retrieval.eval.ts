/**
 * retrieval.eval.ts — Legal corpus retrieval evaluation tests.
 *
 * Tests corpus health gates and retrieval quality.
 * Requires a running database with ingested corpus data.
 *
 * Run: cd artifacts/api-server && pnpm test legalCorpus
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { legalCorpusStatus } from "../retrieve.js";
import { legalCorpusHybridRetrieve } from "../hybridRetrieve.js";
import { rrfMerge, buildContextBlock, type RRFItem } from "../rrfMerge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

// ── Gate thresholds ─────────────────────────────────────────────────────────
const GATE_DOCUMENTS_MIN = 40;
const GATE_CHUNKS_MIN = 200;
const GATE_SOURCE_TYPES_MIN = 3;
const GATE_EMBEDDED_PCT_MIN = 0.8;
const GATE_RECALL_AT_5_MIN = 8;

describe("Legal Corpus — Health Gates", () => {
  it("G1: document count ≥ 40", async () => {
    const status = await legalCorpusStatus();
    expect(status.documents).toBeGreaterThanOrEqual(GATE_DOCUMENTS_MIN);
  });

  it("G2: chunk count ≥ 200", async () => {
    const status = await legalCorpusStatus();
    expect(status.chunks).toBeGreaterThanOrEqual(GATE_CHUNKS_MIN);
  });

  it("G3: at least 3 distinct source_type values", async () => {
    const status = await legalCorpusStatus();
    const sourceTypes = Object.keys(status.by_source);
    expect(sourceTypes.length).toBeGreaterThanOrEqual(GATE_SOURCE_TYPES_MIN);
  });

  it("G4: by_source includes statute ≥ 3", async () => {
    const status = await legalCorpusStatus();
    expect(status.by_source.statute ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("G5: by_source includes cuad ≥ 50", async () => {
    const status = await legalCorpusStatus();
    expect(status.by_source.cuad ?? 0).toBeGreaterThanOrEqual(50);
  });

  it("G6: embedding coverage ≥ 80%", async () => {
    const status = await legalCorpusStatus();
    expect(status.embedded_pct).toBeGreaterThanOrEqual(GATE_EMBEDDED_PCT_MIN);
  });
});

describe("Legal Corpus — Retrieval Quality", () => {
  const requiredSlugs = JSON.parse(
    readFileSync(resolve(FIXTURES, "crispro-required-slugs.json"), "utf-8"),
  );

  it("G7: recall@5 ≥ 8/10 required slugs for CrisPro query", async () => {
    const result = await legalCorpusHybridRetrieve({
      query: requiredSlugs.query,
      topK: 5,
      maxChars: 12000,
    });

    // Collect unique slugs from top-5 results
    const topSlugs = new Set(result.hits.map((h) => h.slug));
    const matched = requiredSlugs.required_slugs.filter((s: string) => topSlugs.has(s));

    console.log(`  Recall@5: ${matched.length}/${requiredSlugs.required_slugs.length} required slugs found`);
    console.log(`  Matched: ${matched.join(", ")}`);
    console.log(`  Missing: ${requiredSlugs.required_slugs.filter((s: string) => !topSlugs.has(s)).join(", ")}`);

    expect(matched.length).toBeGreaterThanOrEqual(GATE_RECALL_AT_5_MIN);
  });

  it("G8: hybrid retrieval returns results (not empty)", async () => {
    const result = await legalCorpusHybridRetrieve({
      query: "Delaware corporation interested director transaction safe harbor",
      topK: 5,
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.retrieval_mode).toMatch(/^(hybrid|bm25_only)$/);
  });
});

describe("RRF Merge — Unit Tests", () => {
  const makeItem = (id: number, slug: string, priority = "normal"): RRFItem => ({
    chunk_id: id,
    document_id: Math.floor(id / 10),
    slug,
    title: `Test ${slug}`,
    citation: "",
    domain: "contract",
    priority,
    content: `Content for ${slug}`,
  });

  it("merges BM25 + semantic with correct RRF scoring", () => {
    const bm25 = [makeItem(1, "a"), makeItem(2, "b"), makeItem(3, "c")];
    const semantic = [makeItem(3, "c"), makeItem(1, "a"), makeItem(4, "d")];

    const result = rrfMerge(bm25, semantic);

    // Item 3 (rank 3 in BM25, rank 1 in semantic) should score highest
    // Item 1 (rank 1 in BM25, rank 2 in semantic) should also score high
    expect(result.length).toBe(4); // 4 unique items
    expect(result[0].chunk_id).toBe(1); // rank 1 BM25 + rank 2 semantic = highest RRF
  });

  it("critical priority overrides RRF score", () => {
    const bm25 = [makeItem(1, "normal-doc")];
    const semantic = [makeItem(2, "critical-doc", "critical")];

    const result = rrfMerge(bm25, semantic);

    expect(result[0].slug).toBe("critical-doc");
  });

  it("empty inputs return empty result", () => {
    const result = rrfMerge([], []);
    expect(result).toEqual([]);
  });

  it("buildContextBlock respects maxChars", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...makeItem(i + 1, `doc-${i}`),
      rrf_score: 0.5 - i * 0.01,
    }));

    const { block, truncated } = buildContextBlock(items, 500);
    expect(block.length).toBeLessThanOrEqual(520); // small margin for truncation marker
    expect(truncated).toBe(true);
  });
});

describe("Legal Corpus — Schema Integrity", () => {
  it("source_hash unique index exists", async () => {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'legal_corpus_documents_source_hash_idx'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("embedding_vec column exists on chunks table", async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'legal_corpus_chunks' AND column_name = 'embedding_vec'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("HNSW index exists on embedding_vec", async () => {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'legal_corpus_chunks_embedding_vec_idx'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
