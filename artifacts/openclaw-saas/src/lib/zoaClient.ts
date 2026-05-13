const ZOA_BASE = import.meta.env.VITE_ZOA_SERVICE_URL || "http://localhost:8001/api/v1/zoa";
const FACTORY_BASE = import.meta.env.VITE_ARCHON_FACTORY_URL || "http://localhost:3002";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ZoaResult {
  [key: string]: unknown;
}

export interface ZoaEvent {
  event_type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface EmployeeInput {
  id: string;
  name: string;
  hours: number;
  rate: number;
  role: string;
  deductions: number;
}

export interface InventoryItem {
  name: string;
  current_stock: number;
  unit: string;
}

// ─── Skill Factory types ──────────────────────────────────────────────────────

export type ForgeStatus =
  | "pending"
  | "generating"
  | "validating"
  | "fixing"
  | "benchmarking"
  | "cataloging"
  | "completed"
  | "failed";

export interface FactoryRun {
  runId: string;
  description: string;
  status: ForgeStatus;
  stage: string;
  skill?: {
    name: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    implementation: string;
  };
  l0Result?: { l0_pass: boolean; error?: string };
  benchmarkResult?: {
    grade: string;
    overall_score: number | null;
    level_scores?: Record<string, unknown>;
  };
  cataloged?: boolean;
  skillId?: number;
  retryCount: number;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

// ─── Writing Pipeline types ───────────────────────────────────────────────────

export type WritingTone = "zeta_warlord" | "professional" | "technical" | "satirical";
export type WritingPlatform = "medium" | "linkedin" | "blog" | "cold_email";

export interface WritingRun {
  run_id: string;
  topic: string;
  tone: WritingTone;
  platform: WritingPlatform;
  status: "pending" | "running" | "completed" | "failed";
  stage: string;
  outline?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  critique?: {
    score: number;
    strengths: string[];
    weaknesses: string[];
    specific_fixes: string[];
    verdict: string;
  };
  critique_score?: number;
  refined_draft?: Record<string, unknown>;
  published?: {
    formatted_content: string;
    platform: string;
    char_count: number;
    word_count: number;
    hashtags: string[];
    subject_line?: string;
    cta: string;
  };
  loops_taken?: number;
  final_score?: number;
  error?: string;
  created_at?: number;
  completed_at?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<ZoaResult> {
  try {
    const res = await fetch(`${ZOA_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ZOA_BASE}${path}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

async function factoryPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FACTORY_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Factory ${res.status}: ${err}`);
  }
  return res.json();
}

async function factoryGet<T>(path: string): Promise<T> {
  const res = await fetch(`${FACTORY_BASE}${path}`);
  if (!res.ok) throw new Error(`Factory ${res.status}`);
  return res.json();
}

async function writingPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ZOA_BASE.replace("/zoa", "/writing")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Writing ${res.status}: ${err}`);
  }
  return res.json();
}

async function writingGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ZOA_BASE.replace("/zoa", "/writing")}${path}`);
  if (!res.ok) throw new Error(`Writing ${res.status}`);
  return res.json();
}

// ─── Billing ─────────────────────────────────────────────────────────────────

export async function processInvoice(invoiceData: Record<string, unknown>): Promise<ZoaResult> {
  return post("/billing/process-invoice", { invoice_data: invoiceData });
}

export async function chasePayment(
  invoiceId: string,
  daysOverdue: number,
  clientName: string
): Promise<ZoaResult> {
  return post("/billing/chase-payment", {
    invoice_id: invoiceId,
    days_overdue: daysOverdue,
    client_name: clientName,
  });
}

export async function detectFraud(invoiceData: Record<string, unknown>): Promise<ZoaResult> {
  return post("/billing/detect-fraud", { invoice_data: invoiceData });
}

export async function generateInvoice(contractData: Record<string, unknown>): Promise<ZoaResult> {
  return post("/billing/generate-invoice", { contract_data: contractData });
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export async function findSlot(
  participants: string[],
  durationMins: number,
  context: string
): Promise<ZoaResult> {
  return post("/scheduling/find-slot", { participants, duration_mins: durationMins, context });
}

export async function bookMeeting(
  slot: Record<string, unknown>,
  agenda: string,
  participants: string[]
): Promise<ZoaResult> {
  return post("/scheduling/book-meeting", { slot, agenda, participants });
}

export async function handleDecline(
  meetingId: string,
  decliner: string,
  reason: string
): Promise<ZoaResult> {
  return post("/scheduling/handle-decline", { meeting_id: meetingId, decliner, reason });
}

export async function getPendingBlocks(): Promise<ZoaResult[]> {
  try {
    return await get<ZoaResult[]>("/scheduling/pending-blocks");
  } catch (err) {
    return [{ error: err instanceof Error ? err.message : String(err) }];
  }
}

// ─── Payroll ─────────────────────────────────────────────────────────────────

export async function calculatePayroll(
  employees: EmployeeInput[],
  period: string
): Promise<ZoaResult> {
  return post("/payroll/calculate", { employees, period });
}

export async function detectAnomaly(
  employeeId: string,
  metrics: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/payroll/detect-anomaly", { employee_id: employeeId, metrics });
}

export async function holdCommission(employeeId: string, reason: string): Promise<ZoaResult> {
  return post("/payroll/hold-commission", { employee_id: employeeId, reason });
}

export async function reviewCompensation(
  employeeId: string,
  performanceData: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/payroll/review-compensation", {
    employee_id: employeeId,
    performance_data: performanceData,
  });
}

