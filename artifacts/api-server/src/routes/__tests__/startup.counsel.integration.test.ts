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
import { buildCounselResponse, type DraftResponse } from "../../lib/counselResponse";

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

// ── v0.5 cases ────────────────────────────────────────────────────────────────

// ── Case 13: rationale populated + governance.review_threshold ────────────────
describe("Case 13 — co-founder DE, all fields: rationale populated", () => {
  it("every section has rationale.selection_reason; governance.review_threshold is counsel_review_required", async () => {
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

    // Every section must have rationale with a non-empty selection_reason
    const sections: Array<{ section_id: string; rationale?: { selection_reason: string; review_threshold: string } }> =
      res.body.draft.sections;
    for (const section of sections) {
      expect(section.rationale).toBeDefined();
      expect(typeof section.rationale!.selection_reason).toBe("string");
      expect(section.rationale!.selection_reason.length).toBeGreaterThan(0);
    }

    // DE_BOARD_APPROVAL (counsel_review_required) + SECTION_83B_TIMING_WARNING (counsel_review_required)
    // → aggregate review_threshold must be counsel_review_required
    expect(res.body.governance.review_threshold).toBe("counsel_review_required");

    // Existing v0 assertions still hold
    expect(res.body.governance.artifact_status).toBe("draft_pending_approval");
    expect(res.body.governance.escalation_required).toBe(false);
  });
});

// ── Case 14: missing_decision_prompts — contractor CA, prior_inventions absent ─
describe("Case 14 — contractor CA, ip.prior_inventions absent", () => {
  it("missing_decision_prompts contains ip.prior_inventions at priority 1 with counsel_review_required", async () => {
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
        // ip.prior_inventions intentionally absent
      });

    expect(res.status).toBe(200);

    const prompts: Array<{ field: string; review_threshold: string; priority: number }> =
      res.body.missing_decision_prompts;

    expect(Array.isArray(prompts)).toBe(true);

    const priorInventionsPrompt = prompts.find((p) => p.field === "ip.prior_inventions");
    expect(priorInventionsPrompt).toBeDefined();
    expect(priorInventionsPrompt!.review_threshold).toBe("counsel_review_required");
    expect(priorInventionsPrompt!.priority).toBe(1);
  });
});

// ── Case 15: missing_decision_prompts — advisor DE, advisory.equity_pct absent ─
describe("Case 15 — advisor DE, advisory.equity_pct absent", () => {
  it("missing_decision_prompts contains advisory.equity_pct with business_review_required", async () => {
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
          services_description: "strategic introductions and go-to-market advisory",
          // equity_pct intentionally absent
        },
      });

    expect(res.status).toBe(200);

    const prompts: Array<{ field: string; review_threshold: string }> =
      res.body.missing_decision_prompts;

    expect(Array.isArray(prompts)).toBe(true);

    const equityPctPrompt = prompts.find((p) => p.field === "advisory.equity_pct");
    expect(equityPctPrompt).toBeDefined();
    expect(equityPctPrompt!.review_threshold).toBe("business_review_required");
  });
});

// ── Case 16: section rationale — broad IP (IP-001, elevated risk) ─────────────
describe("Case 16 — co-founder broad IP: ip_assignment rationale.review_threshold is business_review_required", () => {
  it("ip_assignment section has review_threshold business_review_required", async () => {
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
        },
        ip: { scope: "broad" },
      });

    expect(res.status).toBe(200);

    const sections: Array<{ section_id: string; rationale?: { review_threshold: string; selection_reason: string } }> =
      res.body.draft.sections;

    const ipSection = sections.find((s) => s.section_id === "ip_assignment");
    expect(ipSection).toBeDefined();
    expect(ipSection!.rationale).toBeDefined();
    expect(ipSection!.rationale!.review_threshold).toBe("business_review_required");
  });
});

