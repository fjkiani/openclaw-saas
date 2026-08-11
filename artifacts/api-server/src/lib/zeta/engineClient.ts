/**
 * Zeta Clearance — client for the zeta-kyb-engine Modal service.
 *
 * The heavy Python (Tessera ingest + constrained extraction + deterministic UBO
 * graph) runs as a Modal HTTP service. The Express backend calls it here — the
 * same dispatch pattern as modalDispatch.ts. Auth via ZETA_ENGINE_TOKEN bearer.
 *
 * FAIL LOUDLY: every method throws on a non-2xx or a malformed payload. No
 * swallowed "safe" defaults — a KYB decision must never be inferred from a
 * failed engine call.
 */

// Zeta engine runs as the /zeta router on the live Tessera FastAPI service.
// Modal was dropped: its workspace hit a spend limit and the proxy-auth keys
// issued are webhook credentials, not CLI deploy tokens. Render already hosts
// this service, so the engine ships there with no new infrastructure.
const ENGINE_BASE = (
  process.env.ZETA_ENGINE_URL || "https://agentic-text-to-sql-44f2.onrender.com/zeta"
).replace(/\/$/, "");
const ENGINE_TOKEN = process.env.ZETA_ENGINE_TOKEN || "";

export interface OwnershipEdge {
  owner_id: string;
  owned_entity_id: string;
  direct_pct: number;
  source_hash: string;
  page: number;
  confidence: number;
  owner_type: string;
  evidence_text?: string;
}

export interface UBOResult {
  entity_id: string;
  ubos: Array<{ person_id: string; aggregate_pct: number; paths: unknown[] }>;
  flags: string[];
  threshold_pct: number;
  review_required: boolean;
  computed_at: string;
}

function assertConfigured(): void {
  if (!ENGINE_BASE) {
    throw new Error("ZETA_ENGINE_URL not configured and no default engine base available");
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  assertConfigured();
  const res = await fetch(`${ENGINE_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ENGINE_TOKEN ? { Authorization: `Bearer ${ENGINE_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`zeta-engine ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Parse an uploaded doc into provenance chunks (Tessera ingest). */
export async function engineIngest(filename: string, docB64: string): Promise<{
  doc_id: string; source: string; chunk_count: number; chunks: unknown[];
}> {
  return post("/ingest", { filename, doc_b64: docB64 });
}

/** Constrained LLM extraction of candidate ownership edges. */
export async function engineExtractEdges(docId: string, chunks: unknown[]): Promise<{
  edges: OwnershipEdge[]; source_hash: string; low_confidence: string[];
}> {
  return post("/extract_edges", { doc_id: docId, chunks });
}

/** Deterministic UBO determination (graph engine, not the LLM). */
export async function engineUbo(entityId: string, edges: OwnershipEdge[], thresholdPct = 25.0): Promise<UBOResult> {
  return post("/ubo", { entity_id: entityId, edges, threshold_pct: thresholdPct });
}

/** Agentic interrogator: next missing-doc decision. */
export async function engineInterrogate(entityId: string, edges: OwnershipEdge[], haveDocs: string[]): Promise<{
  action: "request_doc" | "satisfied"; missing?: Record<string, unknown>; message?: string;
}> {
  return post("/interrogate", { entity_id: entityId, edges, have_docs: haveDocs });
}

export async function engineHealth(): Promise<{ status: string }> {
  assertConfigured();
  const res = await fetch(`${ENGINE_BASE}/health`, {
    headers: ENGINE_TOKEN ? { Authorization: `Bearer ${ENGINE_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`zeta-engine health failed: HTTP ${res.status}`);
  return (await res.json()) as { status: string };
}
