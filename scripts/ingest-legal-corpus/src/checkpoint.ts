/**
 * checkpoint.ts — JSON checkpoint for resume on 429 / failure.
 *
 * Stores completed slugs in a JSON file so the ingest CLI can resume
 * after a rate limit or crash without re-processing documents.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CHECKPOINT_FILE = resolve(process.cwd(), ".ingest-checkpoint.json");

export interface Checkpoint {
  completed: string[];
}

export function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
    if (Array.isArray(data.completed)) {
      return { completed: data.completed };
    }
  } catch {
    // Corrupt checkpoint — start fresh
  }
  return null;
}

export function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), "utf-8");
}
