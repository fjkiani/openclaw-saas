import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@clerk/express", () => ({ getAuth: () => ({ userId: null }) }));

import { pool } from "@workspace/db";
import evidenceRouter from "../evidence.js";

const enabled = Boolean(process.env.EVIDENCE_INTEGRATION_DATABASE_URL);
const SERVICE_TOKEN = "evidence-integration-service-token-000001";
const app = express();
app.use(express.json());
app.use(evidenceRouter);
const auth = { Authorization: `Bearer ${SERVICE_TOKEN}` };

beforeAll(() => { process.env.EVIDENCE_SERVICE_TOKEN = SERVICE_TOKEN; });

describe.runIf(enabled)("Evidence Explorer PostgreSQL integration", () => {
  it("rejects spoofable user headers", async () => {
    const response = await request(app).get("/intelligence/evidence/validation-board").set("X-User-Id", "admin");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("STRICT_AUTH_REQUIRED");
  });

  it("preserves WRN and PKMYT1 retrieval-only boundaries", async () => {
    for (const [target, expected] of [["WRN", 39], ["PKMYT1", 7]] as const) {
      const response = await request(app).get(`/intelligence/evidence/targets/${target}`).set(auth);
      expect(response.status).toBe(200);
      expect(response.body.target_association_state).toBe("QUERY_RETRIEVAL_ONLY_LINKAGE_UNVERIFIED");
      expect(response.body.aacr_abstract_linkage_state).toBe("LINKAGE_UNVERIFIED");
      expect(response.body.studies).toHaveLength(expected);
      expect(response.body.studies.every((study: any) => study.status_chip === "LINKAGE_UNVERIFIED")).toBe(true);
      expect(response.body.studies.every((study: any) => study.registry_facts.every((fact: any) => Boolean(fact.receipt_id)))).toBe(true);
    }
  });

  it("keeps registry facts and abstract linkage separate", async () => {
    const row = await pool.query(`SELECT nct_id FROM aacr_target_search_results ORDER BY nct_id LIMIT 1`);
    const nctId = row.rows[0].nct_id;
    const response = await request(app).get(`/intelligence/evidence/trials/${nctId}`).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.status_chip).toBe("VERIFIED_REGISTRY_FACT");
    expect(response.body.boundary).toMatch(/separate states/i);
    expect(response.body.registry_facts.length).toBeGreaterThan(0);
    expect(response.body.registry_facts.every((fact: any) => fact.claim_eligible && fact.receipt_id)).toBe(true);
  });

  it("returns a receipt trace for every ambiguous linkage", async () => {
    const rows = await pool.query(`SELECT receipt_id FROM aacr_trial_linkages WHERE linkage_state='AMBIGUOUS_REVIEW_REQUIRED' ORDER BY receipt_id`);
    expect(rows.rowCount).toBe(3);
    for (const row of rows.rows) {
      const response = await request(app).get(`/intelligence/evidence/traces/${row.receipt_id}`).set(auth);
      expect(response.status).toBe(200);
      expect(response.body.trace_type).toBe("LINKAGE");
      expect(response.body.linkage.linkage_state).toBe("AMBIGUOUS_REVIEW_REQUIRED");
    }
  });

  it("reports a registry 404 without inventing a study", async () => {
    const response = await request(app).get("/intelligence/evidence/trials/NCT06251793").set(auth);
    expect(response.status).toBe(404);
    expect(response.body.linkage_state).toBe("NOT_FOUND");
  });

  it("excludes test-only labels from validation readiness", async () => {
    const response = await request(app).get("/intelligence/evidence/validation-board").set(auth);
    expect(response.status).toBe(200);
    expect(response.body.human_labels).toBe(0);
    expect(response.body.test_only_labels).toBeGreaterThanOrEqual(0);
    expect(response.body.model_field_performance).toBe("NOT_AVAILABLE_UNTIL_GOLD_LABELS");
    expect(response.body.calibration_metrics).toBe("NOT_AVAILABLE_UNTIL_GOLD_LABELS");
  });

  it("blocks all distribution bypass channels", async () => {
    for (const channel of ["share", "pdf", "email", "bulk-download", "stale-export"]) {
      const response = await request(app).post(`/intelligence/evidence/${channel}`).set(auth).send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("DISTRIBUTION_DISABLED");
      expect(response.body.lifecycle_status).toBe("EXTERNAL_NOT_AUTHORIZED");
    }
  });
});
