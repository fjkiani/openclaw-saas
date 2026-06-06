/**
 * Ingest CLI — main entry point.
 *
 * Usage:
 *   pnpm --filter @workspace/ingest-legal-corpus run ingest -- \
 *     --manifest <path> [--dry-run] [--embed] [--delay 1000]
 *
 * Flags:
 *   --manifest <path>   Path to legal-corpus-manifest.json (required)
 *   --dry-run           Validate manifest + load text, but don't write to DB
 *   --embed             Actually call the embedding API (skipped in dry-run)
 *   --delay <ms>        Delay between embed calls (default: 1000)
 *   --resume            Resume from checkpoint if one exists
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadManifestText } from "./loader.js";
import { batchIngest } from "./batchIngest.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";

interface ManifestEntry {
  slug: string;
  title: string;
  source_type: string;
  source_url?: string;
  license: string;
  domain: string;
  priority: string;
  fetch_strategy: string;
  file_path: string;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[i + 1];
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = args.manifest as string;
  if (!manifestPath) {
    console.error("ERROR: --manifest <path> is required");
    process.exit(1);
  }

  const dryRun = args["dry-run"] === true;
  const embed = args.embed === true;
  const delay = parseInt(args.delay as string) || 1000;
  const resume = args.resume === true;

  console.log(`\n=== Legal Corpus Ingest CLI ===`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Dry run:  ${dryRun}`);
  console.log(`Embed:    ${embed}`);
  console.log(`Delay:    ${delay}ms`);
  console.log(`Resume:   ${resume}\n`);

  // ── Load manifest ──────────────────────────────────────────────────────
  const absManifestPath = resolve(manifestPath);
  if (!existsSync(absManifestPath)) {
    console.error(`ERROR: manifest not found at ${absManifestPath}`);
    process.exit(1);
  }

  const manifest: ManifestEntry[] = JSON.parse(
    readFileSync(absManifestPath, "utf-8"),
  );
  console.log(`Manifest entries: ${manifest.length}`);

  // Validate slugs match regex
  const slugRegex = /^[a-z0-9-]+$/;
  const badSlugs = manifest.filter((e) => !slugRegex.test(e.slug));
  if (badSlugs.length > 0) {
    console.error(
      `ERROR: ${badSlugs.length} slugs fail regex: ${badSlugs.map((e) => e.slug).join(", ")}`,
    );
    process.exit(1);
  }

  // ── Load checkpoint ────────────────────────────────────────────────────
  const checkpoint = resume ? loadCheckpoint() : null;
  const completedSlugs = new Set(checkpoint?.completed ?? []);

  // ── Load text for each entry ───────────────────────────────────────────
  const manifestDir = dirname(absManifestPath);
  const entries = [];

  for (const entry of manifest) {
    if (completedSlugs.has(entry.slug)) {
      console.log(`  SKIP (checkpoint): ${entry.slug}`);
      continue;
    }

    const filePath = resolve(manifestDir, entry.file_path);
    const content = loadManifestText(filePath, entry.fetch_strategy);
    if (!content) {
      console.warn(`  WARN: no content for ${entry.slug}, skipping`);
      continue;
    }

    entries.push({
      slug: entry.slug,
      title: entry.title,
      domain: entry.domain,
      priority: entry.priority as "critical" | "normal" | "high" | "medium",
      content,
      source_type: entry.source_type,
      source_url: entry.source_url,
    });

    console.log(`  LOADED: ${entry.slug} (${content.length} chars)`);
  }

  console.log(`\nEntries to ingest: ${entries.length}`);

  if (dryRun) {
    console.log("\n=== DRY RUN — no DB writes ===");
    // Estimate chunks
    let totalChunks = 0;
    for (const e of entries) {
      const words = e.content.split(/\s+/).filter(Boolean).length;
      const estChunks = Math.ceil(words / 280);
      totalChunks += estChunks;
      console.log(`  ${e.slug}: ~${estChunks} chunks (${words} words)`);
    }
    console.log(`\nEstimated total chunks: ${totalChunks}`);
    return;
  }

  if (!embed) {
    console.log(
      "\nNOTE: --embed not set. Documents will be ingested WITHOUT embeddings.",
    );
    console.log("      Add --embed to call the embedding API.\n");
  }

  // ── Run batch ingest ───────────────────────────────────────────────────
  const results = await batchIngest(entries, {
    embed,
    delayMs: delay,
    onProgress: (slug, idx, total) => {
      console.log(`  [${idx + 1}/${total}] ${slug}`);
    },
    onResult: (result) => {
      // Save checkpoint after each successful ingest
      completedSlugs.add(result.slug);
      saveCheckpoint({ completed: Array.from(completedSlugs) });
    },
  });

  // ── Summary ────────────────────────────────────────────────────────────
  const ingested = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const totalChunks = ingested.reduce((sum, r) => sum + r.chunks, 0);

  console.log(`\n=== Ingest Complete ===`);
  console.log(`Ingested: ${ingested.length} documents`);
  console.log(`Skipped:  ${skipped.length} documents (unchanged)`);
  console.log(`Chunks:   ${totalChunks}`);

  // Clean up checkpoint on success
  if (skipped.length === 0 && ingested.length === entries.length) {
    saveCheckpoint({ completed: [] });
    console.log("Checkpoint cleared.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
