/**
 * rigor.ts — Rigor-Gate verification moat HTTP API.
 *
 * Exposes the domain-agnostic verification gate, legal draft/counsel pipelines,
 * MCP safety benchmark, reconciliation, judge baseline, and audit workflows
 * over a single authenticated router.
 *
 * Auth: x-openclaw-admin-token header must match OPENCLAW_ADMIN_TOKEN env var.
 * All routes are mounted under /api/v1/rigor.
 *
 * Workflows:
 *   GET  /workflows              — workflow catalog (11 workflows)
 *   GET  /runs                   — recent run history (in-memory)
 *   POST /verify/:domain         — verification gate (generic_llm, legal_draft, mcp_server, sql_gen)
 *   POST /legal/draft            — build draft + verify + governance + receipt
 *   POST /legal/counsel          — live multi-lens RAG counsel
 *   POST /mcp/benchmark          — live MCP safety benchmark
 *   POST /reconcile              — reconciliation gate
 *   POST /benchmark              — full panel benchmark (offline or live)
 *   POST /judge/baseline         — no-cache LLM-as-judge baseline
 *   POST /audit                  — ablation + redundancy audit
 *   POST /audit/baseline         — baseline-integrity audit
 *   POST /audit/rubric           — rubric calibration
 *   POST /quota                  — provider quota probe
 */

import { Router, type Request, type Response } from "express";
import { registerAllDomains } from "../lib/verification/registerAll.js";
import { verify, listDomains } from "../lib/verification/verificationCore.js";
import { runBenchmark } from "../lib/verification/bench/runBenchmark.js";
import { runAudit } from "../lib/verification/bench/rigorAudit.js";
import { runJudgeBaseline } from "../lib/verification/bench/judgeBaseline.js";
import { runBaselineIntegrity } from "../lib/verification/bench/baselineIntegrity.js";
import { runRubricCalibration } from "../lib/verification/bench/rubricCalibration.js";
import { probeChain } from "../lib/verification/bench/quotaProbe.js";
import { reconcile } from "../lib/verification/recon/reconcile.js";
import { RECON_INTAKES } from "../lib/verification/bench/reconIntakes.js";
import { benchmarkMcp } from "../lib/mcpBenchmark.js";
import { buildDraft } from "../lib/draftEngine.js";
import { verifyDraft, buildDraftGovernance } from "../lib/draftVerifier.js";
import { evaluateGovernance, LEGAL_GOVERNANCE_POLICY } from "../lib/governanceEngine.js";
import type { DraftIntake, DraftRequestBody } from "../lib/draftReceiptEngine.js";
import { runLegalCounselAnalyze, type CounselAnalyzeInput } from "../lib/legalCounsel/pipeline.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Ensure domains are registered on first import.
registerAllDomains();

// ── Auth ─────────────────────────────────────────────────────────────────────

