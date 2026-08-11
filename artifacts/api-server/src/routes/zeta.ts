/**
 * zeta.ts — Zeta Clearance: institutional KYB engine API.
 *
 * The end-to-end workflow, all four layers wired:
 *   L1  POST /api/zeta/entities                      — open an intake for an applicant institution
 *   L1  POST /api/zeta/entities/:id/documents        — drag-drop a corporate doc (vault + ingest + extract)
 *   L1  GET  /api/zeta/entities/:id/interrogate      — agentic interrogator: next missing-doc request
 *   L1  POST /api/zeta/entities/:id/interrogate/resume — applicant answers (uploads the requested doc)
 *   L2  (vault) documents stored encrypted; only tokens + evidence hashes here
 *   L2  POST /api/zeta/entities/:id/ubo              — deterministic UBO determination (graph engine)
 *   L3  POST /api/zeta/entities/:id/attest           — write Canton attestation + issue VC
 *   L4  POST /api/zeta/verify                        — relying party verifies clearance (no PII)
 *   L4  POST /api/zeta/entities/:id/revoke           — issuer revokes (propagates to EVM oracle)
 *   UI  GET  /api/zeta/entities                      — list intakes (front-end)
 *   UI  GET  /api/zeta/entities/:id                  — full workflow state for the portal
 *
 * Auth: Clerk JWT (or OPENCLAW_ADMIN_TOKEN). PII BOUNDARY: no raw PII is stored
 * here — documents live encrypted in the L2 vault, referenced by token + hash.
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import multer from "multer";
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import {
  zetaEntitiesTable,
  zetaDocumentsTable,
  zetaOwnershipEdgesTable,
  zetaUboResultsTable,
  zetaAttestationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import * as engine from "../lib/zeta/engineClient.js";
import { getVault } from "../lib/zeta/vaultClient.js";
import { getLedger } from "../lib/zeta/ledgerClient.js";
import { issueKyBVC } from "../lib/zeta/vcClient.js";
import { relayToEvm, evmIsCleared, evmRevoke } from "../lib/zeta/relayerClient.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function isAdminTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!envToken) return false;
  return req.headers["x-openclaw-admin-token"] === envToken;
}

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (isAdminTokenRequest(req)) { next(); return; }
  const auth = getAuth(req);
  if (!auth?.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

function tenantOf(req: Request): string {
  const auth = getAuth(req);
  return auth?.userId || "admin";
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── L1: open an intake ───────────────────────────────────────────────────────
router.post("/api/zeta/entities", requireAuth, async (req: Request, res: Response) => {
  const { legalName, jurisdiction } = req.body || {};
  if (!legalName) { res.status(400).json({ error: "legalName required" }); return; }
  const legalEntityHash = sha256(`${legalName.toLowerCase().trim()}:${(jurisdiction || "").toUpperCase()}`);
  const [row] = await db.insert(zetaEntitiesTable).values({
    tenantId: tenantOf(req), legalName, jurisdiction: jurisdiction || null,
    legalEntityHash, status: "intake",
  }).returning();
  logger.info({ entityId: row.id, legalName }, "zeta: intake opened");
  res.status(201).json(row);
});

// ── UI: list intakes ─────────────────────────────────────────────────────────
router.get("/api/zeta/entities", requireAuth, async (req: Request, res: Response) => {
  const rows = await db.select().from(zetaEntitiesTable).where(eq(zetaEntitiesTable.tenantId, tenantOf(req)));
  res.json({ entities: rows });
});

// ── UI: full workflow state for one entity ───────────────────────────────────
router.get("/api/zeta/entities/:id", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [entity] = await db.select().from(zetaEntitiesTable).where(eq(zetaEntitiesTable.id, id));
  if (!entity) { res.status(404).json({ error: "not found" }); return; }
  const documents = await db.select().from(zetaDocumentsTable).where(eq(zetaDocumentsTable.entityId, id));
  const edges = await db.select().from(zetaOwnershipEdgesTable).where(eq(zetaOwnershipEdgesTable.entityId, id));
  const uboRows = await db.select().from(zetaUboResultsTable).where(eq(zetaUboResultsTable.entityId, id));
  const attestations = await db.select().from(zetaAttestationsTable).where(eq(zetaAttestationsTable.entityId, id));
  res.json({
    entity, documents, edges,
    ubo: uboRows[uboRows.length - 1] || null,
    attestation: attestations[attestations.length - 1] || null,
  });
});

// ── L1: drag-drop a corporate document ───────────────────────────────────────
router.post("/api/zeta/entities/:id/documents", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [entity] = await db.select().from(zetaEntitiesTable).where(eq(zetaEntitiesTable.id, id));
  if (!entity) { res.status(404).json({ error: "not found" }); return; }
  const file = req.file;
  const recordType = (req.body?.recordType as string) || "other";
  if (!file) { res.status(400).json({ error: "file required" }); return; }

  // L2: encrypt into the vault FIRST; only token + hash persist here.
  const vault = getVault();
  const stored = await vault.storePii(file.buffer, recordType, `entity_${id}`);

  // L1: ingest + constrained extraction via the engine (Tessera parse + LLM edges).
  let chunkCount = 0;
  let edges: engine.OwnershipEdge[] = [];
  try {
    const ingested = await engine.engineIngest(file.originalname, file.buffer.toString("base64"));
    chunkCount = ingested.chunk_count;
    const extracted = await engine.engineExtractEdges(ingested.doc_id, ingested.chunks);
    edges = extracted.edges;
  } catch (e) {
    // Engine unreachable/cold — the doc is still safely vaulted; record and move on.
    logger.warn({ err: (e as Error).message }, "zeta: engine extraction deferred (doc vaulted)");
  }

  const [doc] = await db.insert(zetaDocumentsTable).values({
    entityId: id, vaultToken: stored.token, recordType,
    evidenceHash: stored.evidence_hash, sourceFilename: file.originalname, chunkCount,
  }).returning();

  for (const e of edges) {
    await db.insert(zetaOwnershipEdgesTable).values({
      entityId: id, ownerId: e.owner_id, ownedEntityId: e.owned_entity_id,
      directPct: e.direct_pct, ownerType: e.owner_type, sourceHash: e.source_hash,
      page: e.page, confidence: e.confidence, evidenceText: e.evidence_text || null,
    });
  }
  await db.update(zetaEntitiesTable).set({ status: "interrogating" }).where(eq(zetaEntitiesTable.id, id));
  logger.info({ entityId: id, docId: doc.id, edges: edges.length }, "zeta: document ingested");
  res.status(201).json({ document: doc, edgesExtracted: edges.length, edges });
});

// ── L1: agentic interrogator — next missing-doc request ─────────────────────
router.get("/api/zeta/entities/:id/interrogate", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const edges = await db.select().from(zetaOwnershipEdgesTable).where(eq(zetaOwnershipEdgesTable.entityId, id));
  const docs = await db.select().from(zetaDocumentsTable).where(eq(zetaDocumentsTable.entityId, id));
  const haveDocs = docs.map((d) => d.recordType);
  const engineEdges = edges.map((e) => ({
    owner_id: e.ownerId, owned_entity_id: e.ownedEntityId, direct_pct: e.directPct,
    source_hash: e.sourceHash, page: e.page, confidence: e.confidence, owner_type: e.ownerType,
  }));
  try {
    const out = await engine.engineInterrogate(`entity_${id}`, engineEdges, haveDocs);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "engine unavailable", detail: (e as Error).message });
  }
});

// ── L2: deterministic UBO determination ──────────────────────────────────────
router.post("/api/zeta/entities/:id/ubo", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const threshold = Number(req.body?.thresholdPct) || 25.0;
  const edges = await db.select().from(zetaOwnershipEdgesTable).where(eq(zetaOwnershipEdgesTable.entityId, id));
  if (!edges.length) { res.status(400).json({ error: "no ownership edges extracted yet" }); return; }
  const engineEdges = edges.map((e) => ({
    owner_id: e.ownerId, owned_entity_id: e.ownedEntityId, direct_pct: e.directPct,
    source_hash: e.sourceHash, page: e.page, confidence: e.confidence, owner_type: e.ownerType,
  }));
  try {
    const result = await engine.engineUbo(`entity_${id}`, engineEdges, threshold);
    const [row] = await db.insert(zetaUboResultsTable).values({
      entityId: id, ubos: result.ubos, flags: result.flags,
      reviewRequired: result.review_required, thresholdPct: threshold,
    }).returning();
    await db.update(zetaEntitiesTable).set({ status: result.review_required ? "review" : "interrogating" }).where(eq(zetaEntitiesTable.id, id));
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: "engine unavailable", detail: (e as Error).message });
  }
});

// ── L3: write Canton attestation + issue VC ──────────────────────────────────
router.post("/api/zeta/entities/:id/attest", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [entity] = await db.select().from(zetaEntitiesTable).where(eq(zetaEntitiesTable.id, id));
  if (!entity) { res.status(404).json({ error: "not found" }); return; }
  const uboRows = await db.select().from(zetaUboResultsTable).where(eq(zetaUboResultsTable.entityId, id));
  const ubo = uboRows[uboRows.length - 1];
  const docs = await db.select().from(zetaDocumentsTable).where(eq(zetaDocumentsTable.entityId, id));

  const decision = (req.body?.decision as string) || (ubo?.reviewRequired ? "review_required" : "approved");
  const riskTier = (req.body?.riskTier as string) || (ubo?.reviewRequired ? "high" : "low");
  const uboVerified = !ubo?.reviewRequired && (ubo?.ubos as unknown[] || []).length >= 0;
  // evidence bundle hash = hash of all doc evidence hashes (pointer, never content)
  const evidenceHash = sha256(docs.map((d) => d.evidenceHash).sort().join("|"));
  const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);

  const ledger = getLedger();
  const att = await ledger.createAttestation("zeta_agent", `entity_${id}`, ["aave_arc_pool"], {
    legalEntityHash: entity.legalEntityHash, decision, riskTier,
    uboVerified, expiresAt: expiresAt.toISOString(), evidenceHash,
  });

  const vc = await issueKyBVC({
    subjectDid: `did:zeta:entity_${id}`, decision, riskTier, uboVerified,
    expiresAt: expiresAt.toISOString(), evidenceHash, cantonContractId: att.contractId,
  });

  const [row] = await db.insert(zetaAttestationsTable).values({
    entityId: id, cantonContractId: att.contractId, decision, riskTier,
    uboVerified, evidenceHash, expiresAt, vcJson: vc,
  }).returning();
  await db.update(zetaEntitiesTable).set({ status: decision === "approved" ? "approved" : decision, riskTier }).where(eq(zetaEntitiesTable.id, id));

  // L4: relay to the EVM oracle so permissioned pools can gate on it.
  let evm = null;
  try { evm = await relayToEvm(att.contractId, "aave_arc_pool"); } catch (e) {
    logger.warn({ err: (e as Error).message }, "zeta: EVM relay deferred");
  }
  logger.info({ entityId: id, contractId: att.contractId, decision }, "zeta: attested");
  res.status(201).json({ attestation: row, vc, evm });
});

// ── L4: relying party verifies clearance (no PII) ────────────────────────────
router.post("/api/zeta/verify", async (req: Request, res: Response) => {
  const { legalEntityHash, cantonContractId } = req.body || {};
  if (!legalEntityHash && !cantonContractId) { res.status(400).json({ error: "legalEntityHash or cantonContractId required" }); return; }
  try {
    const cleared = await evmIsCleared(legalEntityHash || "");
    res.json({ cleared, legalEntityHash: legalEntityHash || null, cantonContractId: cantonContractId || null });
  } catch (e) {
    res.status(502).json({ error: "verification failed", detail: (e as Error).message });
  }
});

// ── L4: issuer revokes ───────────────────────────────────────────────────────
router.post("/api/zeta/entities/:id/revoke", requireAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const attestations = await db.select().from(zetaAttestationsTable).where(eq(zetaAttestationsTable.entityId, id));
  const att = attestations[attestations.length - 1];
  if (!att) { res.status(404).json({ error: "no attestation to revoke" }); return; }
  const ledger = getLedger();
  await ledger.revoke(att.cantonContractId, "zeta_agent");
  await db.update(zetaAttestationsTable).set({ revoked: true }).where(eq(zetaAttestationsTable.id, att.id));
  await db.update(zetaEntitiesTable).set({ status: "rejected" }).where(eq(zetaEntitiesTable.id, id));

  // Revoking on Canton alone leaves the EVM oracle entry posted at attest time
  // with revoked=false, so isCleared stays true and POST /api/zeta/verify would
  // keep telling a permissioned pool this entity is cleared. Tear it down and
  // assert the bit is actually off before reporting success.
  const [entity] = await db.select().from(zetaEntitiesTable).where(eq(zetaEntitiesTable.id, id));
  const evm = entity?.legalEntityHash ? await evmRevoke(entity.legalEntityHash)
                                      : { entityHash: null, revoked: false, isCleared: false };
  if (evm.isCleared) {
    logger.error({ entityId: id, entityHash: evm.entityHash }, "zeta: on-chain clearance survived revocation");
    res.status(500).json({ error: "revocation did not clear the on-chain allowlist", evm });
    return;
  }
  logger.info({ entityId: id, contractId: att.cantonContractId, evm }, "zeta: revoked");
  res.json({ revoked: true, cantonContractId: att.cantonContractId, evm });
});

export default router;
