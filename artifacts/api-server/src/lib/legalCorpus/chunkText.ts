const CHUNK_WORDS = 280;
const CHUNK_OVERLAP = 40;

export function chunkLegalText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + CHUNK_WORDS).join(" "));
    i += CHUNK_WORDS - CHUNK_OVERLAP;
    if (i >= words.length) break;
  }
  return chunks.filter((c) => c.trim().length > 40);
}