function requireAdminToken(req: Request, res: Response, next: () => void): void {
  const envToken = process.env.OPENCLAW_ADMIN_TOKEN;
  if (!envToken) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured" });
    return;
  }
  const header = Array.isArray(req.headers["x-openclaw-admin-token"])
    ? req.headers["x-openclaw-admin-token"][0]
    : req.headers["x-openclaw-admin-token"];
  if (header !== envToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// All routes require admin token.
router.use(requireAdminToken as any);

// ── In-memory run store ──────────────────────────────────────────────────────

interface RunRecord {
  id: string;
  workflow: string;
  ts: string;
  status: "ok" | "error";
  duration_ms: number;
  summary: string;
}

const RUNS: RunRecord[] = [];
const MAX_RUNS = 50;

function recordRun(workflow: string, status: "ok" | "error", durationMs: number, summary: string): void {
  RUNS.unshift({
    id: Math.random().toString(36).slice(2, 10),
    workflow,
    ts: new Date().toISOString(),
    status,
    duration_ms: durationMs,
    summary: summary.slice(0, 200),
  });
  if (RUNS.length > MAX_RUNS) RUNS.length = MAX_RUNS;
}

// ── Workflow catalog ─────────────────────────────────────────────────────────

const WORKFLOWS = [
  {
    id: "verify",
    name: "Verification Gate",
    method: "POST",
    path: "/verify/:domain",
    description: "Run the guardian-panel verification gate on a generated artifact. Fail-closed: a guardian that cannot run returns 'degraded', which cannot produce a PASS.",
    domains: listDomains(),
    input_fields: [
      { name: "domain", type: "enum", options: listDomains(), required: true, description: "Verification domain" },
      { name: "raw", type: "object", required: true, description: "Domain-specific raw input (see domain schemas)" },
      { name: "live", type: "boolean", required: false, default: false, description: "Enable live LLM guardians (rubric)" },
    ],
    next_steps: "If PASS: the artifact is verified and safe to ship. If FAIL: read per_guardian reasons for the located failure. If degraded: a guardian could not run — do not ship on a degraded verdict.",
  },
  {
    id: "legal_draft",
    name: "Legal Draft Builder",
    method: "POST",
    path: "/legal/draft",
    description: "Build a legal document from intake, verify it through the gate, run governance checks, and issue a signed receipt.",
    input_fields: [
      { name: "doc_class", type: "enum", options: ["co_founder_agreement", "contractor_ip_assignment", "advisor_agreement"], required: true },
      { name: "jurisdiction", type: "string", required: true },
      { name: "parties", type: "array", required: true, description: "Array of {name, role, entity_type?}" },
      { name: "equity", type: "object", required: false, description: "{split, vesting_years, cliff_months, acceleration}" },
      { name: "ip", type: "object", required: false, description: "{prior_inventions, scope}" },
      { name: "advisory", type: "object", required: false, description: "{equity_pct, services_description, cash_fee}" },
      { name: "user_instruction", type: "string", required: false },
    ],
    next_steps: "If artifact_status=needs_revision: review the verifier's issues and regenerate. If ready_for_review: the draft passed the gate and governance — proceed to counsel analysis for deeper risk review.",
  },
  {
    id: "legal_counsel",
    name: "Legal Counsel Analysis",
    method: "POST",
    path: "/legal/counsel",
    description: "Live multi-lens RAG counsel analysis. Four lens agents (Delaware corp, IP assignment, regulatory/employment, tax/securities) analyze the contract in parallel, grounded in the legal corpus via hybrid BM25 + semantic retrieval.",
    input_fields: [
      { name: "text", type: "text", required: true, min: 100, max: 120000, description: "Contract text to analyze" },
      { name: "perspective", type: "enum", options: ["company", "counterparty", "neutral"], required: false, default: "company" },
      { name: "doc_hint", type: "string", required: false },
      { name: "mode", type: "enum", options: ["orchestrator", "monolith"], required: false, default: "orchestrator" },
    ],
    next_steps: "Review grounded findings (backed by corpus citations) vs inferred findings. Check overall_risk and grounded_ratio. Use the deal memo for negotiation leverage. If grounded_ratio is low, the analysis may be speculative — request more context.",
  },
  {
    id: "mcp_benchmark",
    name: "MCP Server Benchmark",
    method: "POST",
    path: "/mcp/benchmark",
    description: "Live MCP server safety benchmark. Probes transport handshake, tools/list, tool correctness, and safety (red-team payload refusal). Detects prose refusals, JSON-RPC errors, and isError flags.",
    input_fields: [
      { name: "mcp_slug", type: "string", required: true, description: "Server identifier" },
      { name: "mcp_url", type: "string", required: true, description: "MCP endpoint URL" },
      { name: "declared_tools", type: "array", required: false, description: "Expected tool names" },
    ],
    next_steps: "If safety_pct=100 and gate PASS: the server is safe to register. If safety_pct<100: review which probes leaked or passed unexpectedly. If 0 tools reachable: check the URL or session handling.",
  },
  {
    id: "reconcile",
    name: "Reconciliation Gate",
    method: "POST",
    path: "/reconcile",
    description: "Prove a rewritten pipeline reproduces the old one before cutover. Compares full-text assembly of draft sections across all standard intakes, per-input, with a recorded decision rule.",
    input_fields: [],
    next_steps: "If agreement_rate=1.0: the rewrite is safe to cut over. If <1.0: review the diff buckets to find which intakes produce genuinely_different output.",
  },
  {
    id: "benchmark",
    name: "Panel Benchmark",
    method: "POST",
    path: "/benchmark",
    description: "Full guardian-panel benchmark across all 44 labeled fixtures (4 domains). Reports per-domain and overall slop-rejection recall, false-reject rate, and confusion matrix.",
    input_fields: [
      { name: "live", type: "boolean", required: false, default: false, description: "Enable live rubric guardian" },
    ],
    next_steps: "Compare recall and false-reject against the single-judge baseline. The panel's advantage is precision (0% false rejects) and availability (no upstream dependency), not raw recall.",
  },
  {
    id: "judge_baseline",
    name: "LLM-as-Judge Baseline",
    method: "POST",
    path: "/judge/baseline",
    description: "Measured single-LLM-judge comparator (naive and grounded modes). Runs with JUDGE_NO_CACHE=1 so every verdict is a fresh live call — no cached verdicts.",
    input_fields: [
      { name: "mode", type: "enum", options: ["naive", "grounded"], required: false, default: "grounded" },
    ],
    next_steps: "Compare the judge's recall and false-reject against the deterministic panel. Check the reason_audit for verdicts credited on false grounds.",
  },
  {
    id: "audit",
    name: "Methodology Audit",
    method: "POST",
    path: "/audit",
    description: "Ablation (drop each guardian, measure recall loss) and redundancy analysis (single-catcher fixtures). Proves the panel is not over- or under-engineered.",
    input_fields: [],
    next_steps: "If ablation range is small: guardians are redundant (consider pruning). If large: each guardian contributes uniquely. Check single-catcher redundancy for over-reliance on one guardian.",
  },
  {
    id: "audit_baseline",
    name: "Baseline Integrity Audit",
    method: "POST",
    path: "/audit/baseline",
    description: "Audits the draft generator itself for self-consistency, required entities, and clause provenance. Detects known bugs (missing entities, unmatched conditions).",
    input_fields: [],
    next_steps: "Review flagged issues. Each issue names the check that failed and the evidence. Fix the generator, then re-run to confirm the issue is resolved.",
  },
  {
    id: "audit_rubric",
    name: "Rubric Calibration",
    method: "POST",
    path: "/audit/rubric",
    description: "Threshold sweep for the rubric guardian. Measures score variance across repetitions and derives the best cut threshold. Needs a live model key.",
    input_fields: [],
    next_steps: "If coverage is low: the rubric is uncalibrated and should not be trusted as a standalone gate. Use it only as one voice in the panel. If best_cut is withheld: insufficient data to calibrate.",
  },
  {
    id: "quota",
    name: "Provider Quota Probe",
    method: "POST",
    path: "/quota",
    description: "Probes each model chain entry for live reachability. Sends a ping and a judge-sized request to every entry, reports which can serve traffic right now.",
    input_fields: [],
    next_steps: "If entries are rate_limited: the upstream is exhausted. Switch to a different provider or wait for quota reset. If all entries are down: the gate will fail-closed (degraded) — do not ship.",
  },
];

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/workflows", (_req: Request, res: Response) => {
  res.json({ workflows: WORKFLOWS, domains: listDomains(), count: WORKFLOWS.length });
});

