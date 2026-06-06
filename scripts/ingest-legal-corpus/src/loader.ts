/**
 * loader.ts — Load raw text from file or HTTP fetch.
 */

import { readFileSync, existsSync } from "node:fs";

/**
 * Load manifest entry text content.
 * For `file` strategy, reads from local filesystem.
 * For `fetch` strategy, performs HTTP GET (not yet implemented).
 */
export function loadManifestText(
  filePath: string,
  fetchStrategy: string,
): string | null {
  if (fetchStrategy === "file") {
    if (!existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      return null;
    }
    return readFileSync(filePath, "utf-8").trim();
  }

  if (fetchStrategy === "fetch") {
    // Future: HTTP fetch from source_url
    console.warn(`Fetch strategy not yet implemented for ${filePath}`);
    return null;
  }

  console.warn(`Unknown fetch strategy: ${fetchStrategy}`);
  return null;
}
