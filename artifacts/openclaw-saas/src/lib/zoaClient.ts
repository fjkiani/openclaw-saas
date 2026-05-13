const ZOA_BASE = import.meta.env.VITE_ZOA_SERVICE_URL || "http://localhost:8001/api/v1/zoa";

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
