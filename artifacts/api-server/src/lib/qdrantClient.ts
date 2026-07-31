/**
 * qdrantClient.ts — Qdrant vector DB REST API client.
 *
 * Uses the Qdrant REST API directly (no SDK dependency — just fetch).
 * Reads QDRANT_URL and QDRANT_API_KEY from env.
 *
 * Collections (prefixed openclaw_ to avoid contaminating existing ones):
 *   openclaw_legal_corpus — 3072-dim, Cosine (Gemini embedding-001)
 *   openclaw_aacr         — 1536-dim, Cosine (text-embedding-3-small / Gemini truncated)
 */

import { logger } from "./logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

const QDRANT_URL = (process.env.QDRANT_URL ?? "").replace(/\/$/, "");
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";

export const LEGAL_CORPUS_COLLECTION = "openclaw_legal_corpus";
export const AACR_COLLECTION = "openclaw_aacr";

export const LEGAL_EMBED_DIM = 3072;
export const AACR_EMBED_DIM = 1536;

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (QDRANT_API_KEY) {
    h["api-key"] = QDRANT_API_KEY;
  }
  return h;
}

function isConfigured(): boolean {
  if (!QDRANT_URL) {
    logger.warn("qdrantClient: QDRANT_URL not set — vector search disabled");
    return false;
  }
  return true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QdrantPoint {
  id: number;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchHit {
  id: number;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantCollectionInfo {
  vectors_count: number;
  points_count: number;
  dims: number;
  distance: string;
  status: string;
}

// ── Collection management ─────────────────────────────────────────────────────

/**
 * Ensure a collection exists with the given vector config.
 * Creates it if it doesn't exist; does nothing if it already does.
 */
export async function ensureCollection(
  collectionName: string,
  dims: number,
  distance: "Cosine" | "Dot" | "Euclid" = "Cosine",
): Promise<boolean> {
  if (!isConfigured()) return false;

  // Check if collection already exists
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { result?: { status?: string } };
      if (data.result?.status === "green") {
        logger.info({ collection: collectionName }, "qdrantClient: collection already exists");
        return true;
      }
    }
  } catch {
    // Collection doesn't exist — proceed to create
  }

  // Create collection
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}?timeout=30`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        vectors: {
          size: dims,
          distance,
        },
        on_disk_payload: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ collection: collectionName, status: res.status, body: body.slice(0, 200) }, "qdrantClient: failed to create collection");
      return false;
    }

    logger.info({ collection: collectionName, dims, distance }, "qdrantClient: collection created");
    return true;
  } catch (err: unknown) {
    logger.error({ err, collection: collectionName }, "qdrantClient: create collection failed");
    return false;
  }
}

/**
 * Get collection info (point count, dimensions, status).
 */
export async function collectionInfo(collectionName: string): Promise<QdrantCollectionInfo | null> {
  if (!isConfigured()) return null;

  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: {
        vectors_count?: number;
        points_count?: number;
        status?: string;
        config?: {
          params?: {
            vectors?: { size?: number; distance?: string };
          };
        };
      };
    };

    const r = data.result;
    if (!r) return null;

    return {
      vectors_count: r.vectors_count ?? 0,
      points_count: r.points_count ?? 0,
      dims: r.config?.params?.vectors?.size ?? 0,
      distance: r.config?.params?.vectors?.distance ?? "unknown",
      status: r.status ?? "unknown",
    };
  } catch {
    return null;
  }
}

// ── Point operations ──────────────────────────────────────────────────────────

/**
 * Upsert points into a collection. Batches automatically to avoid payload limits.
 */
export async function upsertPoints(
  collectionName: string,
  points: QdrantPoint[],
  batchSize = 100,
): Promise<number> {
  if (!isConfigured()) return 0;
  if (points.length === 0) return 0;

  let upserted = 0;

  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    try {
      const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points?wait=true`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ points: batch }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.warn(
          { collection: collectionName, batch: i / batchSize, status: res.status, body: body.slice(0, 200) },
          "qdrantClient: upsert batch failed",
        );
        continue;
      }

      upserted += batch.length;
    } catch (err: unknown) {
      logger.warn({ err, collection: collectionName, batch: i / batchSize }, "qdrantClient: upsert batch error");
    }
  }

  logger.info({ collection: collectionName, upserted, total: points.length }, "qdrantClient: upsert complete");
  return upserted;
}

