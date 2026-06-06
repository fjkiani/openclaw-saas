/**
 * Embed backfill — update existing chunks without re-ingesting documents.
 *
 * Usage:
 *   DATABASE_URL=... OPENROUTER_API_KEY=... npx tsx src/embedBackfill.ts [--delay 400]
 */

import pg from "pg";

const EMBED_MODEL =
  process.env.LEGAL_EMBED_MODEL ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free";

async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const input = text.slice(0, 8192);
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://openclaw-api-k30t.onrender.com",
      "X-Title": "OpenClaw Legal RAG Embed Backfill",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    console.warn(`Embed API error: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  return data.data?.[0]?.embedding ?? null;
}

async function main() {
  const delayMs = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--delay") ?? "400", 10);
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: dbUrl, max: 3, ssl: { rejectUnauthorized: false } });

  let updated = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: number; content: string }>(
      `SELECT id, content FROM legal_corpus_chunks
       WHERE embedding IS NULL OR embedding_vec IS NULL
       ORDER BY id
       LIMIT 25`,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const vec = await embedText(row.content);
      if (!vec) {
        console.error(`Stopped at chunk ${row.id} — embed failed`);
        await pool.end();
        process.exit(1);
      }

      await pool.query(
        `UPDATE legal_corpus_chunks
         SET embedding = $1::real[], embedding_vec = $2::vector
         WHERE id = $3`,
        [vec, `[${vec.join(",")}]`, row.id],
      );
      updated++;
      console.log(`embedded chunk ${row.id} (${updated} total)`);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const { rows: stats } = await pool.query<{ total: string; with_vec: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE embedding_vec IS NOT NULL)::text AS with_vec
     FROM legal_corpus_chunks`,
  );
  const total = parseInt(stats[0]?.total ?? "0", 10);
  const withVec = parseInt(stats[0]?.with_vec ?? "0", 10);
  console.log(`\nDone: ${updated} updated, ${withVec}/${total} have embedding_vec (${((withVec / total) * 100).toFixed(1)}%)`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
