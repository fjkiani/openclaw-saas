import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * legal_receipt_nonces — one-time-use receipt tracking for Phase 2A action generation.
 *
 * Each receipt_id (UUID nonce from MatterReceipt) may only be consumed once.
 * The /action route INSERTs here before Pass 1 (draft). A unique_violation (23505)
 * on receipt_id means the receipt was already used → 409 Conflict.
 *
 * Append-only. No deletes, no updates.
 * Receipt expiry is enforced by the token's expires_at field, not by this table.
 */
export const legalReceiptNoncesTable = pgTable("legal_receipt_nonces", {
  receiptId:  uuid("receipt_id").primaryKey(),
  matterId:   uuid("matter_id").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
  actionType: text("action_type").notNull(),
  tenantId:   text("tenant_id").notNull(),
});

export type LegalReceiptNonce = typeof legalReceiptNoncesTable.$inferSelect;
export type InsertLegalReceiptNonce = typeof legalReceiptNoncesTable.$inferInsert;
