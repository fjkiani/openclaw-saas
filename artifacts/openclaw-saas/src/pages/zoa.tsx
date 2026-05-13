import { useState, useEffect, useCallback } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Zap, AlertTriangle, CheckCircle, Clock } from "lucide-react";
import * as zoaClient from "@/lib/zoaClient";
import type { ZoaEvent } from "@/lib/zoaClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type BenchmarkGrade = "CERTIFIED" | "CONDITIONAL" | "FAILED" | "NOT TESTED";

interface AgentStatus {
  id: string;
  label: string;
  state: "operational" | "degraded" | "offline";
}

// ─── Grade Badge ──────────────────────────────────────────────────────────────

function GradeBadge({ grade }: { grade: BenchmarkGrade }) {
  const cfg: Record<BenchmarkGrade, { color: string; bg: string; border: string }> = {
    CERTIFIED: {
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/30",
    },
    CONDITIONAL: {
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/30",
    },
    FAILED: { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
    "NOT TESTED": {
      color: "text-zinc-500",
      bg: "bg-zinc-800/50",
      border: "border-zinc-700",
    },
  };
  const c = cfg[grade];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-mono ${c.color} border ${c.border} ${c.bg} px-1.5 py-0.5 rounded`}
    >
      {grade === "CERTIFIED" && <CheckCircle className="w-2.5 h-2.5" />}
      {grade === "CONDITIONAL" && <AlertTriangle className="w-2.5 h-2.5" />}
      {grade === "FAILED" && <AlertTriangle className="w-2.5 h-2.5" />}
      {grade === "NOT TESTED" && <Clock className="w-2.5 h-2.5" />}
      {grade}
    </span>
  );
}

// ─── Results Panel ────────────────────────────────────────────────────────────

function ResultPanel({
  result,
  loading,
  error,
}: {
  result: zoaClient.ZoaResult | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 bg-primary/5 border border-primary/20 rounded text-xs font-mono text-primary">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Agent executing…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 p-4 bg-red-500/5 border border-red-500/20 rounded text-xs font-mono text-red-400">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        {error}
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className="p-3 bg-background border border-border rounded">
      <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-2">
        Response
      </p>
      <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all leading-relaxed">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

// ─── Section Label ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
      {children}
    </p>
  );
}

// ─── Shared input styles ──────────────────────────────────────────────────────

const inputCls =
  "bg-background border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary";
const textareaCls =
  "bg-background border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary resize-none";

// ─── Billing Tab ──────────────────────────────────────────────────────────────

function BillingTab() {
  const { toast } = useToast();
  const [invoiceJson, setInvoiceJson] = useState('{\n  "amount": 5000,\n  "client": "Acme Corp",\n  "due_date": "2026-08-01"\n}');
  const [invoiceId, setInvoiceId] = useState("");
  const [daysOverdue, setDaysOverdue] = useState("30");
  const [clientName, setClientName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) {
          setError(String(r.error));
        } else {
          setResult(r);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  const parseJson = (s: string): Record<string, unknown> => {
    try {
      return JSON.parse(s);
    } catch {
      return { raw: s };
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">Billing Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      {/* Process Invoice */}
      <div className="space-y-2">
        <SectionLabel>Invoice Data (JSON)</SectionLabel>
        <Textarea
          className={textareaCls}
          rows={4}
          value={invoiceJson}
          onChange={(e) => setInvoiceJson(e.target.value)}
          placeholder='{ "amount": 5000, "client": "Acme Corp" }'
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="text-xs font-mono"
            disabled={loading}
            onClick={() => run(() => zoaClient.processInvoice(parseJson(invoiceJson)))}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
            Process Invoice
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-mono border-border"
            disabled={loading}
            onClick={() => run(() => zoaClient.detectFraud(parseJson(invoiceJson)))}
          >
            Detect Fraud
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-mono border-border"
            disabled={loading}
            onClick={() => run(() => zoaClient.generateInvoice(parseJson(invoiceJson)))}
          >
            Generate Invoice
          </Button>
        </div>
      </div>

      {/* Chase Payment */}
      <div className="space-y-2">
        <SectionLabel>Chase Payment</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <SectionLabel>Invoice ID</SectionLabel>
            <Input
              className={inputCls}
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
              placeholder="INV-001"
            />
          </div>
          <div>
            <SectionLabel>Days Overdue</SectionLabel>
            <Input
              className={inputCls}
              type="number"
              value={daysOverdue}
              onChange={(e) => setDaysOverdue(e.target.value)}
              placeholder="30"
            />
          </div>
          <div>
            <SectionLabel>Client Name</SectionLabel>
            <Input
              className={inputCls}
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
        </div>
        <Button
          size="sm"
          className="text-xs font-mono"
          disabled={loading}
          onClick={() =>
            run(() =>
              zoaClient.chasePayment(invoiceId, parseInt(daysOverdue, 10) || 0, clientName)
            )
          }
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
          Chase Payment
        </Button>
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── Scheduling Tab ───────────────────────────────────────────────────────────

function SchedulingTab() {
  const { toast } = useToast();
  const [participants, setParticipants] = useState("alice@co.com, bob@co.com");
  const [duration, setDuration] = useState("60");
  const [context, setContext] = useState("Q3 planning sync");
  const [lastSlot, setLastSlot] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) {
          setError(String(r.error));
        } else {
          setResult(r);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">Scheduling Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      <div className="space-y-2">
        <SectionLabel>Find Optimal Slot</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <SectionLabel>Participants (comma-separated)</SectionLabel>
            <Input
              className={inputCls}
              value={participants}
              onChange={(e) => setParticipants(e.target.value)}
              placeholder="alice@co.com, bob@co.com"
            />
          </div>
          <div>
            <SectionLabel>Duration (mins)</SectionLabel>
            <Input
              className={inputCls}
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="60"
            />
          </div>
        </div>
        <div>
          <SectionLabel>Context</SectionLabel>
          <Input
            className={inputCls}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Q3 planning sync"
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="text-xs font-mono"
            disabled={loading}
            onClick={() =>
              run(async () => {
                const parts = participants.split(",").map((s) => s.trim()).filter(Boolean);
                const r = await zoaClient.findSlot(parts, parseInt(duration, 10) || 60, context);
                if (!r.error) setLastSlot(r as Record<string, unknown>);
                return r;
              })
            }
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
            Find Optimal Slot
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-mono border-border"
            disabled={loading || !lastSlot}
            onClick={() =>
              run(() =>
                zoaClient.bookMeeting(
                  lastSlot!,
                  context,
                  participants.split(",").map((s) => s.trim()).filter(Boolean)
                )
              )
            }
          >
            Book Meeting
          </Button>
        </div>
        {lastSlot && (
          <p className="text-[10px] font-mono text-emerald-400">
            ✓ Slot cached — ready to book
          </p>
        )}
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── Payroll Tab ──────────────────────────────────────────────────────────────

function PayrollTab() {
  const { toast } = useToast();
  const [period, setPeriod] = useState("2026-Q2");
  const [employeesJson, setEmployeesJson] = useState(
    JSON.stringify(
      [
        { id: "E001", name: "Alice", hours: 160, rate: 75, role: "engineer", deductions: 500 },
      ],
      null,
      2
    )
  );
  const [employeeId, setEmployeeId] = useState("E001");
  const [metricsJson, setMetricsJson] = useState('{ "overtime_hours": 20, "absences": 2 }');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) setError(String(r.error));
        else setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  const parseJson = (s: string): Record<string, unknown> => {
    try { return JSON.parse(s); } catch { return { raw: s }; }
  };

  const parseArr = (s: string): zoaClient.EmployeeInput[] => {
    try { return JSON.parse(s); } catch { return []; }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">Payroll Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      <div className="space-y-2">
        <SectionLabel>Calculate Payroll</SectionLabel>
        <div>
          <SectionLabel>Period</SectionLabel>
          <Input
            className={inputCls}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-Q2"
          />
        </div>
        <div>
          <SectionLabel>Employees (JSON array)</SectionLabel>
          <Textarea
            className={textareaCls}
            rows={5}
            value={employeesJson}
            onChange={(e) => setEmployeesJson(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          className="text-xs font-mono"
          disabled={loading}
          onClick={() => run(() => zoaClient.calculatePayroll(parseArr(employeesJson), period))}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
          Calculate Payroll
        </Button>
      </div>

      <div className="space-y-2">
        <SectionLabel>Detect Anomaly</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <SectionLabel>Employee ID</SectionLabel>
            <Input
              className={inputCls}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="E001"
            />
          </div>
          <div>
            <SectionLabel>Metrics (JSON)</SectionLabel>
            <Input
              className={inputCls}
              value={metricsJson}
              onChange={(e) => setMetricsJson(e.target.value)}
              placeholder='{ "overtime_hours": 20 }'
            />
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono border-border"
          disabled={loading}
          onClick={() => run(() => zoaClient.detectAnomaly(employeeId, parseJson(metricsJson)))}
        >
          Detect Anomaly
        </Button>
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── HR Tab ───────────────────────────────────────────────────────────────────

function HRTab() {
  const { toast } = useToast();
  const [resumeText, setResumeText] = useState("5 years TypeScript, led 3 product teams, MBA Stanford...");
  const [requirementsJson, setRequirementsJson] = useState('{ "role": "Senior Engineer", "min_years": 4 }');
  const [empId, setEmpId] = useState("E001");
  const [reviewPeriod, setReviewPeriod] = useState("2026-H1");
  const [reviewMetrics, setReviewMetrics] = useState('{ "performance_score": 87, "goals_met": 4 }');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) setError(String(r.error));
        else setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  const parseJson = (s: string): Record<string, unknown> => {
    try { return JSON.parse(s); } catch { return { raw: s }; }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">HR Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      <div className="space-y-2">
        <SectionLabel>Screen Resume</SectionLabel>
        <Textarea
          className={textareaCls}
          rows={3}
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder="Paste resume text…"
        />
        <div>
          <SectionLabel>Role Requirements (JSON)</SectionLabel>
          <Input
            className={inputCls}
            value={requirementsJson}
            onChange={(e) => setRequirementsJson(e.target.value)}
            placeholder='{ "role": "Senior Engineer", "min_years": 4 }'
          />
        </div>
        <Button
          size="sm"
          className="text-xs font-mono"
          disabled={loading}
          onClick={() => run(() => zoaClient.screenResume(resumeText, parseJson(requirementsJson)))}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
          Screen Resume
        </Button>
      </div>

      <div className="space-y-2">
        <SectionLabel>Performance Review</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <SectionLabel>Employee ID</SectionLabel>
            <Input
              className={inputCls}
              value={empId}
              onChange={(e) => setEmpId(e.target.value)}
              placeholder="E001"
            />
          </div>
          <div>
            <SectionLabel>Period</SectionLabel>
            <Input
              className={inputCls}
              value={reviewPeriod}
              onChange={(e) => setReviewPeriod(e.target.value)}
              placeholder="2026-H1"
            />
          </div>
        </div>
        <div>
          <SectionLabel>Metrics (JSON)</SectionLabel>
          <Input
            className={inputCls}
            value={reviewMetrics}
            onChange={(e) => setReviewMetrics(e.target.value)}
            placeholder='{ "performance_score": 87 }'
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono border-border"
          disabled={loading}
          onClick={() =>
            run(() =>
              zoaClient.conductPerformanceReview(empId, parseJson(reviewMetrics), reviewPeriod)
            )
          }
        >
          Run Performance Review
        </Button>
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── Procurement Tab ──────────────────────────────────────────────────────────

function ProcurementTab() {
  const { toast } = useToast();
  const [receiptText, setReceiptText] = useState("Office Depot — 3x printer cartridges $89.97 — 2026-07-01");
  const [itemsJson, setItemsJson] = useState(
    JSON.stringify([{ name: "Printer Cartridge", current_stock: 2, unit: "units" }], null, 2)
  );
  const [thresholdsJson, setThresholdsJson] = useState('{ "Printer Cartridge": 5 }');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) setError(String(r.error));
        else setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  const parseJson = (s: string): Record<string, unknown> => {
    try { return JSON.parse(s); } catch { return { raw: s }; }
  };

  const parseArr = (s: string): zoaClient.InventoryItem[] => {
    try { return JSON.parse(s); } catch { return []; }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">Procurement Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      <div className="space-y-2">
        <SectionLabel>Scan Receipt</SectionLabel>
        <Textarea
          className={textareaCls}
          rows={3}
          value={receiptText}
          onChange={(e) => setReceiptText(e.target.value)}
          placeholder="Paste receipt text…"
        />
        <Button
          size="sm"
          className="text-xs font-mono"
          disabled={loading}
          onClick={() => run(() => zoaClient.scanReceipt(receiptText))}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
          Scan Receipt
        </Button>
      </div>

      <div className="space-y-2">
        <SectionLabel>Check Inventory</SectionLabel>
        <div>
          <SectionLabel>Items (JSON array)</SectionLabel>
          <Textarea
            className={textareaCls}
            rows={3}
            value={itemsJson}
            onChange={(e) => setItemsJson(e.target.value)}
          />
        </div>
        <div>
          <SectionLabel>Thresholds (JSON)</SectionLabel>
          <Input
            className={inputCls}
            value={thresholdsJson}
            onChange={(e) => setThresholdsJson(e.target.value)}
            placeholder='{ "Printer Cartridge": 5 }'
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono border-border"
          disabled={loading}
          onClick={() =>
            run(() => zoaClient.checkInventory(parseArr(itemsJson), parseJson(thresholdsJson)))
          }
        >
          Check Inventory
        </Button>
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── Compliance Tab ───────────────────────────────────────────────────────────

function ComplianceTab() {
  const { toast } = useToast();
  const [regulationText, setRegulationText] = useState(
    "GDPR Article 17 — Right to erasure ('right to be forgotten')…"
  );
  const [businessContext, setBusinessContext] = useState("SaaS platform storing EU user data");
  const [operation, setOperation] = useState("data_export");
  const [jurisdiction, setJurisdiction] = useState("EU");
  const [riskDataJson, setRiskDataJson] = useState('{ "data_types": ["PII", "financial"] }');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<zoaClient.ZoaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<zoaClient.ZoaResult>) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        if (r.error) setError(String(r.error));
        else setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        toast({ title: "Error", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  const parseJson = (s: string): Record<string, unknown> => {
    try { return JSON.parse(s); } catch { return { raw: s }; }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono font-bold text-foreground">Compliance Agent</h3>
        <GradeBadge grade="NOT TESTED" />
      </div>

      <div className="space-y-2">
        <SectionLabel>Interpret Regulation</SectionLabel>
        <Textarea
          className={textareaCls}
          rows={3}
          value={regulationText}
          onChange={(e) => setRegulationText(e.target.value)}
          placeholder="Paste regulation text…"
        />
        <div>
          <SectionLabel>Business Context</SectionLabel>
          <Input
            className={inputCls}
            value={businessContext}
            onChange={(e) => setBusinessContext(e.target.value)}
            placeholder="SaaS platform storing EU user data"
          />
        </div>
        <Button
          size="sm"
          className="text-xs font-mono"
          disabled={loading}
          onClick={() =>
            run(() => zoaClient.interpretRegulation(regulationText, businessContext))
          }
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
          Interpret Regulation
        </Button>
      </div>

      <div className="space-y-2">
        <SectionLabel>Assess Risk</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <SectionLabel>Operation</SectionLabel>
            <Input
              className={inputCls}
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
              placeholder="data_export"
            />
          </div>
          <div>
            <SectionLabel>Jurisdiction</SectionLabel>
            <Input
              className={inputCls}
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              placeholder="EU"
            />
          </div>
        </div>
        <div>
          <SectionLabel>Data (JSON)</SectionLabel>
          <Input
            className={inputCls}
            value={riskDataJson}
            onChange={(e) => setRiskDataJson(e.target.value)}
            placeholder='{ "data_types": ["PII"] }'
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono border-border"
          disabled={loading}
          onClick={() =>
            run(() => zoaClient.assessRisk(operation, jurisdiction, parseJson(riskDataJson)))
          }
        >
          Assess Risk
        </Button>
      </div>

      <ResultPanel result={result} loading={loading} error={error} />
    </div>
  );
}

// ─── Agent Health Bar ─────────────────────────────────────────────────────────

const AGENT_IDS = ["billing", "scheduling", "payroll", "hr", "procurement", "compliance"];

function AgentHealthBar({ agents }: { agents: AgentStatus[] }) {
  const dotColor: Record<AgentStatus["state"], string> = {
    operational: "bg-emerald-400",
    degraded: "bg-amber-400 animate-pulse",
    offline: "bg-red-500",
  };
  const ringColor: Record<AgentStatus["state"], string> = {
    operational: "border-emerald-500/30",
    degraded: "border-amber-500/30",
    offline: "border-red-500/30",
  };

  return (
    <div className="px-6 py-3 border-b border-border bg-card/50">
      <div className="flex items-center gap-1 mb-1.5">
        <Zap className="w-3 h-3 text-primary" />
        <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">
          Agent Swarm Status
        </span>
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        {agents.map((a) => (
          <div key={a.id} className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${dotColor[a.state]} ring-1 ${ringColor[a.state]}`}
            />
            <span className="text-[10px] font-mono text-muted-foreground capitalize">
              {a.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Event Feed ───────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  billing: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  payroll: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  compliance: "bg-red-500/10 text-red-400 border-red-500/30",
  scheduling: "bg-violet-500/10 text-violet-400 border-violet-500/30",
  hr: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  procurement: "bg-orange-500/10 text-orange-400 border-orange-500/30",
};

function eventColor(eventType: string): string {
  const key = Object.keys(EVENT_COLORS).find((k) => eventType.toLowerCase().includes(k));
  return key ? EVENT_COLORS[key] : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
}

function payloadSummary(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).slice(0, 3);
  return keys.map((k) => `${k}: ${String(payload[k]).slice(0, 20)}`).join(" · ");
}

