import { pool } from "@workspace/db";
import { chunkLegalText } from "../legalCorpus/chunkText.js";
import { embedText } from "../legalCorpus/embeddings.js";
import { LEGAL_CORPUS_VERSION } from "../legalCorpus/documents.js";

export async function ingestLegalDocument(params: {
  slug: string;
  title: string;
  citation?: string;
  domain: string;
  tags?: string[];
  priority?: "critical" | "normal";
  content: string;
}): Promise<{ slug: string; document_id: number; chunks: number }> {
  const { slug, title, citation, domain, tags = [], priority = "normal", content } = params;

  const upsert = await pool.query<{ id: number }>(
    `INSERT INTO legal_corpus_documents
       (slug, title, citation, domain, tags, priority, corpus_version, content, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       citation = EXCLUDED.citation,
       domain = EXCLUDED.domain,
       tags = EXCLUDED.tags,
       priority = EXCLUDED.priority,
       content = EXCLUDED.content,
       updated_at = now()
     RETURNING id`,
    [slug, title, citation ?? null, domain, tags, priority, LEGAL_CORPUS_VERSION, content],
  );

  const documentId = upsert.rows[0].id;
  await pool.query(`DELETE FROM legal_corpus_chunks WHERE document_id = $1`, [documentId]);

  const chunks = chunkLegalText(content);
  for (let i = 0; i < chunks.length; i++) {
    const vec = await embedText(chunks[i]);
    await pool.query(
      `INSERT INTO legal_corpus_chunks (document_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4)`,
      [documentId, i, chunks[i], vec ? vec : null],
    );
  }

  return { slug, document_id: documentId, chunks: chunks.length };
}