/**
 * Search for similar vectors in a collection.
 */
export async function search(
  collectionName: string,
  queryVector: number[],
  opts: {
    limit?: number;
    scoreThreshold?: number;
    filter?: Record<string, unknown>;
  } = {},
): Promise<QdrantSearchHit[]> {
  if (!isConfigured()) return [];

  const { limit = 20, scoreThreshold, filter } = opts;

  try {
    const body: Record<string, unknown> = {
      vector: queryVector,
      limit,
      with_payload: true,
    };

    if (scoreThreshold !== undefined) {
      body.score_threshold = scoreThreshold;
    }

    if (filter) {
      body.filter = filter;
    }

    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ collection: collectionName, status: res.status, body: body.slice(0, 200) }, "qdrantClient: search failed");
      return [];
    }

    const data = (await res.json()) as {
      result?: Array<{
        id: number;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };

    return (data.result ?? []).map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload ?? {},
    }));
  } catch (err: unknown) {
    logger.warn({ err, collection: collectionName }, "qdrantClient: search error");
    return [];
  }
}

/**
 * Delete points by ID from a collection.
 */
export async function deletePoints(
  collectionName: string,
  pointIds: number[],
): Promise<boolean> {
  if (!isConfigured()) return false;
  if (pointIds.length === 0) return true;

  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/delete?wait=true`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ points: pointIds }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ collection: collectionName, status: res.status }, "qdrantClient: delete failed");
      return false;
    }

    return true;
  } catch (err: unknown) {
    logger.warn({ err, collection: collectionName }, "qdrantClient: delete error");
    return false;
  }
}

/**
 * Delete all points in a collection by filter (e.g., by document_id).
 */
export async function deleteByFilter(
  collectionName: string,
  filter: Record<string, unknown>,
): Promise<boolean> {
  if (!isConfigured()) return false;

  try {
    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/delete?wait=true`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ filter }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ collection: collectionName, status: res.status }, "qdrantClient: deleteByFilter failed");
      return false;
    }

    return true;
  } catch (err: unknown) {
    logger.warn({ err, collection: collectionName }, "qdrantClient: deleteByFilter error");
    return false;
  }
}

/**
 * Scroll through all points in a collection (for seeding/migration).
 * Returns points in batches.
 */
export async function scrollPoints(
  collectionName: string,
  opts: {
    limit?: number;
    offset?: number;
    withPayload?: boolean;
    withVector?: boolean;
  } = {},
): Promise<{ points: QdrantPoint[]; nextOffset?: number }> {
  if (!isConfigured()) return { points: [] };

  const { limit = 100, offset, withPayload = true, withVector = false } = opts;

  try {
    const body: Record<string, unknown> = {
      limit,
      with_payload: withPayload,
      with_vector: withVector,
    };

    if (offset !== undefined) {
      body.offset = offset;
    }

    const res = await fetch(`${QDRANT_URL}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ collection: collectionName, status: res.status }, "qdrantClient: scroll failed");
      return { points: [] };
    }

    const data = (await res.json()) as {
      result?: {
        points?: Array<{
          id: number;
          payload?: Record<string, unknown>;
          vector?: number[];
        }>;
        next_page_offset?: number | null;
      };
    };

    const points: QdrantPoint[] = (data.result?.points ?? []).map((p) => ({
      id: p.id,
      vector: p.vector ?? [],
      payload: p.payload ?? {},
    }));

    return {
      points,
      nextOffset: data.result?.next_page_offset ?? undefined,
    };
  } catch (err: unknown) {
    logger.warn({ err, collection: collectionName }, "qdrantClient: scroll error");
    return { points: [] };
  }
}

/**
 * Check if Qdrant is configured and reachable.
 */
export async function healthCheck(): Promise<{ ok: boolean; version?: string; collections?: string[] }> {
  if (!isConfigured()) return { ok: false };

  try {
    const res = await fetch(`${QDRANT_URL}/`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return { ok: false };

    const data = (await res.json()) as { title?: string; version?: string };

    // Also list collections
    const colRes = await fetch(`${QDRANT_URL}/collections`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });

    let collections: string[] = [];
    if (colRes.ok) {
      const colData = (await colRes.json()) as {
        result?: { collections?: Array<{ name: string }> };
      };
      collections = (colData.result?.collections ?? []).map((c) => c.name);
    }

    return { ok: true, version: data.version, collections };
  } catch {
    return { ok: false };
  }
}