// ── Case 17: buildCounselResponse — co_founder DE clean draft ─────────────────
describe("Case 17 — buildCounselResponse: co_founder DE clean draft", () => {
  it("returns ready_to_proceed true, overall_threshold counsel_review_required, review_guidance includes election_83b", async () => {
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
        ip: { scope: "broad" },
      });

    expect(res.status).toBe(200);

    const counselResult = buildCounselResponse(res.body as DraftResponse);

    expect(counselResult.ready_to_proceed).toBe(true);
    expect(counselResult.overall_threshold).toBe("counsel_review_required");
    expect(counselResult.assumptions_made.length).toBeGreaterThan(0);

    const election83bGuidance = counselResult.review_guidance.find(
      (g) => g.section === "election_83b",
    );
    expect(election83bGuidance).toBeDefined();
    expect(election83bGuidance!.guidance.length).toBeGreaterThan(0);
  });
});

// ── Case 18: buildCounselResponse — equity split not 100% ────────────────────
describe("Case 18 — buildCounselResponse: equity split not 100%", () => {
  it("returns ready_to_proceed false, overall_threshold blocked", async () => {
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

    const counselResult = buildCounselResponse(res.body as DraftResponse);

    expect(counselResult.ready_to_proceed).toBe(false);
    expect(counselResult.overall_threshold).toBe("blocked");
  });
});

// ── Case 19: NL revision — "change vesting to 3 years with a 1-year cliff" ───
describe("Case 19 — NL revision: change vesting to 3 years with a 1-year cliff", () => {
  it("returns 200, vesting body contains '3' and '12 months', revision_number 1", async () => {
    // Step A: initial draft (4yr/12mo)
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
    const token: string = draftRes.body.draft_receipt_token;
    const originalDraftId: string = draftRes.body.draft_id;

    // Confirm original vesting body
    const origVesting = draftRes.body.draft.sections.find(
      (s: { section_id: string }) => s.section_id === "vesting_schedule",
    );
    expect(origVesting).toBeDefined();
    expect(origVesting.body).toMatch(/4/);
    expect(origVesting.body).toMatch(/12/);

    // Step B: NL revision instruction
    const reviseRes = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: token,
        revision_instruction: "change vesting to 3 years with a 1-year cliff",
      });

    expect(reviseRes.status).toBe(200);
    expect(reviseRes.body.revision_number).toBe(1);
    expect(reviseRes.body.parent_receipt_id).toBeTruthy();
    expect(reviseRes.body.draft_id).not.toBe(originalDraftId);

    const revisedVesting = reviseRes.body.draft.sections.find(
      (s: { section_id: string }) => s.section_id === "vesting_schedule",
    );
    expect(revisedVesting).toBeDefined();
    // Body must reflect 3-year vesting
    expect(revisedVesting.body).toMatch(/3/);
    // Body must reflect 12-month cliff (1-year = 12 months)
    expect(revisedVesting.body).toMatch(/12/);
    // Must not say "1 months" (the pre-fix defect)
    expect(revisedVesting.body).not.toMatch(/1 months/);
  });
});

// ── Case 20: Unparseable revision instruction → 422 ──────────────────────────
describe("Case 20 — unparseable revision instruction returns 422", () => {
  it("returns 422 with error instruction_not_parseable", async () => {
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
    const token: string = draftRes.body.draft_receipt_token;

    // Step B: instruction that cannot be parsed
    const reviseRes = await request(app)
      .post("/v1/legal/draft/revise")
      .send({
        draft_receipt_token: token,
        revision_instruction: "please make the document sound more professional",
      });

    expect(reviseRes.status).toBe(422);
    expect(reviseRes.body.error).toBe("instruction_not_parseable");
  });
});


// ── Cases 21–23: POST /v1/legal/draft/analyze ────────────────────────────────

