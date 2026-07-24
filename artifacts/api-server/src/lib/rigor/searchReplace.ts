/**
 * searchReplace.ts — TypeScript port of Aider's SEARCH/REPLACE edit protocol.
 *
 * Why (materiality forcing): a model that *claims* a fix must express it as an
 * edit that ACTUALLY APPLIES to the current file. Aider's format requires the
 * SEARCH half to match the file exactly; a non-matching block is rejected with
 * a `SearchReplaceNoExactMatch`-style message instead of silently "fixing"
 * prose. We port the parser + exact-match applier + failure feedback (not the
 * Aider CLI, which is Python and coupled to its own repo/model loop).
 *
 * Block grammar (fence markers, Aider-compatible):
 *   <path/to/file.ts>            (optional filename line immediately before)
 *   <<<<<<< SEARCH
 *   ...exact existing lines...
 *   =======
 *   ...replacement lines...
 *   >>>>>>> REPLACE
 *
 * Pure + deterministic. No I/O, no LLM. Unit-testable in isolation.
 */

export interface ParsedEditBlock {
  /** Target filename if one preceded the block, else "" (applies to default). */
  filename: string;
  search: string;
  replace: string;
  /** Raw text of the whole block, for error echoes. */
  raw: string;
}

export interface EditApplication {
  filename: string;
  applied: boolean;
  reason?: string;
  /** Present when applied — the new file content after this block. */
  updated?: string;
}

export interface ApplyResult {
  ok: boolean;
  /** Per-block application results, in order. */
  applications: EditApplication[];
  /** Final virtual FS after all applicable blocks (filename -> content). */
  files: Record<string, string>;
  /** SEARCH blocks that did not match, with feedback (empty when ok). */
  failures: string[];
}

const HEAD = /^<{5,9} SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;

/**
 * Parse zero or more SEARCH/REPLACE blocks out of raw model text.
 * Tolerates surrounding prose and code fences. A filename is captured if the
 * non-empty line directly above `<<<<<<< SEARCH` looks like a path (and is not
 * itself a fence or prose sentence).
 */
export function parseEditBlocks(text: string): ParsedEditBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ParsedEditBlock[] = [];
  let i = 0;

  const looksLikeFilename = (s: string): boolean => {
    const t = s.trim().replace(/^```[\w.\-/]*$/, "").trim();
    if (!t) return false;
    if (t.startsWith("```")) return false;
    if (/\s{2,}/.test(t)) return false;
    if (t.split(/\s+/).length > 3) return false;
    // has an extension or a path separator, no trailing punctuation
    return (/[./\\]/.test(t)) && !/[.:;,]$/.test(t) && t.length < 200;
  };

  while (i < lines.length) {
    if (HEAD.test(lines[i].trim())) {
      // find filename: nearest non-empty, non-fence line above
      let filename = "";
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        const prev = lines[j].trim();
        if (!prev) continue;
        if (prev.startsWith("```")) {
          // a bare ``` fence — keep looking one line up for a path
          continue;
        }
        if (looksLikeFilename(prev)) filename = prev.replace(/^`+|`+$/g, "").trim();
        break;
      }

      const startRaw = i;
      i++;
      const searchLines: string[] = [];
      while (i < lines.length && !DIVIDER.test(lines[i].trim())) {
        searchLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) break; // malformed — no divider
      i++; // skip divider
      const replaceLines: string[] = [];
      while (i < lines.length && !UPDATED.test(lines[i].trim())) {
        replaceLines.push(lines[i]);
        i++;
      }
      const endRaw = Math.min(i, lines.length - 1);
      i++; // skip >>>>>>> REPLACE

      blocks.push({
        filename,
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
        raw: lines.slice(startRaw, endRaw + 1).join("\n"),
      });
    } else {
      i++;
    }
  }
  return blocks;
}

/** Normalize for a tolerant secondary match (trailing whitespace / CRLF only). */
function normalizeLoose(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/**
 * Longest common substring-ish hint: return up to 3 lines of the file that
 * share the most tokens with the (failed) search head, to make feedback useful.
 */
function nearestContext(fileContent: string, search: string): string {
  const fileLines = fileContent.split(/\r?\n/);
  const needle = (search.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  if (!needle) return fileLines.slice(0, 3).join("\n");
  let bestIdx = 0;
  let bestScore = -1;
  const needleToks = new Set(needle.split(/\W+/).filter(Boolean));
  fileLines.forEach((l, idx) => {
    const toks = l.split(/\W+/).filter(Boolean);
    const overlap = toks.filter((t) => needleToks.has(t)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestIdx = idx;
    }
  });
  return fileLines.slice(Math.max(0, bestIdx - 1), bestIdx + 2).join("\n");
}

/**
 * Apply parsed blocks to a virtual file system (filename -> content).
 * `defaultFile` names the file to edit when a block has no filename (e.g. a
 * single-artifact task). Exact match first; a whitespace-loose match is allowed
 * as a fallback (mirrors Aider's flexible matching) but a total miss fails the
 * block with `SearchReplaceNoExactMatch`-style feedback.
 *
 * Aider semantics: an empty SEARCH on a non-existent file = create; an empty
 * SEARCH on an existing file = prepend/replace-whole per Aider is treated here
 * as "append to end" only when the file is empty, else it's ambiguous → fail.
 */
export function applyEditBlocks(
  blocks: ParsedEditBlock[],
  virtualFiles: Record<string, string>,
  defaultFile = "",
): ApplyResult {
  const files: Record<string, string> = { ...virtualFiles };
  const applications: EditApplication[] = [];
  const failures: string[] = [];

  for (const block of blocks) {
    const fname = block.filename || defaultFile || Object.keys(files)[0] || "unnamed.txt";
    const exists = Object.prototype.hasOwnProperty.call(files, fname);
    const current = files[fname] ?? "";

    // New-file creation: empty search + file absent/empty.
    if (block.search.trim() === "") {
      if (!exists || current.trim() === "") {
        files[fname] = block.replace;
        applications.push({ filename: fname, applied: true, updated: files[fname] });
        continue;
      }
      const msg =
        `SearchReplaceNoExactMatch: empty SEARCH block for existing non-empty file "${fname}". ` +
        `Provide the exact lines to replace.`;
      applications.push({ filename: fname, applied: false, reason: msg });
      failures.push(msg);
      continue;
    }

    if (exists && current.includes(block.search)) {
      files[fname] = current.replace(block.search, block.replace);
      applications.push({ filename: fname, applied: true, updated: files[fname] });
      continue;
    }

    // whitespace-loose fallback
    if (exists) {
      const looseCur = normalizeLoose(current);
      const looseSearch = normalizeLoose(block.search);
      if (looseSearch && looseCur.includes(looseSearch)) {
        files[fname] = looseCur.replace(looseSearch, normalizeLoose(block.replace));
        applications.push({
          filename: fname,
          applied: true,
          updated: files[fname],
          reason: "applied via whitespace-loose match",
        });
        continue;
      }
    }

    // total miss → Aider-style failure feedback
    const ctx = exists ? nearestContext(current, block.search) : "(file does not exist)";
    const msg =
      `SearchReplaceNoExactMatch: the SEARCH block did not match "${fname}".\n` +
      `<<<<<<< SEARCH\n${block.search}\n=======\n` +
      `Nearest content in the file was:\n${ctx}\n` +
      `The SEARCH section must match the existing content EXACTLY (character for character).`;
    applications.push({ filename: fname, applied: false, reason: msg });
    failures.push(msg);
  }

  return {
    ok: failures.length === 0 && applications.length > 0,
    applications,
    files,
    failures,
  };
}
