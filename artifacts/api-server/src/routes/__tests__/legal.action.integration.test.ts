/**
 * legal.action.integration.test.ts
 *
 * Integration tests for Phase 2A: POST /api/v1/legal/matter and POST /api/v1/legal/action
 *
 * Strategy:
 *   - Import the real Express app from src/app.ts
 *   - Use supertest to make real HTTP requests against the actual route handlers
 *   - Mock @workspace/db (pool) to avoid needing DATABASE_URL
 *   - Mock global.fetch to avoid needing API keys (GROQ, OpenRouter)
 *   - SESSION_SECRET is set in beforeAll via process.env
 *
 * What these tests prove (that Python logic receipts cannot):
 *   - Route is registered and reachable (not 404)
 *   - Middleware chain executes correctly (JSON parsing, CORS, error handler)
 *   - Import graph resolves without runtime errors
 *   - Response serialization matches the documented shape
 *   - DB pool.query is called for action_run (hard-fail path)
 *   - HMAC signing/verification works end-to-end through the real TypeScript code
 *
 * Cases covered (matching verification sprint receipts 1–13):
 *   1.  POST /matter success — receipt_token present in response
 *   2.  POST /action draft_letter success — full response shape
 *   3.  POST /action generate_clause_pack success — impact_tier = action_triggering
 *   4.  POST /action tampered receipt_token — 401
 *   4b. POST /action expired receipt_token — 401
 *   5.  POST /action original_text hash mismatch — 400
 *   6.  POST /action user_instruction > 500 chars — 400
 *   7.  POST /action DB log failure — 500
 *   8.  artifact_status = draft_pending_approval (clean verification)
 *   9.  artifact_status = needs_revision (unresolved issues)
 *   10. artifact_status = blocked (human_only_blocker present)
 *   11. /matter text too short — 400
 *   12. /action missing receipt_token — 400
 *   13. /action invalid action_type — 400
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

// ── Mock @workspace/db BEFORE importing app ───────────────────────────────────
// This prevents the pool constructor from throwing when DATABASE_URL is absent.
const mockPoolQuery = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: {
    query: mockPoolQuery,
    connect: vi.fn().mockResolvedValue({
      query: mockPoolQuery,
      release: vi.fn(),
    }),
  },
  db: {},
}));

// ── Import app AFTER mocks are registered ─────────────────────────────────────
// Dynamic import ensures vi.mock hoisting has taken effect.
let app: any;

// ── Controlled model response factory ────────────────────────────────────────
// Returns a fetch mock that produces a valid JSON model response.
function makeFetchMock(jsonPayload: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(jsonPayload),
          },
        },
      ],
    }),
    text: async () => JSON.stringify(jsonPayload),
  });
}

// ── Intake model response (5-way classification) ──────────────────────────────
const INTAKE_RESPONSE = {
  matter_type: "cofounder",
  confidence: 0.92,
  routing_target: "cofounder_specialist",
  reasoning: "Agreement between founders with equity and IP terms",
  model_used: "gpt-oss-20b",
  fallback_used: false,
};

// ── Cofounder specialist response ─────────────────────────────────────────────
const SPECIALIST_RESPONSE = {
  risk_flags: [
    { id: "IP_SCOPE_AMBIGUOUS", risk_level: "high", description: "IP assignment scope does not exclude prior inventions" },
  ],
  missing_clauses: [],
  blocking_issues: ["MISSING_VESTING_SCHEDULE"],
  overall_risk: "high",
  next_steps: ["Add vesting schedule"],
  draft_clauses: [],
  rag_entries_used: 0,
};

// ── Draft letter model response ───────────────────────────────────────────────
const DRAFT_LETTER_RESPONSE = {
  title: "Founder Agreement Revision Request",
  body: "DRAFT — FOR ATTORNEY REVIEW ONLY — NOT LEGAL ADVICE\n\nDear Founders,\n\n1. MISSING_VESTING_SCHEDULE: We recommend adding a standard 4-year vesting schedule with a 1-year cliff.\n\nSincerely,\n[PLACEHOLDER: Company Name] Legal Team",
  placeholders: ["[PLACEHOLDER: Company Name]"],
};

// ── Draft letter with human-only blocker (for blocked state) ─────────────────
const DRAFT_LETTER_WITH_BLOCKER = {
  title: "Founder Agreement Revision Request",
  body: "DRAFT — FOR ATTORNEY REVIEW ONLY — NOT LEGAL ADVICE\n\n1. MISSING_VESTING_SCHEDULE: Addressed.\n2. ENTITY_TYPE: [HUMAN_ONLY_BLOCKER: Requires attorney and tax advisor input]",
  placeholders: [],
};

// ── Clause pack model response ────────────────────────────────────────────────
const CLAUSE_PACK_RESPONSE = {
  clauses: [
    {
      clause_id: "CL-001",
      issue_id: "MISSING_VESTING_SCHEDULE",
      title: "Equity Vesting Schedule",
      body: "Each Founder's equity shall vest over four (4) years with a one (1) year cliff.",
      source: "generated",
    },
  ],
};

// ── Verification: clean pass (draft_pending_approval) ────────────────────────
const VERIFY_CLEAN = {
  issue_coverage: [
    { issue_id: "MISSING_VESTING_SCHEDULE", status: "addressed", evidence: "Draft explicitly addresses vesting" },
    { issue_id: "IP_SCOPE_AMBIGUOUS", status: "addressed", evidence: "Draft addresses IP scope" },
  ],
  contradictions: [],
  unsupported_citations: [],
  invented_facts: [],
  generic_clauses: [],
  passed: true,
};

// ── Verification: unresolved issues (needs_revision) ─────────────────────────
const VERIFY_UNRESOLVED = {
  issue_coverage: [
    { issue_id: "MISSING_VESTING_SCHEDULE", status: "unresolved", evidence: "Draft does not address vesting" },
    { issue_id: "IP_SCOPE_AMBIGUOUS", status: "addressed", evidence: "Addressed" },
  ],
  contradictions: ["draft says 2-year cliff but original says no vesting"],
  unsupported_citations: [],
  invented_facts: [],
  generic_clauses: [],
  passed: false,
};

// ── Verification: human-only blocker (blocked) ────────────────────────────────
const VERIFY_BLOCKED = {
  issue_coverage: [
    { issue_id: "MISSING_VESTING_SCHEDULE", status: "addressed", evidence: "Addressed" },
    { issue_id: "IP_SCOPE_AMBIGUOUS", status: "human_only_blocker", evidence: "Requires attorney review" },
  ],
  contradictions: [],
  unsupported_citations: [],
  invented_facts: [],
  generic_clauses: [],
  passed: true,
};

// ── Sample text ───────────────────────────────────────────────────────────────
const SAMPLE_TEXT = `FOUNDER AGREEMENT between Alice Chen and Bob Park.
Equity: Alice 60%, Bob 40%. No vesting schedule specified.
IP assigned to company. Entity type undetermined.
Governing law: Delaware. Termination: 30 days notice.
This agreement is entered into as of January 1, 2025.`;

// ── Test setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-for-integration-tests";
  process.env.DATABASE_URL = "postgresql://mock:mock@localhost/mock"; // satisfies pool constructor
  process.env.NODE_ENV = "test";
  // No CLERK_SECRET_KEY → Clerk middleware disabled (legal routes work without auth)

  // Dummy API keys — must be set BEFORE app import so getProviderConfig() returns a
  // non-empty string and callModelWithFallback() reaches fetch() instead of skipping
  // the entire chain and throwing "API key env var not set".
  // global.fetch is mocked per-test to intercept the actual HTTP calls.
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key-1";
  process.env.OPENROUTER_API_KEY_2 = "test-openrouter-key-2";

  // Import app after env vars are set
  const mod = await import("../../app.js");
  app = mod.default;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
  // Default: DB pool.query succeeds (returns empty result)
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Helper: get a valid receipt_token from /matter ────────────────────────────
async function getMatterReceipt(text = SAMPLE_TEXT): Promise<{ receipt_token: string; matter_id: string }> {
  // Mock: intake call + specialist call (2 fetch calls)
  (global.fetch as any) = vi.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(INTAKE_RESPONSE) } }] }),
    })
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(SPECIALIST_RESPONSE) } }] }),
    });

  const res = await request(app)
    .post("/api/v1/legal/matter")
    .send({ text, tenant_id: "test-tenant" })
    .set("Content-Type", "application/json");

  expect(res.status).toBe(200);
  expect(res.body.receipt_token).toBeTruthy();
  return { receipt_token: res.body.receipt_token, matter_id: res.body.matter_id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/legal/matter", () => {
  it("receipt 1 — success: returns receipt_token, matter_id, intake, specialist_output, governance_decision", async () => {
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(INTAKE_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(SPECIALIST_RESPONSE) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/matter")
      .send({ text: SAMPLE_TEXT, tenant_id: "test-tenant" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);

    // receipt_token must be present and non-empty
    expect(res.body.receipt_token).toBeTruthy();
    expect(typeof res.body.receipt_token).toBe("string");
    expect(res.body.receipt_token.length).toBeGreaterThan(100);

    // matter_id must be a UUID
    expect(res.body.matter_id).toMatch(/^[0-9a-f-]{36}$/);

    // Required top-level fields
    expect(res.body.intake).toBeDefined();
    expect(res.body.specialist_output).toBeDefined();
    expect(res.body.governance_decision).toBeDefined();
    expect(res.body.trace).toBeDefined();

    // receipt_token must be a valid base64 HMAC envelope
    const envelope = JSON.parse(Buffer.from(res.body.receipt_token, "base64").toString());
    expect(envelope.payload).toBeTruthy();
    expect(envelope.sig).toBeTruthy();
    const decoded = JSON.parse(envelope.payload);
    expect(decoded.receipt_id).toBeTruthy();
    expect(decoded.expires_at).toBeTruthy();
    expect(decoded.original_text_hash).toBeTruthy();
  });

  it("receipt 11 — text too short returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/legal/matter")
      .send({ text: "short" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text required/i);
  });
});

describe("POST /api/v1/legal/action — validation", () => {
  it("receipt 12 — missing receipt_token returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/receipt_token/i);
  });

  it("receipt 13 — invalid action_type returns 400", async () => {
    const { receipt_token } = await getMatterReceipt();

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "invalid_type" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action_type/i);
  });

  it("receipt 6 — user_instruction > 500 chars returns 400 (not truncated)", async () => {
    const { receipt_token } = await getMatterReceipt();

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        original_text: SAMPLE_TEXT,
        action_type: "draft_letter",
        user_instruction: "x".repeat(501),
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
  });
});

describe("POST /api/v1/legal/action — trust boundary", () => {
  it("receipt 4 — tampered receipt_token returns 401", async () => {
    const { receipt_token } = await getMatterReceipt();
    const tampered = receipt_token.slice(0, -10) + "AAAAAAAAAA";

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token: tampered, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/tampered|invalid/i);
  });

  it("receipt 4b — expired receipt_token returns 401", async () => {
    // Build an expired receipt manually using the same HMAC logic
    const { createHmac, createHash } = await import("crypto");
    const secret = process.env.SESSION_SECRET!;
    const issuedAt = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
    const expiresAt = new Date(issuedAt.getTime() + 4 * 60 * 60 * 1000); // expired 1h ago

    const receipt = {
      matter_id: "00000000-0000-0000-0000-000000000001",
      receipt_id: "00000000-0000-0000-0000-000000000002",
      specialist: "cofounder",
      original_text_hash: createHash("sha256").update(SAMPLE_TEXT, "utf8").digest("hex"),
      specialist_output: SPECIALIST_RESPONSE,
      governance_decision: {},
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(), // in the past
    };

    const payload = JSON.stringify(receipt);
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    const expiredToken = Buffer.from(JSON.stringify({ payload, sig })).toString("base64");

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token: expiredToken, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/tampered|invalid/i);
  });

  it("receipt 5 — original_text hash mismatch returns 400", async () => {
    const { receipt_token } = await getMatterReceipt();

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        original_text: SAMPLE_TEXT + " [MODIFIED BY CLIENT]",
        action_type: "draft_letter",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/original_text/i);
  });
});

describe("POST /api/v1/legal/action — draft_letter success", () => {
  it("receipt 2 — draft_letter: HTTP 200, full response shape, version fields in trace", async () => {
    const { receipt_token } = await getMatterReceipt();

    // Mock: draft call + verify call (2 fetch calls)
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);

    // Top-level required fields
    expect(res.body.matter_id).toBeTruthy();
    expect(res.body.action_type).toBe("draft_letter");
    expect(res.body.artifact_status).toBeDefined();
    expect(res.body.draft_artifact).toBeDefined();
    expect(res.body.issue_resolution_map).toBeDefined();
    expect(res.body.verification).toBeDefined();
    expect(res.body.governance).toBeDefined();
    expect(res.body.trace).toBeDefined();

    // draft_artifact shape
    expect(typeof res.body.draft_artifact.title).toBe("string");
    expect(typeof res.body.draft_artifact.body).toBe("string");
    expect(Array.isArray(res.body.draft_artifact.placeholders)).toBe(true);

    // governance invariants
    expect(res.body.governance.approval_required).toBe(true);
    expect(res.body.governance.human_review_required).toBe(true);
    expect(res.body.governance.not_legal_advice).toBe(true);
    expect(res.body.governance.impact_tier).toBe("decision_support");

    // version fields in trace
    expect(res.body.trace.draft_prompt_version).toBe("2a.1");
    expect(res.body.trace.verification_prompt_version).toBe("2a.1");
    expect(res.body.trace.policy_version).toBe("legal-action-v1");
    expect(res.body.trace.corpus_version).toBe("cofounder-corpus-v1");

    // issue_resolution_map: no silent drops
    expect(Array.isArray(res.body.issue_resolution_map)).toBe(true);
    expect(res.body.issue_resolution_map.length).toBeGreaterThan(0);
    for (const entry of res.body.issue_resolution_map) {
      expect(["addressed", "partially_addressed", "unresolved", "human_only_blocker"]).toContain(entry.status);
    }

    // DB log was called (hard-fail)
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO model_usage_events"),
      expect.arrayContaining(["anonymous", "action_run"]),
    );
  });
});

describe("POST /api/v1/legal/action — generate_clause_pack success", () => {
  it("receipt 3 — clause_pack: impact_tier = action_triggering, clauses array present", async () => {
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(CLAUSE_PACK_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "generate_clause_pack" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.action_type).toBe("generate_clause_pack");
    expect(res.body.governance.impact_tier).toBe("action_triggering");
    expect(Array.isArray(res.body.draft_artifact.clauses)).toBe(true);
    expect(res.body.draft_artifact.clauses.length).toBeGreaterThan(0);

    // Each clause has required fields
    for (const clause of res.body.draft_artifact.clauses) {
      expect(clause.clause_id).toBeTruthy();
      expect(clause.issue_id).toBeTruthy();
      expect(clause.title).toBeTruthy();
      expect(clause.body).toBeTruthy();
      expect(["generated", "template_only", "human_only"]).toContain(clause.source);
    }
  });
});

describe("POST /api/v1/legal/action — governance state machine", () => {
  it("receipt 8 — draft_pending_approval: passed=true, no blockers", async () => {
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.artifact_status).toBe("draft_pending_approval");
    expect(res.body.governance.escalation_required).toBe(false);
    expect(res.body.governance.approval_required).toBe(true);
  });

  it("receipt 9 — needs_revision: passed=false, unresolved issues, no human-only blockers", async () => {
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_UNRESOLVED) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.artifact_status).toBe("needs_revision");
    expect(res.body.governance.escalation_required).toBe(true);
    expect(res.body.governance.approval_required).toBe(true);
    expect(res.body.verification.unresolved_issues.length).toBeGreaterThan(0);
  });

  it("receipt 10 — blocked: human_only_blocker present (even when passed=true)", async () => {
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_WITH_BLOCKER) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_BLOCKED) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.artifact_status).toBe("blocked");
    expect(res.body.governance.escalation_required).toBe(true);
    expect(res.body.governance.approval_required).toBe(true);
    expect(res.body.verification.human_only_blockers.length).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/legal/action — DB hard-fail", () => {
  it("receipt 7 — nonce INSERT DB failure returns 500", async () => {
    // With replay prevention, the nonce INSERT is the FIRST DB call in /action.
    // A DB failure at that point (before any model call) must return 500.
    const { receipt_token } = await getMatterReceipt();

    // No fetch mock needed — DB fails before any model call
    (global.fetch as any) = vi.fn(); // should never be called

    // Force pool.query to throw on the nonce INSERT (first call)
    mockPoolQuery.mockRejectedValueOnce(new Error("connection refused: nonce insert failed"));

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/action generation failed/i);

    // fetch must NOT have been called — DB failed before model calls
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it("receipt 7b — action_run INSERT DB failure returns 500 (nonce consumed, model calls succeed)", async () => {
    // Nonce INSERT succeeds (first call), model calls succeed, action_run INSERT fails (second call).
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    // First pool.query (nonce INSERT) succeeds; second (action_run INSERT) fails
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // nonce INSERT OK
      .mockRejectedValueOnce(new Error("connection refused: model_usage_events insert failed"));

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/action generation failed/i);
  });
});

describe("POST /api/v1/legal/action — issue_resolution_map completeness", () => {
  it("AC-8: all four IssueStatus values are reachable in the map", async () => {
    // Use a specialist output with 4 issues to exercise all four statuses
    const specialistWith4Issues = {
      ...SPECIALIST_RESPONSE,
      blocking_issues: ["MISSING_VESTING_SCHEDULE", "ENTITY_TYPE_UNDETERMINED"],
      risk_flags: [
        { id: "IP_SCOPE_AMBIGUOUS", risk_level: "high", description: "IP scope ambiguous" },
        { id: "NOTICE_PERIOD_AMBIGUOUS", risk_level: "high", description: "Notice period ambiguous" },
      ],
    };

    // Get a receipt with 4 issues
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(INTAKE_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(specialistWith4Issues) } }] }),
      });

    const matterRes = await request(app)
      .post("/api/v1/legal/matter")
      .send({ text: SAMPLE_TEXT, tenant_id: "test-tenant" })
      .set("Content-Type", "application/json");

    expect(matterRes.status).toBe(200);
    const { receipt_token } = matterRes.body;

    // Verification returns all four statuses
    const verifyAllStatuses = {
      issue_coverage: [
        { issue_id: "MISSING_VESTING_SCHEDULE", status: "addressed", evidence: "Addressed" },
        { issue_id: "ENTITY_TYPE_UNDETERMINED", status: "human_only_blocker", evidence: "Requires attorney" },
        { issue_id: "IP_SCOPE_AMBIGUOUS", status: "partially_addressed", evidence: "Partially addressed" },
        { issue_id: "NOTICE_PERIOD_AMBIGUOUS", status: "unresolved", evidence: "Not addressed" },
      ],
      contradictions: [],
      unsupported_citations: [],
      invented_facts: [],
      generic_clauses: [],
      passed: false, // unresolved present
    };

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(verifyAllStatuses) } }] }),
      });

    const actionRes = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(actionRes.status).toBe(200);

    const statuses = new Set(actionRes.body.issue_resolution_map.map((e: any) => e.status));
    expect(statuses.has("addressed")).toBe(true);
    expect(statuses.has("partially_addressed")).toBe(true);
    expect(statuses.has("unresolved")).toBe(true);
    expect(statuses.has("human_only_blocker")).toBe(true);

    // No silent drops — all 4 issues must appear
    expect(actionRes.body.issue_resolution_map.length).toBe(4);
  });
});

describe("POST /api/v1/legal/action — replay prevention", () => {
  it("receipt 14 — second call with same receipt_token returns 409", async () => {
    const { receipt_token } = await getMatterReceipt();

    // First call: nonce INSERT succeeds (default mock), model calls succeed → 200
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const first = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(first.status).toBe(200);

    // Second call: simulate nonce already consumed — pool.query throws unique_violation
    mockPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );

    const second = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already consumed/i);
  });
});

describe("POST /api/v1/legal/action — action_receipt_token (Phase 2B trust anchor)", () => {
  it("receipt 15 — success response includes valid action_receipt_token with full hashes and lineage", async () => {
    const { receipt_token } = await getMatterReceipt();

    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);

    // action_receipt_token must be present and non-empty
    expect(res.body.action_receipt_token).toBeTruthy();
    expect(typeof res.body.action_receipt_token).toBe("string");
    expect(res.body.action_receipt_token.length).toBeGreaterThan(100);

    // Decode and verify the envelope structure
    const envelope = JSON.parse(Buffer.from(res.body.action_receipt_token, "base64").toString());
    expect(envelope.payload).toBeTruthy();
    expect(envelope.sig).toBeTruthy();

    // Decode the payload
    const decoded = JSON.parse(envelope.payload);

    // Required identity fields
    expect(decoded.matter_id).toBeTruthy();
    expect(decoded.action_receipt_id).toMatch(/^[0-9a-f-]{36}$/);  // UUID
    expect(decoded.action_type).toBe("draft_letter");
    expect(decoded.artifact_status).toBeDefined();

    // Full SHA-256 hashes (64 hex chars, not truncated)
    expect(decoded.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(decoded.verification_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(decoded.issue_resolution_map_hash).toMatch(/^[0-9a-f]{64}$/);

    // Lineage: original_text_hash must match what /matter would have computed
    const { createHash } = await import("crypto");
    const expectedTextHash = createHash("sha256").update(SAMPLE_TEXT, "utf8").digest("hex");
    expect(decoded.original_text_hash).toBe(expectedTextHash);

    // Version fields
    expect(decoded.draft_prompt_version).toBe("2a.1");
    expect(decoded.verification_prompt_version).toBe("2a.1");
    expect(decoded.policy_version).toBe("legal-action-v1");

    // Expiry fields
    expect(decoded.issued_at).toBeTruthy();
    expect(decoded.expires_at).toBeTruthy();
    expect(new Date(decoded.expires_at).getTime()).toBeGreaterThan(Date.now());

    // HMAC signature is valid (re-verify with test secret)
    const { createHmac } = await import("crypto");
    const expectedSig = createHmac("sha256", "test-session-secret-for-integration-tests")
      .update(envelope.payload)
      .digest("hex");
    expect(envelope.sig).toBe(expectedSig);
  });
});

// ── Helper: get a valid action_receipt_token from /action ─────────────────────
async function getActionReceipt(
  receipt_token: string,
): Promise<{ action_receipt_token: string }> {
  (global.fetch as any) = vi.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
    })
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
    });

  const res = await request(app)
    .post("/api/v1/legal/action")
    .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
    .set("Content-Type", "application/json");

  expect(res.status).toBe(200);
  expect(res.body.action_receipt_token).toBeTruthy();
  return { action_receipt_token: res.body.action_receipt_token };
}

// ── Revision plan model response ──────────────────────────────────────────────
const REVISION_PLAN_RESPONSE = {
  summary: "Two edits proposed: add vesting schedule and clarify IP scope.",
  edits: [
    {
      issue_id: "MISSING_VESTING_SCHEDULE",
      issue_status: "unresolved",
      edit_type: "insert",
      location_hint: "equity clause",
      proposed_text: "Each Founder's equity shall vest over four (4) years with a one (1) year cliff.",
      rationale: "Addresses missing vesting schedule identified in analysis.",
      requires_attorney: false,
    },
    {
      issue_id: "IP_SCOPE_AMBIGUOUS",
      issue_status: "partially_addressed",
      edit_type: "replace",
      location_hint: "IP assignment clause",
      proposed_text: "All intellectual property created by Founders in connection with the Company's business is hereby assigned to the Company, excluding prior inventions listed in Exhibit A.",
      rationale: "Clarifies IP scope and excludes prior inventions.",
      requires_attorney: false,
    },
  ],
  unaddressable_issues: [],
};

// ── Revision plan verifier response ──────────────────────────────────────────
const REVISION_VERIFY_CLEAN = {
  invented_facts: [],
};

describe("POST /api/v1/legal/action — generate_revision_plan (Phase 2B)", () => {
  it("receipt 16 — generate_revision_plan success: HTTP 200, edits array, impact_tier=action_triggering, action_receipt_token", async () => {
    const { receipt_token } = await getMatterReceipt();
    const { action_receipt_token } = await getActionReceipt(receipt_token);

    // Mock: revision plan call + verifier call
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(REVISION_PLAN_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(REVISION_VERIFY_CLEAN) } }] }),
      });

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        action_receipt_token,
        original_text: SAMPLE_TEXT,
        action_type: "generate_revision_plan",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.action_type).toBe("generate_revision_plan");
    expect(res.body.artifact_status).toBeDefined();

    // draft_artifact is a RevisionPlanArtifact
    expect(typeof res.body.draft_artifact.summary).toBe("string");
    expect(Array.isArray(res.body.draft_artifact.edits)).toBe(true);
    expect(res.body.draft_artifact.edits.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.draft_artifact.unaddressable_issues)).toBe(true);
    expect(typeof res.body.draft_artifact.total_edits).toBe("number");

    // Each edit has required fields
    for (const edit of res.body.draft_artifact.edits) {
      expect(edit.issue_id).toBeTruthy();
      expect(["insert", "replace", "delete", "flag_for_attorney"]).toContain(edit.edit_type);
      expect(edit.location_hint).toBeDefined();
      expect(edit.proposed_text).toBeDefined();
      expect(edit.rationale).toBeTruthy();
      expect(typeof edit.requires_attorney).toBe("boolean");
    }

    // Governance: revision plans are always action_triggering
    expect(res.body.governance.impact_tier).toBe("action_triggering");
    expect(res.body.governance.approval_required).toBe(true);
    expect(res.body.governance.human_review_required).toBe(true);

    // action_receipt_token issued for this revision run
    expect(res.body.action_receipt_token).toBeTruthy();
    const revEnvelope = JSON.parse(Buffer.from(res.body.action_receipt_token, "base64").toString());
    const revDecoded = JSON.parse(revEnvelope.payload);
    expect(revDecoded.action_type).toBe("generate_revision_plan");
    expect(revDecoded.draft_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("receipt 17 — generate_revision_plan missing action_receipt_token returns 400", async () => {
    const { receipt_token } = await getMatterReceipt();

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token, original_text: SAMPLE_TEXT, action_type: "generate_revision_plan" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action_receipt_token/i);
  });

  it("receipt 18 — generate_revision_plan with mismatched matter_id returns 400", async () => {
    // Get two separate matter receipts (same text, different matter_id UUIDs)
    // Then get an action receipt for matter B, and try to use it with matter A's receipt_token.
    // Since matter_id is a UUID generated per /matter call, two calls with the same text
    // produce different matter_ids — the action receipt's matter_id won't match.
    const { receipt_token: receipt_token_A } = await getMatterReceipt();

    // Get action receipt for matter B (second /matter call → different matter_id)
    const { receipt_token: receipt_token_B } = await getMatterReceipt();

    // Get action receipt signed for matter B
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(DRAFT_LETTER_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VERIFY_CLEAN) } }] }),
      });

    const actionResB = await request(app)
      .post("/api/v1/legal/action")
      .send({ receipt_token: receipt_token_B, original_text: SAMPLE_TEXT, action_type: "draft_letter" })
      .set("Content-Type", "application/json");
    expect(actionResB.status).toBe(200);
    const action_receipt_token_B = actionResB.body.action_receipt_token;

    // Use receipt_token_A (matter A) with action_receipt_token from matter B → matter_id mismatch
    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token: receipt_token_A,
        action_receipt_token: action_receipt_token_B,
        original_text: SAMPLE_TEXT,
        action_type: "generate_revision_plan",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/matter_id/i);
  });

  it("receipt 19 — generate_revision_plan with blocked artifact_status returns 400", async () => {
    // Build a fake action receipt with artifact_status = blocked
    const { createHmac, createHash } = await import("crypto");
    const secret = process.env.SESSION_SECRET!;
    const { receipt_token } = await getMatterReceipt();

    // Decode the matter receipt to get matter_id and original_text_hash
    const matterEnvelope = JSON.parse(Buffer.from(receipt_token, "base64").toString());
    const matterDecoded = JSON.parse(matterEnvelope.payload);

    const blockedReceipt = {
      matter_id: matterDecoded.matter_id,
      action_receipt_id: "00000000-0000-0000-0000-000000000099",
      action_type: "draft_letter",
      artifact_status: "blocked",  // blocked — cannot revise
      draft_hash: "a".repeat(64),
      verification_hash: "b".repeat(64),
      issue_resolution_map_hash: "c".repeat(64),
      original_text_hash: matterDecoded.original_text_hash,
      draft_prompt_version: "2a.1",
      verification_prompt_version: "2a.1",
      policy_version: "legal-action-v1",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    };
    const payload = JSON.stringify(blockedReceipt);
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    const blockedToken = Buffer.from(JSON.stringify({ payload, sig })).toString("base64");

    const res = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        action_receipt_token: blockedToken,
        original_text: SAMPLE_TEXT,
        action_type: "generate_revision_plan",
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });

  it("receipt 20 — generate_revision_plan replay (same action_receipt_token twice) returns 409", async () => {
    const { receipt_token } = await getMatterReceipt();
    const { action_receipt_token } = await getActionReceipt(receipt_token);

    // First call: succeeds
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(REVISION_PLAN_RESPONSE) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(REVISION_VERIFY_CLEAN) } }] }),
      });

    const first = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        action_receipt_token,
        original_text: SAMPLE_TEXT,
        action_type: "generate_revision_plan",
      })
      .set("Content-Type", "application/json");

    expect(first.status).toBe(200);

    // Second call: simulate nonce already consumed
    mockPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );

    const second = await request(app)
      .post("/api/v1/legal/action")
      .send({
        receipt_token,
        action_receipt_token,
        original_text: SAMPLE_TEXT,
        action_type: "generate_revision_plan",
      })
      .set("Content-Type", "application/json");

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already consumed/i);
  });
});