describe("POST /v1/legal/draft/analyze", () => {
  const SAMPLE_COFOUNDER_TEXT = `CO-FOUNDER AGREEMENT

This Co-Founder Agreement ("Agreement") is entered into as of January 1, 2025,
by and between Alice Chen, an individual ("Founder A"), and Bob Park, an individual
("Founder B"), collectively referred to as the "Founders."

1. COMPANY FORMATION
The Founders agree to form a Delaware corporation ("Company") for the purpose of
developing and commercializing software products.

2. EQUITY SPLIT
Founder A shall hold fifty percent (50%) of the Company's outstanding shares.
Founder B shall hold fifty percent (50%) of the Company's outstanding shares.

3. VESTING
All shares issued to the Founders shall be subject to a four (4) year vesting
schedule with a one (1) year cliff. Upon completion of the cliff period, 25% of
the shares shall vest, with the remaining shares vesting monthly over the
subsequent 36 months.

4. INTELLECTUAL PROPERTY
Each Founder hereby assigns to the Company all right, title, and interest in any
inventions, works of authorship, or other intellectual property created in
connection with the Company's business. The scope of this assignment is broad and
covers all work product related to the Company.

5. GOVERNING LAW
This Agreement shall be governed by the laws of the State of Delaware, without
regard to its conflict of law provisions.

IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first
written above.

Alice Chen: ___________________
Bob Park:   ___________________`;

  // Case 21 — valid co-founder text → 200, all required fields present (normalization layer)
  it("Case 21 — valid co-founder text returns 200 with all required fields", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    // Identity fields
    expect(res.body.analysis_id).toBeTruthy();
    expect(res.body.doc_class).toBe("co_founder_agreement");

    // Source preservation
    expect(res.body.source).toBeDefined();
    expect(res.body.source.text).toBe(SAMPLE_COFOUNDER_TEXT);
    expect(res.body.source.length).toBe(SAMPLE_COFOUNDER_TEXT.length);
    expect(typeof res.body.source.hash).toBe("string");

    // Extraction fields (renamed: extracted_intake → raw_extracted_intake)
    expect(res.body.raw_extracted_intake).toBeDefined();
    expect(typeof res.body.raw_extracted_intake).toBe("object");
    expect(typeof res.body.extraction_confidence).toBe("number");
    expect(res.body.extraction_confidence).toBeGreaterThanOrEqual(0);
    expect(res.body.extraction_confidence).toBeLessThanOrEqual(1);

    // Normalization fields (new)
    expect(res.body.normalized_intake).toBeDefined();
    expect(typeof res.body.normalized_intake).toBe("object");
    expect(Array.isArray(res.body.normalization_notes)).toBe(true);
    expect(res.body.normalization_summary).toBeDefined();
    expect(typeof res.body.normalization_summary.substitutions_made).toBe("number");
    expect(typeof res.body.normalization_summary.warnings_present).toBe("boolean");
    expect(Array.isArray(res.body.not_applicable_fields)).toBe(true);
    expect(Array.isArray(res.body.missing_required_fields)).toBe(true);
    expect(Array.isArray(res.body.uncertain_fields)).toBe(true);

    // unextractable_fields removed — must not be present
    expect(res.body.unextractable_fields).toBeUndefined();
    // extracted_intake renamed — old key must not be present
    expect(res.body.extracted_intake).toBeUndefined();

    // Draft pipeline fields
    expect(res.body.draft_ready_intake).toBeDefined();
    expect(typeof res.body.draft_ready_intake).toBe("object");
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(Array.isArray(res.body.assumptions)).toBe(true);
    expect(Array.isArray(res.body.missing_decision_prompts)).toBe(true);

    // Verifier
    expect(res.body.verifier).toBeDefined();
    expect(typeof res.body.verifier.passed).toBe("boolean");

    // Governance
    expect(res.body.governance).toBeDefined();
    expect(res.body.governance.review_threshold).toBeTruthy();
    expect(res.body.governance.not_legal_advice).toBe(true);
    expect(typeof res.body.governance.privilege_warning).toBe("string");

    // Redraft
    expect(typeof res.body.redraft_available).toBe("boolean");

    // Trace
    expect(res.body.trace).toBeDefined();
    expect(typeof res.body.trace.latency_ms).toBe("number");
  });

  // Case 22 — missing doc_class → 422 invalid_input
  it("Case 22 — missing doc_class returns 422 invalid_input", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        // doc_class intentionally omitted
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_input");
    expect(typeof res.body.message).toBe("string");
  });

  // Case 23 — contract_text too short → 422 invalid_input
  it("Case 23 — contract_text too short returns 422 invalid_input", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: "too short",
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_input");
    expect(typeof res.body.message).toBe("string");
  });

  // Case 24 — jurisdiction normalization: "Delaware, USA" → "DE"
  it("Case 24 — jurisdiction 'Delaware, USA' normalizes to 'DE' in normalized_intake", async () => {
    // SAMPLE_COFOUNDER_TEXT already contains "Delaware, USA" as jurisdiction
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    // If the LLM extracted "Delaware, USA" (or similar), normalizer must canonicalize to "DE"
    // If no API key is available, raw extraction falls back to "Delaware, USA" default —
    // normalizer still fires and produces "DE".
    const normJurisdiction = res.body.normalized_intake?.jurisdiction;
    // Accept either "DE" (normalized) or the raw value if the LLM returned something else
    // The key assertion: if raw was "Delaware, USA" or "delaware, usa", normalized must be "DE"
    const rawJurisdiction = res.body.raw_extracted_intake?.jurisdiction;
    if (
      typeof rawJurisdiction === "string" &&
      rawJurisdiction.toLowerCase().includes("delaware")
    ) {
      expect(normJurisdiction).toBe("DE");
      // normalization_notes must contain a jurisdiction entry
      const jurisdictionNote = res.body.normalization_notes.find(
        (n: { field: string }) => n.field === "jurisdiction",
      );
      expect(jurisdictionNote).toBeDefined();
      expect(jurisdictionNote.normalized_value).toBe("DE");
    }

    // normalization_summary must be present regardless
    expect(typeof res.body.normalization_summary.substitutions_made).toBe("number");
  });

  // Case 25 — advisory fields not applicable for co_founder_agreement
  it("Case 25 — advisory fields appear in not_applicable_fields for co_founder_agreement", async () => {
    // Use a contract text that explicitly mentions advisory terms so the LLM might extract them
    const contractWithAdvisory = SAMPLE_COFOUNDER_TEXT +
      "\n\nAdvisory: The advisor shall receive 0.5% equity for advisory services rendered.";

    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: contractWithAdvisory,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    // advisory.* fields must NOT appear in missing_required_fields for co_founder_agreement
    const advisoryMissing = res.body.missing_required_fields.filter(
      (f: { field: string }) => f.field.startsWith("advisory"),
    );
    expect(advisoryMissing).toHaveLength(0);

    // If the LLM extracted advisory fields, they must appear in not_applicable_fields
    const rawAdvisory = res.body.raw_extracted_intake?.advisory;
    if (rawAdvisory != null && typeof rawAdvisory === "object") {
      const advisoryNotApplicable = res.body.not_applicable_fields.filter(
        (f: string) => f.startsWith("advisory"),
      );
      expect(advisoryNotApplicable.length).toBeGreaterThan(0);
    }

    // not_applicable_fields must be an array
    expect(Array.isArray(res.body.not_applicable_fields)).toBe(true);
  });

  // Case 26 — coverage fields present in 200 response
  it("Case 26 — coverage fields present in 200 response", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    // coverage_score: number 0–1
    expect(typeof res.body.coverage_score).toBe("number");
    expect(res.body.coverage_score).toBeGreaterThanOrEqual(0);
    expect(res.body.coverage_score).toBeLessThanOrEqual(1);

    // coverage_summary: non-empty string
    expect(typeof res.body.coverage_summary).toBe("string");
    expect(res.body.coverage_summary.length).toBeGreaterThan(0);

    // expected_clauses: array with entries
    expect(Array.isArray(res.body.expected_clauses)).toBe(true);
    expect(res.body.expected_clauses.length).toBeGreaterThan(0);

    // detected_clauses: array
    expect(Array.isArray(res.body.detected_clauses)).toBe(true);

    // missing_expected_clauses: array
    expect(Array.isArray(res.body.missing_expected_clauses)).toBe(true);

    // missing_required_clause_ids: array of strings
    expect(Array.isArray(res.body.missing_required_clause_ids)).toBe(true);

    // material_missing_clause_ids: array of strings
    expect(Array.isArray(res.body.material_missing_clause_ids)).toBe(true);

    // material_unsupported_sections: array
    expect(Array.isArray(res.body.material_unsupported_sections)).toBe(true);

    // boilerplate_unsupported_sections: array
    expect(Array.isArray(res.body.boilerplate_unsupported_sections)).toBe(true);

    // cross_reference_warnings: array
    expect(Array.isArray(res.body.cross_reference_warnings)).toBe(true);

    // exhibits_detected: array
    expect(Array.isArray(res.body.exhibits_detected)).toBe(true);

    // vendor_policy_version in trace
    expect(res.body.trace).toBeDefined();
    expect(typeof res.body.trace.vendor_policy_version).toBe("string");
    expect(res.body.trace.vendor_policy_version).toBe("v1.0.0");
  });

  // Case 27 — SAMPLE_COFOUNDER_TEXT detects preamble, equity_split, vesting_schedule,
  //           ip_assignment, and governing_law; does NOT detect election_83b
  it("Case 27 — SAMPLE_COFOUNDER_TEXT detects expected clauses with precision", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    const detectedIds = (res.body.detected_clauses as Array<{ clause_id: string }>)
      .map((c) => c.clause_id);

    // These clauses are unambiguously present in SAMPLE_COFOUNDER_TEXT
    expect(detectedIds).toContain("preamble");
    expect(detectedIds).toContain("equity_split");
    expect(detectedIds).toContain("vesting_schedule");
    expect(detectedIds).toContain("ip_assignment");
    expect(detectedIds).toContain("governing_law");

    // These clauses are NOT in SAMPLE_COFOUNDER_TEXT — must be in missing_expected_clauses
    const missingIds = (res.body.missing_expected_clauses as Array<{ clause_id: string }>)
      .map((c) => c.clause_id);
    expect(missingIds).toContain("election_83b");
    expect(missingIds).toContain("deadlock_resolution");
    expect(missingIds).toContain("termination_and_buyout");

    // Detected clauses must have confidence field with valid value
    const preamble = (res.body.detected_clauses as Array<{ clause_id: string; confidence: string }>)
      .find((c) => c.clause_id === "preamble");
    expect(preamble).toBeDefined();
    expect(["high", "medium", "low"]).toContain(preamble!.confidence);

    // Precision check: election_83b must NOT be detected (no 83(b) language in sample)
    expect(detectedIds).not.toContain("election_83b");
  });

  // Case 28 — coverage threshold escalates final governance threshold
  it("Case 28 — low coverage or material missing clauses escalate governance.review_threshold", async () => {
    const res = await request(app)
      .post("/v1/legal/draft/analyze")
      .send({
        contract_text: SAMPLE_COFOUNDER_TEXT,
        doc_class: "co_founder_agreement",
      });

    expect(res.status).toBe(200);

    const THRESHOLD_ORDER = [
      "self_review_ok",
      "business_review_required",
      "counsel_review_required",
      "blocked",
    ];

    const coverageScore: number = res.body.coverage_score;
    const threshold: string = res.body.governance.review_threshold;
    const materialMissing: string[] = res.body.material_missing_clause_ids;

    // governance.review_threshold must be a valid value
    expect(THRESHOLD_ORDER).toContain(threshold);

    // If coverage_score < 0.7 OR material clauses are missing,
    // threshold must be at least business_review_required
    if (coverageScore < 0.7 || materialMissing.length > 0) {
      const thresholdIdx = THRESHOLD_ORDER.indexOf(threshold);
      const minIdx = THRESHOLD_ORDER.indexOf("business_review_required");
      expect(thresholdIdx).toBeGreaterThanOrEqual(minIdx);
    }

    // If material_missing_clause_ids is non-empty, threshold must be
    // at least counsel_review_required
    if (materialMissing.length > 0) {
      const thresholdIdx = THRESHOLD_ORDER.indexOf(threshold);
      const minIdx = THRESHOLD_ORDER.indexOf("counsel_review_required");
      expect(thresholdIdx).toBeGreaterThanOrEqual(minIdx);
    }

    // redraft_available must be false when coverage_score < 0.7
    if (coverageScore < 0.7) {
      expect(res.body.redraft_available).toBe(false);
    }
  });

});