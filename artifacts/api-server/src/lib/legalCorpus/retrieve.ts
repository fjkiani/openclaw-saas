import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { LEGAL_CORPUS_VERSION } from "./documents.js";

export interface LegalCorpusHit {
  chunk_id: number;
  document_id: number;
  slug: string;
  title: string;
  citation: string;
  domain: string;
  priority: string;
  rank: number;
  content: string;
}

export interface LegalCorpusRetrieveResult {
  hits: LegalCorpusHit[];
  context_block: string;
  corpus_version: string;
  truncated: boolean;
}

const COFOUNDER_FORCE_SLUGS = [
  "qsbs-post-obbba",
  "dgcl-144-safe-harbor",
  "irc-83b-election",
  "cofounder-ip-assignment-carveout",
  "cofounder-ruo-fda-scope",
];

function buildContextBlock(hits: LegalCorpusHit[], maxChars: number): { block: string; truncated: boolean } {
  const parts: string[] = [];
  let len = 0;
  let truncated = false;

  for (const h of hits) {
    const section =
      `[${h.slug}] ${h.title}\n` +
      `Citation: ${h.citation}\n` +
      `Domain: ${h.domain} | rank: ${h.rank.toFixed(3)}\n` +
      `${h.content}\n`;
    if (len + section.length > maxChars) {
      truncated = true;
      const remaining = maxChars - len - 20;
      if (remaining > 200) {
        parts.push(section.slice(0, remaining) + "\n...[truncated]");
      }
      break;
    }
    parts.push(section);
    len += section.length;
  }

  return { block: parts.join("\n---\n"), truncated };
}

function extractSearchTerms(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s§()./-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return [...new Set(words)].slice(0, 24).join(" ");
}

export async function legalCorpusRetrieve(params: {
  query: string;
  domains?: string[];
  topK?: number;
  maxChars?: number;
  forceCofounderCritical?: boolean;
}): Promise<LegalCorpusRetrieveResult> {
  const {
    query,
    domains,
    topK = 8,
    maxChars = 8000,
    forceCofounderCritical = false,
  } = params;

  const searchTerms = extractSearchTerms(query);
  const hits: LegalCorpusHit[] = [];
  const seenChunkIds = new Set<number>();

  const pushRows = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      const chunkId = Number(r.chunk_id);
      if (seenChunkIds.has(chunkId)) continue;
      seenChunkIds.add(chunkId);
      hits.push({
        chunk_id: chunkId,
        document_id: Number(r.document_id),
        slug: String(r.slug),
        title: String(r.title),
        citation: String(r.citation ?? ""),
        domain: String(r.domain),
        priority: String(r.priority),
        rank: Number(r.rank ?? 0),
        content: String(r.content),
      });
    }
  };

  try {
    if (forceCofounderCritical) {
      const forced = await pool.query(
        `SELECT c.id AS chunk_id, c.document_id, d.slug, d.title, d.citation, d.domain, d.priority,
                1.0::float8 AS rank, c.content
         FROM legal_corpus_chunks c
         JOIN legal_corpus_documents d ON d.id = c.document_id
         WHERE d.slug = ANY($1::text[])
         ORDER BY array_position($1::text[], d.slug), c.chunk_index`,
        [COFOUNDER_FORCE_SLUGS],
      );
      pushRows(forced.rows);
    }

    if (searchTerms.length >= 3) {
      const domainFilter =
        domains && domains.length > 0
          ? `AND d.domain = ANY($3::text[])`
          : "";
      const args: unknown[] = [searchTerms, topK];
      if (domains && domains.length > 0) args.push(domains);

      const ranked = await pool.query(
        `SELECT c.id AS chunk_id, c.document_id, d.slug, d.title, d.citation, d.domain, d.priority,
                ts_rank(c.tsv, plainto_tsquery('english', $1)) AS rank, c.content
         FROM legal_corpus_chunks c
         JOIN legal_corpus_documents d ON d.id = c.document_id
         WHERE c.tsv @@ plainto_tsquery('english', $1)
           ${domainFilter}
         ORDER BY rank DESC, d.priority DESC
         LIMIT $2`,
        args,
      );
      pushRows(ranked.rows);
    }

    if (hits.length === 0) {
      const fallback = await pool.query(
        `SELECT c.id AS chunk_id, c.document_id, d.slug, d.title, d.citation, d.domain, d.priority,
                0.1::float8 AS rank, c.content
         FROM legal_corpus_chunks c
         JOIN legal_corpus_documents d ON d.id = c.document_id
         WHERE d.priority = 'critical'
         ORDER BY d.slug, c.chunk_index
         LIMIT $1`,
        [Math.min(topK, 6)],
      );
      pushRows(fallback.rows);
    }
  } catch (err: unknown) {
    logger.warn({ err }, "legalCorpusRetrieve: DB search failed — empty context");
    return {
      hits: [],
      context_block: "",
      corpus_version: LEGAL_CORPUS_VERSION,
      truncated: false,
    };
  }

  const sorted = hits
    .sort((a, b) => {
      if (a.priority === "critical" && b.priority !== "critical") return -1;
      if (b.priority === "critical" && a.priority !== "critical") return 1;
      return b.rank - a.rank;
    })
    .slice(0, topK);

  const { block, truncated } = buildContextBlock(sorted, maxChars);

  return {
    hits: sorted,
    context_block: block,
    corpus_version: LEGAL_CORPUS_VERSION,
    truncated,
  };
}

export interface LegalCorpusStatusResult {
  corpus_version: string;
  documents: number;
  chunks: number;
  by_source: Record<string, number>;
  embedded_pct: number;
}

export async function legalCorpusStatus(): Promise<LegalCorpusStatusResult> {
  try {
    const docs = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM legal_corpus_documents`);
    const chunks = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM legal_corpus_chunks`);

    // ── by_source breakdown ────────────────────────────────────────────────
    const sourceRows = await pool.query<{ source_type: string; n: string }>(
      `SELECT source_type, COUNT(*) AS n FROM legal_corpus_documents GROUP BY source_type`,
    );
    const by_source: Record<string, number> = {};
    for (const r of sourceRows.rows) {
      by_source[r.source_type] = parseInt(r.n, 10);
    }

    // ── embedding coverage ─────────────────────────────────────────────────
    const totalChunks = parseInt(chunks.rows[0]?.n ?? "0", 10);
    const embeddedRows = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM legal_corpus_chunks WHERE embedding_vec IS NOT NULL`,
    );
    const embeddedChunks = parseInt(embeddedRows.rows[0]?.n ?? "0", 10);
    const embedded_pct = totalChunks > 0 ? embeddedChunks / totalChunks : 0;

    return {
      corpus_version: LEGAL_CORPUS_VERSION,
      documents: parseInt(docs.rows[0]?.n ?? "0", 10),
      chunks: totalChunks,
      by_source,
      embedded_pct: Math.round(embedded_pct * 1000) / 1000, // 3 decimal places
    };
  } catch {
    return {
      corpus_version: LEGAL_CORPUS_VERSION,
      documents: 0,
      chunks: 0,
      by_source: {},
      embedded_pct: 0,
    };
  }
}
