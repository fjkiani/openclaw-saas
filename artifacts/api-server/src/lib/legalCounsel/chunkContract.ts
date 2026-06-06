/** Split contract text into retrievable sections for per-section RAG queries. */

export interface ContractSection {
  id: string;
  heading: string;
  text: string;
}

export function chunkContractSections(fullText: string, maxSectionChars = 3500): ContractSection[] {
  const lines = fullText.split(/\n/);
  const sections: ContractSection[] = [];
  let currentHeading = "preamble";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length < 40) {
      buffer = [];
      return;
    }
    const id = currentHeading.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    if (text.length <= maxSectionChars) {
      sections.push({ id, heading: currentHeading, text });
    } else {
      for (let i = 0; i < text.length; i += maxSectionChars) {
        sections.push({
          id: `${id}-${Math.floor(i / maxSectionChars)}`,
          heading: currentHeading,
          text: text.slice(i, i + maxSectionChars),
        });
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    const h1 = line.match(/^(\d+\.)\s+(.+)/);
    const h2 = line.match(/^(Schedule [A-Z0-9-]+)/i);
    if (h1 || h2) {
      flush();
      currentHeading = (h1?.[2] ?? h2?.[1] ?? line).trim();
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0) {
    return [{ id: "full", heading: "full agreement", text: fullText.slice(0, 12000) }];
  }
  return sections;
}