function EventFeed({ events }: { events: ZoaEvent[] }) {
  return (
    <div className="px-6 py-4 border-t border-border">
      <div className="flex items-center gap-1.5 mb-3">
        <Activity className="w-3 h-3 text-muted-foreground" />
        <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">
          Context Bus — Cross-Agent Events
        </span>
        <span className="ml-auto text-[9px] font-mono text-zinc-600">
          polling 10s
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-[10px] font-mono text-zinc-600 italic">No events yet — agents are idle.</p>
      ) : (
        <div className="space-y-1.5">
          {events.slice(0, 10).map((ev, i) => (
            <div
              key={i}
              className="flex items-start gap-2 p-2 bg-card border border-border rounded hover:border-border/80 transition-colors"
            >
              <span
                className={`inline-flex items-center text-[9px] font-mono border px-1.5 py-0.5 rounded shrink-0 ${eventColor(ev.event_type)}`}
              >
                {ev.event_type}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground flex-1 truncate">
                {payloadSummary(ev.payload)}
              </span>
              <span className="text-[9px] font-mono text-zinc-600 shrink-0">
                {new Date(ev.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Need Activity icon
import { Activity } from "lucide-react";

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ZoaPage() {
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[]>(
    AGENT_IDS.map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      state: "offline" as const,
    }))
  );
  const [pendingEvents, setPendingEvents] = useState<ZoaEvent[]>([]);

  // Poll health every 30s
  useEffect(() => {
    const fetchHealth = async () => {
      const health = await zoaClient.getZoaHealth();
      setAgentStatuses(
        AGENT_IDS.map((id) => ({
          id,
          label: id.charAt(0).toUpperCase() + id.slice(1),
          state: health.agents.includes(id)
            ? "operational"
            : health.status === "degraded"
            ? "degraded"
            : "offline",
        }))
      );
    };
    fetchHealth();
    const t = setInterval(fetchHealth, 30_000);
    return () => clearInterval(t);
  }, []);

  // Poll events every 10s
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_ZOA_SERVICE_URL || "http://localhost:8001/api/v1/zoa"}/events/dashboard`
        );
        if (res.ok) {
          const data: ZoaEvent[] = await res.json();
          setPendingEvents(data);
        }
      } catch {
        // silently ignore — backend may not be running
      }
    };
    fetchEvents();
    const t = setInterval(fetchEvents, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Layout>
      <PageHeader
        title="ZOA Command"
        subtitle="Specialized agent swarm — benchmarked before deployment"
        action={
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded">
            <Zap className="w-3 h-3 text-primary" />
            <span className="text-[10px] font-mono text-primary font-bold">ZOA v1</span>
          </div>
        }
      />

      <AgentHealthBar agents={agentStatuses} />

      <div className="p-6">
        <Tabs defaultValue="billing">
          <TabsList className="bg-card border border-border mb-6 h-auto p-1 gap-0.5">
            {[
              { value: "billing", label: "Billing" },
              { value: "scheduling", label: "Scheduling" },
              { value: "payroll", label: "Payroll" },
              { value: "hr", label: "HR" },
              { value: "procurement", label: "Procurement" },
              { value: "compliance", label: "Compliance" },
            ].map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="text-[11px] font-mono px-3 py-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="bg-card border border-border rounded-lg p-5">
            <TabsContent value="billing" className="mt-0">
              <BillingTab />
            </TabsContent>
            <TabsContent value="scheduling" className="mt-0">
              <SchedulingTab />
            </TabsContent>
            <TabsContent value="payroll" className="mt-0">
              <PayrollTab />
            </TabsContent>
            <TabsContent value="hr" className="mt-0">
              <HRTab />
            </TabsContent>
            <TabsContent value="procurement" className="mt-0">
              <ProcurementTab />
            </TabsContent>
            <TabsContent value="compliance" className="mt-0">
              <ComplianceTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      <EventFeed events={pendingEvents} />
    </Layout>
  );
}
