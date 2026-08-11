import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Zeta Clearance — institutional KYB domain.
 *
 * PII BOUNDARY: this schema stores NO raw PII. Documents are referenced by
 * vault token + evidence hash (L2). Ownership edges carry page citations. The
 * attestation row mirrors the 6-field minimal Canton claim. Raw passports /
 * cap tables live ONLY in the encrypted vault, never here.
 */

// An applicant institution going through KYB.
export const zetaEntitiesTable = pgTable("zeta_entities", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  legalName: text("legal_name").notNull(),
  jurisdiction: text("jurisdiction"),
  legalEntityHash: text("legal_entity_hash").notNull(), // SHA-256(name+jurisdiction)
  status: text("status").notNull().default("intake"),   // intake|interrogating|review|approved|rejected
  riskTier: text("risk_tier"),                          // low|medium|high (set on decision)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// An uploaded corporate document — referenced by vault token + hash, NOT content.
export const zetaDocumentsTable = pgTable("zeta_documents", {
  id: serial("id").primaryKey(),
  entityId: integer("entity_id").notNull(),
  vaultToken: text("vault_token").notNull(),       // L2 vault handle (never raw bytes here)
  recordType: text("record_type").notNull(),       // incorporation|cap_table|passport|...
  evidenceHash: text("evidence_hash").notNull(),   // SHA-256 of plaintext (pre-encryption)
  sourceFilename: text("source_filename"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A candidate ownership edge proposed by the LLM extractor (page-cited).
export const zetaOwnershipEdgesTable = pgTable("zeta_ownership_edges", {
  id: serial("id").primaryKey(),
  entityId: integer("entity_id").notNull(),
  ownerId: text("owner_id").notNull(),
  ownedEntityId: text("owned_entity_id").notNull(),
  directPct: real("direct_pct").notNull(),
  ownerType: text("owner_type").notNull().default("unknown"),
  sourceHash: text("source_hash").notNull(),
  page: integer("page").notNull().default(1),
  confidence: real("confidence").notNull(),
  evidenceText: text("evidence_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The deterministic UBO determination result (from the graph engine, not the LLM).
export const zetaUboResultsTable = pgTable("zeta_ubo_results", {
  id: serial("id").primaryKey(),
  entityId: integer("entity_id").notNull(),
  ubos: jsonb("ubos").notNull(),               // [{person_id, aggregate_pct, paths}]
  flags: jsonb("flags").notNull(),            // [circular_ownership, ...]
  reviewRequired: boolean("review_required").notNull().default(false),
  thresholdPct: real("threshold_pct").notNull().default(25.0),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

// The agentic interrogator's pause/resume state (serializable).
export const zetaInterrogationsTable = pgTable("zeta_interrogations", {
  id: serial("id").primaryKey(),
  entityId: integer("entity_id").notNull(),
  status: text("status").notNull().default("assess"), // assess|await_doc|satisfied
  pending: jsonb("pending"),                          // outstanding doc request
  state: jsonb("state").notNull(),                    // full InterrogatorState
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// The L3 Canton attestation (minimal non-PII claim) + issued VC.
export const zetaAttestationsTable = pgTable("zeta_attestations", {
  id: serial("id").primaryKey(),
  entityId: integer("entity_id").notNull(),
  cantonContractId: text("canton_contract_id").notNull(),
  decision: text("decision").notNull(),         // approved|rejected|review_required
  riskTier: text("risk_tier").notNull(),
  uboVerified: boolean("ubo_verified").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  vcJson: jsonb("vc_json"),                     // the signed W3C credential
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertZetaEntitySchema = createInsertSchema(zetaEntitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertZetaDocumentSchema = createInsertSchema(zetaDocumentsTable).omit({ id: true, createdAt: true });
export const insertZetaOwnershipEdgeSchema = createInsertSchema(zetaOwnershipEdgesTable).omit({ id: true, createdAt: true });
export const insertZetaAttestationSchema = createInsertSchema(zetaAttestationsTable).omit({ id: true, createdAt: true });

export type ZetaEntity = typeof zetaEntitiesTable.$inferSelect;
export type ZetaDocument = typeof zetaDocumentsTable.$inferSelect;
export type ZetaOwnershipEdge = typeof zetaOwnershipEdgesTable.$inferSelect;
export type ZetaUboResult = typeof zetaUboResultsTable.$inferSelect;
export type ZetaAttestation = typeof zetaAttestationsTable.$inferSelect;
