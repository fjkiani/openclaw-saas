import { pgTable, text, jsonb, boolean, integer, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const aacrAbstractsTable = pgTable("aacr_abstracts", {
  recordId: text("record_id").primaryKey(), doi: text("doi"), title: text("title").notNull(),
  abstractText: text("abstract_text").notNull(), sourceLabel: text("source_label"),
  sourceSha256: text("source_sha256").notNull(), enrichmentJson: jsonb("enrichment_json").notNull().default({}),
  disposition: text("disposition").notNull(), permittedUse: text("permitted_use").notNull().default("INTERNAL_FORENSIC_ONLY"),
  humanQcStatus: text("human_qc_status").notNull().default("NOT_STARTED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("aacr_abstracts_doi_idx").on(t.doi)]);

export const aacrRegistryStudiesTable = pgTable("aacr_registry_studies", {
  nctId: text("nct_id").primaryKey(), briefTitle: text("brief_title"), officialTitle: text("official_title"),
  conditions: jsonb("conditions").notNull().default([]), interventions: jsonb("interventions").notNull().default([]),
  leadSponsor: text("lead_sponsor"), collaborators: jsonb("collaborators").notNull().default([]),
  phases: jsonb("phases").notNull().default([]), overallStatus: text("overall_status"), startDate: text("start_date"),
  primaryCompletionDate: text("primary_completion_date"), currentResponseSha256: text("current_response_sha256").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
});

export const aacrTrialLinkagesTable = pgTable("aacr_trial_linkages", {
  linkageId: uuid("linkage_id").primaryKey().default(sql`gen_random_uuid()`),
  sourceRecordId: text("source_record_id").notNull().references(() => aacrAbstractsTable.recordId, { onDelete: "cascade" }),
  nctId: text("nct_id").notNull(), linkageState: text("linkage_state").notNull(), ruleVersion: text("rule_version").notNull(),
  evidenceJson: jsonb("evidence_json").notNull(), receiptId: text("receipt_id").notNull(),
  permittedUse: text("permitted_use").notNull(), humanQcStatus: text("human_qc_status").notNull().default("NOT_STARTED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("aacr_trial_linkages_receipt_idx").on(t.receiptId), index("aacr_trial_linkages_state_idx").on(t.linkageState)]);

export const aacrClaimReceiptsTable = pgTable("aacr_claim_receipts", {
  receiptId: text("receipt_id").primaryKey(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  fieldName: text("field_name").notNull(), valueJson: jsonb("value_json").notNull(), sourceState: text("source_state").notNull(),
  evidenceTier: text("evidence_tier").notNull(), lifecycleStatus: text("lifecycle_status").notNull(),
  sourceExcerpt: text("source_excerpt"), sourceHash: text("source_hash").notNull(), permittedUse: text("permitted_use").notNull(),
  claimEligible: boolean("claim_eligible").notNull().default(false), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("aacr_claim_entity_idx").on(t.entityType, t.entityId)]);

export const aacrReviewItemsTable = pgTable("aacr_review_items", {
  reviewItemId: uuid("review_item_id").primaryKey().default(sql`gen_random_uuid()`),
  recordId: text("record_id").notNull().references(() => aacrAbstractsTable.recordId, { onDelete: "cascade" }),
  sourceSetTags: jsonb("source_set_tags").notNull().default([]), state: text("state").notNull().default("UNASSIGNED"),
  testOnly: boolean("test_only").notNull().default(false), priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aacrReviewEventsTable = pgTable("aacr_review_events", {
  eventId: uuid("event_id").primaryKey().default(sql`gen_random_uuid()`), reviewItemId: uuid("review_item_id").notNull(),
  actorId: text("actor_id").notNull(), eventType: text("event_type").notNull(), fromState: text("from_state"), toState: text("to_state"),
  payloadJson: jsonb("payload_json").notNull().default({}), testOnly: boolean("test_only").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AacrAbstract = typeof aacrAbstractsTable.$inferSelect;
export type AacrRegistryStudy = typeof aacrRegistryStudiesTable.$inferSelect;
export type AacrTrialLinkage = typeof aacrTrialLinkagesTable.$inferSelect;
export type AacrClaimReceipt = typeof aacrClaimReceiptsTable.$inferSelect;