// ─── HR ──────────────────────────────────────────────────────────────────────

export async function screenResume(
  resumeText: string,
  roleRequirements: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/hr/screen-resume", { resume_text: resumeText, role_requirements: roleRequirements });
}

export async function conductPerformanceReview(
  employeeId: string,
  metrics: Record<string, unknown>,
  period: string
): Promise<ZoaResult> {
  return post("/hr/performance-review", { employee_id: employeeId, metrics, period });
}

export async function processExit(employeeId: string, reason: string): Promise<ZoaResult> {
  return post("/hr/process-exit", { employee_id: employeeId, reason });
}

export async function flagPerformance(employeeId: string, issue: string): Promise<ZoaResult> {
  return post("/hr/flag-performance", { employee_id: employeeId, issue });
}

// ─── Procurement ─────────────────────────────────────────────────────────────

export async function scanReceipt(receiptData: string): Promise<ZoaResult> {
  return post("/procurement/scan-receipt", { receipt_data: receiptData });
}

export async function negotiateSupplier(
  supplier: string,
  currentTerms: Record<string, unknown>,
  marketData: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/procurement/negotiate-supplier", {
    supplier,
    current_terms: currentTerms,
    market_data: marketData,
  });
}

export async function checkInventory(
  items: InventoryItem[],
  thresholds: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/procurement/check-inventory", { items, thresholds });
}

export async function autoOrder(
  item: string,
  quantity: number,
  supplier: string
): Promise<ZoaResult> {
  return post("/procurement/auto-order", { item, quantity, supplier });
}

// ─── Compliance ──────────────────────────────────────────────────────────────

export async function interpretRegulation(
  regulationText: string,
  businessContext: string
): Promise<ZoaResult> {
  return post("/compliance/interpret-regulation", {
    regulation_text: regulationText,
    business_context: businessContext,
  });
}

export async function generateAuditDoc(
  auditType: string,
  data: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/compliance/generate-audit-doc", { audit_type: auditType, data });
}

export async function assessRisk(
  operation: string,
  jurisdiction: string,
  data: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/compliance/assess-risk", { operation, jurisdiction, data });
}

export async function handleAlert(
  alertType: string,
  details: Record<string, unknown>
): Promise<ZoaResult> {
  return post("/compliance/handle-alert", { alert_type: alertType, details });
}

