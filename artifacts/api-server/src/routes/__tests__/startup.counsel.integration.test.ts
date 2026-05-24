/**
 * startup.counsel.integration.test.ts
 *
 * Endpoint-level integration tests — not unit tests.
 * Exercises the full request/response cycle through the route handlers.
 *
 * 12 cases. All must pass. Zero skips.
 *
 * CA_NONCOMPETE_VOID reachability note:
 *   On the initial draft path, the template correctly omits non_solicitation/non_compete
 *   for CA jurisdiction. CA_NONCOMPETE_VOID is a revision-path guard only — it fires
 *   when a prohibited section is present in the draft, which can only happen via /revise.
 *   Case 2 therefore asserts CA_MORAL_RIGHTS (which fires on clean CA contractor drafts),
 *   not CA_NONCOMPETE_VOID.
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import draftRouter from "../legal.draft.addendum";
import {
  issueDraftReceipt,
  hashText,
  type DraftIntake,
} from "../../lib/draftReceiptEngine";

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(draftRouter);

const SECRET = "test-secret-v0";

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToken(
  overrides: Partial<{
    draft_id: string;
    expires_at: string;
    intake: DraftIntake;
  }> = {},
): string {
  const intake: DraftIntake = overrides.intake ?? {
    doc_class: "co_founder_agreement",
    jurisdiction: "DE",
    parties: [
      { name: "Alice Chen", role: "co_founder" },
      { name: "Bob Park", role: "co_founder" },
    ],
    equity: { split: { "Alice Chen": 50, "Bob Park": 50 }, vesting_years: 4, cliff_months: 12 },
  };
  const draft_id = overrides.draft_id ?? "00000000-0000-0000-0000-000000000001";
  const full_text = "test";

  // Build the receipt payload manually so we can override expires_at
  const receipt = {
    receipt_id: "test-receipt-id",
    draft_id,
    doc_class: intake.doc_class,
    draft_hash: hashText(full_text),
    intake_hash: hashText(JSON.stringify(intake)),
    template_version: "v1",
    clause_library_version: "v1",
    verifier_version: "v1",
    governance_artifact_status: "draft_pending_approval",
    issued_at: new Date().toISOString(),
    expires_at: overrides.expires_at ?? new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    parent_receipt_id: null,
  };

  const crypto = require("crypto");
  const payload = JSON.stringify(receipt);
  const sig = crypto.createHmac("sha256", SECRET).update(payload, "utf8").digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64");
}

// ── Case 1: Happy path — co_founder_agreement, DE, all fields ─────────────────
describe("Case 1 — co_founder_agreement DE all fields", () => {
  it("returns 200 with draft_pending_approval and expected flags", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        equity: {
          split: { "Alice Chen": 50, "Bob Park": 50 },
          vesting_years: 4,
          cliff_months: 12,
          acceleration: "single",
        },
        ip: { scope: "broad", prior_inventions: ["personal blog engine"] },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("draft_pending_approval");

    const sectionMap: string[] = res.body.section_map;
    // All 11 required sections present
    for (const s of [
      "preamble", "equity_split", "vesting_schedule", "election_83b",
      "ip_assignment", "roles_and_responsibilities", "decision_making",
      "deadlock_resolution", "transfer_restrictions", "termination_and_buyout",
      "governing_law",
    ]) {
      expect(sectionMap).toContain(s);
    }
    // Optional sections injected
    expect(sectionMap).toContain("acceleration_clause");
    expect(sectionMap).toContain("non_solicitation");

    // No placeholder leaks
    expect(res.body.draft.full_text).not.toContain("[PLACEHOLDER:");

    // Expected jurisdiction flags
    const flagIds: string[] = res.body.verifier.jurisdiction_escalations.map(
      (f: { flag_id: string }) => f.flag_id,
    );
    expect(flagIds).toContain("DE_BOARD_APPROVAL");
    expect(flagIds).toContain("SECTION_83B_TIMING_WARNING");

    // Trace
    expect(res.body.draft_receipt_token).toBeTruthy();
    expect(res.body.trace.model_used).toBeNull();
    expect(res.body.trace.model_clause_rewrite).toBe(false);
  });
});

// ── Case 2: Happy path — contractor_ip_assignment, CA ─────────────────────────
describe("Case 2 — contractor_ip_assignment CA", () => {
  it("omits non_solicitation/non_compete and fires CA_MORAL_RIGHTS", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "contractor_ip_assignment",
        jurisdiction: "CA",
        parties: [
          { name: "Riya Desai", role: "contractor" },
          { name: "Acme Inc.", role: "company" },
        ],
        ip: { scope: "work_product_only" },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("draft_pending_approval");

    const sectionMap: string[] = res.body.section_map;
    expect(sectionMap).not.toContain("non_solicitation");
    expect(sectionMap).not.toContain("non_compete");

    const flagIds: string[] = res.body.verifier.jurisdiction_escalations.map(
      (f: { flag_id: string }) => f.flag_id,
    );
    expect(flagIds).toContain("CA_MORAL_RIGHTS");

    expect(res.body.draft.full_text).not.toContain("[PLACEHOLDER:");
  });
});

// ── Case 3: Happy path — advisor_agreement, DE ────────────────────────────────
describe("Case 3 — advisor_agreement DE", () => {
  it("includes equity sections, omits acceleration_clause, fires DE_BOARD_APPROVAL", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "advisor_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Marcus Webb", role: "advisor" },
          { name: "Nexus Labs Inc.", role: "company" },
        ],
        equity: { vesting_years: 2, cliff_months: 6, acceleration: "none" },
        advisory: {
          equity_pct: 0.25,
          services_description: "strategic introductions and go-to-market advisory",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("draft_pending_approval");

    const sectionMap: string[] = res.body.section_map;
    expect(sectionMap).toContain("equity_compensation");
    expect(sectionMap).toContain("vesting_schedule");
    expect(sectionMap).not.toContain("acceleration_clause");

    const flagIds: string[] = res.body.verifier.jurisdiction_escalations.map(
      (f: { flag_id: string }) => f.flag_id,
    );
    expect(flagIds).toContain("DE_BOARD_APPROVAL");
  });
});

// ── Case 4: Missing-info path — equity.vesting_years absent ───────────────────
describe("Case 4 — missing equity.vesting_years", () => {
  it("applies default, populates assumptions, no placeholder leak", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        equity: {
          split: { "Alice Chen": 50, "Bob Park": 50 },
          // vesting_years intentionally omitted
          cliff_months: 12,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("draft_pending_approval");

    const assumptions: string[] = res.body.assumptions;
    expect(assumptions.some((a) => a.toLowerCase().includes("vesting"))).toBe(true);

    expect(res.body.draft.full_text).not.toContain("[PLACEHOLDER:");
    expect(res.body.verifier.template_failures).toHaveLength(0);
  });
});

// ── Case 5: Conflict — cliff_months >= vesting_years * 12 ─────────────────────
describe("Case 5 — cliff_months >= vesting_years * 12", () => {
  it("returns needs_revision with CLIFF_EXCEEDS_TOTAL blocking", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        equity: {
          split: { "Alice Chen": 50, "Bob Park": 50 },
          vesting_years: 4,
          cliff_months: 48, // 48 >= 4*12 = 48 → triggers conflict
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("needs_revision");
    expect(res.body.governance.escalation_required).toBe(true);

    const conflicts: Array<{ conflict_id: string; severity: string }> =
      res.body.verifier.legal_conflicts;
    const cliff = conflicts.find((c) => c.conflict_id === "CLIFF_EXCEEDS_TOTAL");
    expect(cliff).toBeDefined();
    expect(cliff?.severity).toBe("blocking");
  });
});

// ── Case 6: Conflict — equity split sums to 90 ────────────────────────────────
// Note: Case 6 uses EQUITY_SPLIT_NOT_100 (split sums to 90, not 100).
// This is intentionally different from Case 2 which tests CA_MORAL_RIGHTS.
describe("Case 6 — equity split sums to 90 (EQUITY_SPLIT_NOT_100)", () => {
  it("returns needs_revision with EQUITY_SPLIT_NOT_100 blocking", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        equity: {
          split: { "Alice Chen": 50, "Bob Park": 40 }, // sums to 90
          vesting_years: 4,
          cliff_months: 12,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.governance.artifact_status).toBe("needs_revision");
    expect(res.body.governance.escalation_required).toBe(true);

    const conflicts: Array<{ conflict_id: string; severity: string }> =
      res.body.verifier.legal_conflicts;
    const splitConflict = conflicts.find((c) => c.conflict_id === "EQUITY_SPLIT_NOT_100");
    expect(splitConflict).toBeDefined();
    expect(splitConflict?.severity).toBe("blocking");
  });
});

// ── Case 7: Revision loop — "change vesting to 3yr/1yr" ──────────────────────
describe("Case 7 — revision loop: change vesting to 3yr/1yr", () => {
  it("returns revision_number 1, new draft_id, parent_receipt_id set", async () => {
    // Step A: initial draft
    const draftRes = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        equity: {
          split: { "Alice Chen": 50, "Bob Park": 50 },
          vesting_years: 4,
          cliff_months: 12,
        },
      });

    expect(draftRes.status).toBe(200);
    const originalDraftId: string = draftRes.body.draft_id;
    const token: string = draftRes.body.draft_receipt_token;

    // Step B: revise
    const reviseRes = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: token,
        revision_instruction: "change vesting to 3yr/1yr",
      });

    expect(reviseRes.status).toBe(200);
    expect(reviseRes.body.revision_number).toBe(1);
    expect(reviseRes.body.parent_receipt_id).toBeTruthy();
    expect(reviseRes.body.draft_id).not.toBe(originalDraftId);

    // Vesting section should reflect 3yr
    const vestingSection = reviseRes.body.draft.sections.find(
      (s: { section_id: string }) => s.section_id === "vesting_schedule",
    );
    expect(vestingSection).toBeDefined();
    expect(vestingSection.body).toMatch(/3/); // body contains "3" year reference
  });
});

// ── Case 8: Tampered receipt token ────────────────────────────────────────────
describe("Case 8 — tampered receipt token", () => {
  it("returns 401", async () => {
    const validToken = makeToken();
    // Flip one character in the middle of the token
    const chars = validToken.split("");
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === "A" ? "B" : "A";
    const tampered = chars.join("");

    const res = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: tampered,
        revision_instruction: "change vesting to 3yr/1yr",
      });

    expect(res.status).toBe(401);
  });
});

// ── Case 9: Expired receipt token ─────────────────────────────────────────────
describe("Case 9 — expired receipt token", () => {
  it("returns 401", async () => {
    const expiredToken = makeToken({
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1 second in the past
    });

    const res = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: expiredToken,
        revision_instruction: "change vesting to 3yr/1yr",
      });

    expect(res.status).toBe(401);
  });
});

// ── Case 10: draft_id not in store ────────────────────────────────────────────
describe("Case 10 — draft_id not in store", () => {
  it("returns 404", async () => {
    const unknownDraftToken = makeToken({
      draft_id: "ffffffff-ffff-ffff-ffff-ffffffffffff", // valid UUID, not in store
    });

    const res = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: unknownDraftToken,
        revision_instruction: "change vesting to 3yr/1yr",
      });

    expect(res.status).toBe(404);
  });
});

// ── Case 11: Invalid doc_class ────────────────────────────────────────────────
describe("Case 11 — invalid doc_class", () => {
  it("returns 400", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "partnership_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice", role: "partner" },
          { name: "Bob", role: "partner" },
        ],
      });

    expect(res.status).toBe(400);
  });
});

// ── Case 12: allow_model_clause_rewrite: true ─────────────────────────────────
describe("Case 12 — allow_model_clause_rewrite: true", () => {
  it("returns 501", async () => {
    const res = await request(app)
      .post("/v1/legal/draft")
      .send({
        doc_class: "co_founder_agreement",
        jurisdiction: "DE",
        parties: [
          { name: "Alice Chen", role: "co_founder" },
          { name: "Bob Park", role: "co_founder" },
        ],
        allow_model_clause_rewrite: true,
      });

    expect(res.status).toBe(501);
  });
});
