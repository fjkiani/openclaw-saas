import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Metric thresholds a fine-tuned model must clear before promotion.
export const zieModelPromotionGatesTable = pgTable(
  "zie_model_promotion_gates",
  {
    gateId: uuid("gate_id").primaryKey().default(sql`gen_random_uuid()`),
    domain: text("domain").notNull(),
    taskType: text("task_type"),
    // e.g. f1_adversarial | unsupported_high_severity_rate | evidence_span_precision | posting_screen_accuracy
    metricKey: text("metric_key").notNull(),
    minValue: numeric("min_value"),
    maxValue: numeric("max_value"),
    hardFail: boolean("hard_fail").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_zmpg_domain_task_active").on(t.domain, t.taskType, t.active),
  ],
);

export type ZieModelPromotionGate =
  typeof zieModelPromotionGatesTable.$inferSelect;
export type InsertZieModelPromotionGate =
  typeof zieModelPromotionGatesTable.$inferInsert;