// ─── Events & Health ─────────────────────────────────────────────────────────

export async function getPendingEvents(agentId: string): Promise<ZoaEvent[]> {
  try {
    return await get<ZoaEvent[]>(`/events/pending?agent_id=${encodeURIComponent(agentId)}`);
  } catch (_err) {
    return [];
  }
}

export async function getZoaHealth(): Promise<{ status: string; agents: string[] }> {
  try {
    return await get<{ status: string; agents: string[] }>("/health");
  } catch (_err) {
    return { status: "offline", agents: [] };
  }
}

// ─── Skill Factory (archon-factory service) ───────────────────────────────────

/**
 * Start a skill forge pipeline. Returns immediately with a runId.
 * Poll getForgeStatus(runId) every 2s to track progress.
 */
export async function forgeSkill(description: string): Promise<{ runId: string; status: string }> {
  return factoryPost<{ runId: string; status: string }>("/archon/generate", { description });
}

/**
 * Poll the status of a skill forge run.
 */
export async function getForgeStatus(runId: string): Promise<FactoryRun> {
  return factoryGet<FactoryRun>(`/archon/run/${runId}`);
}

/**
 * List recent skill forge runs.
 */
export async function listForgeRuns(): Promise<FactoryRun[]> {
  return factoryGet<FactoryRun[]>("/archon/runs");
}

// ─── ZOA-W Writing Pipeline ───────────────────────────────────────────────────

/**
 * Start the full 5-agent writing pipeline (Outline → Draft → Critique → Refine → Publish).
 * Returns immediately with a run_id. Poll getWritingStatus(runId) every 3s.
 */
export async function runWritingPipeline(
  topic: string,
  tone: WritingTone,
  platform: WritingPlatform,
  maxLoops = 3
): Promise<{ run_id: string; status: string }> {
  return writingPost<{ run_id: string; status: string }>("/pipeline/run", {
    topic,
    tone,
    platform,
    max_loops: maxLoops,
  });
}

/**
 * Poll the status of a writing pipeline run.
 */
export async function getWritingStatus(runId: string): Promise<WritingRun> {
  return writingGet<WritingRun>(`/pipeline/${runId}`);
}

/**
 * Critique a draft directly (single-agent call, no pipeline).
 */
export async function critiqueText(
  draft: string,
  tone: WritingTone = "professional"
): Promise<{ score: number; strengths: string[]; weaknesses: string[]; specific_fixes: string[]; verdict: string }> {
  return writingPost("/critique", { draft, tone });
}

/**
 * Generate an outline only.
 */
export async function generateOutline(
  topic: string,
  tone: WritingTone
): Promise<ZoaResult> {
  return writingPost("/outline", { topic, tone });
}

/**
 * Format content for a specific platform.
 */
export async function publishContent(
  content: string,
  platform: WritingPlatform
): Promise<ZoaResult> {
  return writingPost("/publish", { content, platform });
}

/**
 * Writing service health check.
 */
export async function getWritingHealth(): Promise<{ status: string; agents: string[] }> {
  try {
    return await writingGet<{ status: string; agents: string[] }>("/health");
  } catch {
    return { status: "offline", agents: [] };
  }
}


// ─── Kairos Execution Engine ──────────────────────────────────────────────────

const KAIROS_BASE = `${ZOA_BASE.replace("/zoa", "")}/zoa/kairos`;

export type KairosPhase = "idle" | "planning" | "acting" | "observing" | "refining" | "done" | "failed";

export interface KairosRunRequest {
  skill_id: string;
  goal: string;
  tenant_id?: string;
  l1_score?: number;
  l2_score?: number;
  l3_score?: number;
  l4_score?: number;
  permitted_tools?: string[];
  max_turns?: number;
}

