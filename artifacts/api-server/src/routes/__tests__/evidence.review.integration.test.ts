import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@clerk/express", () => ({
  getAuth: (req: any) => ({ userId: req.headers["x-test-clerk-user"] ?? null }),
}));

import { pool } from "@workspace/db";
import reviewRouter from "../evidenceReview.js";

const enabled = Boolean(process.env.EVIDENCE_INTEGRATION_DATABASE_URL);
const app = express();
app.use(express.json());
app.use(reviewRouter);
const asUser = (userId: string) => ({ "X-Test-Clerk-User": userId });
let reviewItemId = "";
let recordId = "";
let originalQc = "";

beforeAll(async () => {
  if (!enabled) return;
  const source = await pool.query(`SELECT a.record_id,a.human_qc_status FROM aacr_abstracts a WHERE NOT EXISTS (SELECT 1 FROM aacr_review_items i WHERE i.record_id=a.record_id AND i.test_only=true) ORDER BY a.record_id LIMIT 1`);
  recordId = source.rows[0].record_id;
  originalQc = source.rows[0].human_qc_status;
  await pool.query(`INSERT INTO aacr_reviewer_roles(user_id,role) VALUES
    ('reviewer-one','ANNOTATOR'),('reviewer-two','ANNOTATOR'),('adjudicator-one','ADJUDICATOR'),('evidence-admin','ADMIN')
    ON CONFLICT(user_id,role) DO UPDATE SET active=true`);
  const item = await pool.query(`INSERT INTO aacr_review_items(record_id,source_set_tags,state,test_only,priority)
    VALUES($1,'["integration_fixture"]','UNASSIGNED',true,100)
    ON CONFLICT(record_id,test_only) DO UPDATE SET state='UNASSIGNED',priority=100
    RETURNING review_item_id`, [recordId]);
  reviewItemId = item.rows[0].review_item_id;
});

describe.runIf(enabled)("blinded review and adjudication integration", () => {
  it("runs a test-only disagreement through independent adjudication", async () => {
    const claim1 = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/claim`).set(asUser("reviewer-one"));
    const claim2 = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/claim`).set(asUser("reviewer-two"));
    expect(claim1.status).toBe(200);
    expect(claim2.status).toBe(200);
    expect(claim1.body.blinded).toBe(true);
    expect(claim2.body.blinded).toBe(true);
    expect(claim1.body.assignment.slot).not.toBe(claim2.body.assignment.slot);

    const label1 = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/labels`).set(asUser("reviewer-one")).send({
      linkage_label: "CONFIRMED_DIRECT_LINK", target_concordance: "SUPPORTED", disease_concordance: "SUPPORTED",
      intervention_concordance: "SUPPORTED", rationale: "The source contains the exact NCT token.",
    });
    expect(label1.status).toBe(201);
    expect(label1.body.other_label_disclosed).toBe(false);

    const label2 = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/labels`).set(asUser("reviewer-two")).send({
      linkage_label: "AMBIGUOUS_REVIEW_REQUIRED", target_concordance: "INSUFFICIENT_EVIDENCE", disease_concordance: "SUPPORTED",
      intervention_concordance: "INSUFFICIENT_EVIDENCE", rationale: "The intervention context remains insufficient.",
    });
    expect(label2.status).toBe(201);
    expect(label2.body.state).toBe("DISAGREEMENT");
    expect(label2.body.other_label_disclosed).toBe(false);

    const forbidden = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/adjudicate`).set(asUser("reviewer-one")).send({
      final_label: "CONFIRMED_DIRECT_LINK", decision: "PROMOTE", rationale: "Reviewer must not adjudicate their own item.",
    });
    expect(forbidden.status).toBe(403);

    const adjudication = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/adjudicate`).set(asUser("adjudicator-one")).send({
      final_label: "CONFIRMED_DIRECT_LINK", decision: "PROMOTE", rationale: "Exact source token resolves the disagreement.",
    });
    expect(adjudication.status).toBe(201);

    const promotion = await request(app).post(`/intelligence/evidence/reviews/${reviewItemId}/promote`).set(asUser("evidence-admin"));
    expect(promotion.status).toBe(200);
    expect(promotion.body.state).toBe("PROMOTED");
    expect(promotion.body.production_promotion).toBe(false);

    const sourceAfter = await pool.query(`SELECT human_qc_status FROM aacr_abstracts WHERE record_id=$1`, [recordId]);
    expect(sourceAfter.rows[0].human_qc_status).toBe(originalQc);
    const events = await pool.query(`SELECT event_type,test_only FROM aacr_review_events WHERE review_item_id=$1 ORDER BY created_at`, [reviewItemId]);
    expect(events.rows.map((row: any) => row.event_type)).toEqual(expect.arrayContaining(["CLAIMED", "LABEL_SUBMITTED", "ADJUDICATED", "PROMOTED"]));
    expect(events.rows.every((row: any) => row.test_only)).toBe(true);
    await expect(pool.query(`UPDATE aacr_review_events SET event_type='TAMPERED' WHERE review_item_id=$1`, [reviewItemId])).rejects.toThrow(/append-only/);
  });
});