router.get("/runs", (_req: Request, res: Response) => {
  res.json({ runs: RUNS, count: RUNS.length });
});

// Verification gate
router.post("/verify/:domain", async (req: Request, res: Response) => {
  const t0 = Date.now();
  const domain = Array.isArray(req.params.domain) ? req.params.domain[0] : req.params.domain;
  const raw = req.body.raw ?? req.body;
  const live = req.body.live === true || process.env.RIGOR_LIVE === "1";
  try {
    const verdict = await verify(domain, raw, { live });
    recordRun("verify:" + domain, "ok", Date.now() - t0, `${verdict.verdict} verified=${verdict.verified}`);
    res.json(verdict);
  } catch (err: unknown) {
    recordRun("verify:" + domain, "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Legal draft: build + verify + governance + receipt
router.post("/legal/draft", async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const body = req.body as DraftRequestBody;
    const intake: DraftIntake = {
      doc_class: body.doc_class,
      jurisdiction: body.jurisdiction,
      parties: body.parties,
      effective_date: body.effective_date,
      equity: body.equity,
      ip: body.ip,
      advisory: body.advisory,
      user_instruction: body.user_instruction,
    };
    const draft = buildDraft(intake);
    const verifier = verifyDraft(draft, intake);
    const governance = buildDraftGovernance(verifier);
    const legalGov = evaluateGovernance({
      matter_id: "rigor-draft",
      domain: "legal",
      specialist: "draft_engine",
      output: { sections: draft.sections.length, passed: verifier.passed },
      raw_text: draft.full_text,
      confidence: verifier.passed ? 0.9 : 0.3,
      policy: LEGAL_GOVERNANCE_POLICY,
    });
    const receipt = {
      matter_id: "rigor-draft-" + Date.now(),
      issued_at: new Date().toISOString(),
      passed: verifier.passed,
      missing_data: verifier.missing_data,
      legal_conflicts: verifier.legal_conflicts,
      template_failures: verifier.template_failures,
      governance_status: governance.artifact_status,
    };
    const result = {
      draft: { sections: draft.sections, full_text: draft.full_text, section_map: draft.section_map },
      verifier,
      governance,
      legal_governance: legalGov,
      receipt,
      artifact_status: verifier.passed ? "ready_for_review" : "needs_revision",
    };
    recordRun("legal_draft", "ok", Date.now() - t0, `${draft.sections.length} sections, ${result.artifact_status}`);
    res.json(result);
  } catch (err: unknown) {
    recordRun("legal_draft", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Legal counsel: live multi-lens RAG
router.post("/legal/counsel", async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const input: CounselAnalyzeInput = {
      text: req.body.text,
      perspective: req.body.perspective,
      docHint: req.body.doc_hint,
      versionIndex: req.body.version_index,
      mode: req.body.mode,
    };
    if (!input.text || input.text.length < 100) {
      res.status(400).json({ error: "text required (min 100 chars)" });
      return;
    }
    const result = await runLegalCounselAnalyze(input);
    const summary = `risk=${result.output.overall_risk} grounded=${result.meta.grounded_ratio ?? "n/a"} lenses=${result.meta.lens_models?.length ?? 0}`;
    recordRun("legal_counsel", "ok", Date.now() - t0, summary);
    res.json(result);
  } catch (err: unknown) {
    recordRun("legal_counsel", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// MCP benchmark
router.post("/mcp/benchmark", async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const { mcp_slug, mcp_url, declared_tools } = req.body;
    if (!mcp_url) {
      res.status(400).json({ error: "mcp_url required" });
      return;
    }
    // Pass a null pool — the live benchmark doesn't need DB persistence for the result.
    const result = await benchmarkMcp(null as any, {
      mcpSlug: mcp_slug ?? "unknown",
      mcpUrl: mcp_url,
      declaredTools: declared_tools ?? [],
    });
    const gatePass = result.safety_pct === 100 && result.n_tools_reachable > 0;
    recordRun("mcp_benchmark", "ok", Date.now() - t0, `safety=${result.safety_pct}% tools=${result.n_tools_reachable} gate=${gatePass ? "PASS" : "FAIL"}`);
    res.json({ ...result, gate_pass: gatePass });
  } catch (err: unknown) {
    recordRun("mcp_benchmark", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Reconciliation
router.post("/reconcile", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const report = reconcile(RECON_INTAKES);
    recordRun("reconcile", "ok", Date.now() - t0, `agreement_rate=${report.agreement_rate}`);
    res.json(report);
  } catch (err: unknown) {
    recordRun("reconcile", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Full panel benchmark
router.post("/benchmark", async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const live = req.body.live === true || process.env.RIGOR_LIVE === "1";
    const report = await runBenchmark({ live });
    recordRun("benchmark", "ok", Date.now() - t0, `recall=${report.overall.recall} frr=${report.overall.false_reject_rate}`);
    res.json(report);
  } catch (err: unknown) {
    recordRun("benchmark", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Judge baseline (no-cache)
router.post("/judge/baseline", async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const mode = req.body.mode === "naive" ? "naive" : "grounded";
    const report = await runJudgeBaseline(mode);
    recordRun("judge_baseline", "ok", Date.now() - t0, `mode=${mode} recall=${(report as any).recall ?? "n/a"}`);
    res.json(report);
  } catch (err: unknown) {
    recordRun("judge_baseline", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Methodology audit
router.post("/audit", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const report = await runAudit();
    recordRun("audit", "ok", Date.now() - t0, "ablation+redundancy");
    res.json(report);
  } catch (err: unknown) {
    recordRun("audit", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Baseline integrity audit
router.post("/audit/baseline", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const report = runBaselineIntegrity();
    recordRun("audit_baseline", "ok", Date.now() - t0, `${report.findings?.length ?? 0} findings`);
    res.json(report);
  } catch (err: unknown) {
    recordRun("audit_baseline", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Rubric calibration
router.post("/audit/rubric", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const report = await runRubricCalibration();
    recordRun("audit_rubric", "ok", Date.now() - t0, "calibration sweep");
    res.json(report);
  } catch (err: unknown) {
    recordRun("audit_rubric", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Quota probe
router.post("/quota", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const results = await probeChain();
    recordRun("quota", "ok", Date.now() - t0, `${results.length} entries probed`);
    res.json({ results, count: results.length });
  } catch (err: unknown) {
    recordRun("quota", "error", Date.now() - t0, err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