export interface KairosRunStatus {
  run_id: string;
  skill_id: string;
  phase: KairosPhase;
  status: "running" | "done" | "failed";
  turn_count: number;
  tool_calls_made: number;
  violations: Array<{ tool_name: string; reason: string; benchmark_score: number }>;
  degraded: boolean;
  result: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  archon_reforge_ready: boolean;
  archon_context: {
    skill_id: string;
    run_id: string;
    goal: string;
    violations: unknown[];
    error_summary: string;
  } | null;
}

export interface KairosEvent {
  type: string;
  run_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ── Control-plane helpers ─────────────────────────────────────────────────

export interface TenantRecord {
  id: number;
  name: string;
  status: string;
  skillPack: string | null;
}

export interface TenantSkillRecord {
  id: number;
  tenantId: number;
  skillId: number;
  installedAt: string;
  skill?: {
    id: number;
    name: string;
    slug: string;
    category: string;
  };
}

export interface BenchmarkResult {
  id?: number;
  skillId?: number;
  grade: string | null;
  overallScore: number | null;
  levelScores: Record<string, number> | null;
  llmResults?: unknown;
  ranAt?: string;
  status?: string;
  message?: string;
}

const API_BASE = "/api";

export async function getTenants(): Promise<TenantRecord[]> {
  const res = await fetch(`${API_BASE}/tenants`, { credentials: "include" });
  if (!res.ok) throw new Error(`getTenants: ${res.status}`);
  const data = await res.json();
  // api-server returns array directly
  return Array.isArray(data) ? data : (data.tenants ?? []);
}

export async function getTenantSkills(tenantId: number): Promise<TenantSkillRecord[]> {
  const res = await fetch(`${API_BASE}/tenants/${tenantId}/skills`, { credentials: "include" });
  if (!res.ok) throw new Error(`getTenantSkills: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.skills ?? []);
}

export async function getSkillBenchmarkResult(skillId: number): Promise<BenchmarkResult> {
  const res = await fetch(`${API_BASE}/skills/${skillId}/benchmark-result`);
  if (!res.ok) return { grade: null, overallScore: null, levelScores: null, status: "not_tested" };
  return res.json();
}

export async function runKairos(req: KairosRunRequest): Promise<{ run_id: string; skill_id: string; phase: string; status: string; started_at: string }> {
  const res = await fetch(`${KAIROS_BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Kairos start failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getKairosRun(runId: string): Promise<KairosRunStatus> {
  const res = await fetch(`${KAIROS_BASE}/run/${runId}`);
  if (!res.ok) throw new Error(`Kairos poll failed: ${res.status}`);
  return res.json();
}

export async function listKairosRuns(skillId?: string, tenantId?: string): Promise<{ runs: KairosRunStatus[]; total: number }> {
  const params = new URLSearchParams();
  if (skillId) params.set("skill_id", skillId);
  if (tenantId) params.set("tenant_id", tenantId);
  const qs = params.toString();
  const url = qs ? `${KAIROS_BASE}/runs?${qs}` : `${KAIROS_BASE}/runs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kairos list failed: ${res.status}`);
  return res.json();
}

export function streamKairosRun(
  runId: string,
  onEvent: (event: KairosEvent) => void,
  onDone: (status: KairosRunStatus | null) => void,
  onError?: (err: Event) => void
): () => void {
  const es = new EventSource(`${KAIROS_BASE}/run/${runId}/stream`);

  const handleMsg = (e: MessageEvent) => {
    try {
      const parsed: KairosEvent = JSON.parse(e.data);
      onEvent(parsed);
      if (parsed.type === "run_complete") {
        onDone(parsed.payload as unknown as KairosRunStatus);
        es.close();
      }
    } catch {
      // ignore malformed
    }
  };

  es.onmessage = handleMsg;
  const types = ["phase_change","text_chunk","thinking_chunk","tool_start","tool_end",
                  "turn_done","permission_violation","permission_request","run_complete","error"];
  for (const t of types) es.addEventListener(t, handleMsg as EventListener);

  es.onerror = (e) => {
    onError?.(e);
    onDone(null);
    es.close();
  };

  return () => es.close();
}
