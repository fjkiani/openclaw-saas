import { useState, useEffect, useCallback, useRef } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Zap, AlertTriangle, CheckCircle, Clock, Hammer, PenLine, Cpu, ShieldAlert, Wrench, RefreshCw } from "lucide-react";
import * as zoaClient from "@/lib/zoaClient";
import type { ZoaEvent, FactoryRun, WritingRun, WritingTone, WritingPlatform, KairosPhase, KairosEvent, KairosRunStatus } from "@/lib/zoaClient";
import {
  runKairos, getKairosRun, streamKairosRun, listKairosRuns,
  getTenants, getTenantSkills, getSkillBenchmarkResult,
  TenantRecord, TenantSkillRecord, BenchmarkResult,
} from "@/lib/zoaClient";

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

// ─── Skill Factory Tab ────────────────────────────────────────────────────────

const FORGE_STAGE_LABELS: Record<string, string> = {
  pending: "Queued",
  generating: "Generating skill code…",
  validating: "L0 TypeScript validation…",
  fixing: "Auto-fixing errors…",
  benchmarking: "Running L1–L4 benchmarks…",
  cataloging: "Cataloging to OpenClaw…",
  completed: "Skill certified",
  failed: "Pipeline failed",
};

function ForgeStatusBar({ run }: { run: FactoryRun }) {
  const stages: FactoryRun["status"][] = [
    "generating",
    "validating",
    "benchmarking",
    "cataloging",
    "completed",
  ];
  const idx = stages.indexOf(run.status);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-zinc-400">{FORGE_STAGE_LABELS[run.stage] ?? run.stage}</span>
        {run.benchmarkResult && (
          <GradeBadge grade={run.benchmarkResult.grade as BenchmarkGrade} />
        )}
      </div>
      <div className="flex gap-1">
        {stages.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-all duration-500 ${
              run.status === "failed"
                ? i <= idx
                  ? "bg-red-500"
                  : "bg-zinc-800"
                : i < idx
                ? "bg-emerald-500"
                : i === idx
                ? "bg-primary animate-pulse"
                : "bg-zinc-800"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function SkillFactoryTab() {
  const [description, setDescription] = useState("");
  const [runs, setRuns] = useState<FactoryRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [forging, setForging] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  // Load recent runs on mount
  useEffect(() => {
    zoaClient.listForgeRuns().then(setRuns).catch(() => {});
  }, []);

  // Poll active run
  useEffect(() => {
    if (!activeRunId) return;
    pollRef.current = setInterval(async () => {
      try {
        const run = await zoaClient.getForgeStatus(activeRunId);
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.runId === run.runId);
          if (idx === -1) return [run, ...prev];
          const next = [...prev];
          next[idx] = run;
          return next;
        });
        if (run.status === "completed" || run.status === "failed") {
          clearInterval(pollRef.current!);
          setActiveRunId(null);
          setForging(false);
          toast({
            title: run.status === "completed" ? "Skill forged!" : "Forge failed",
            description:
              run.status === "completed"
                ? `${run.skill?.name ?? "Skill"} — ${run.benchmarkResult?.grade ?? "benchmarked"}`
                : run.error ?? "Pipeline error",
            variant: run.status === "completed" ? "default" : "destructive",
          });
        }
      } catch {
        // backend may be starting up
      }
    }, 2000);
    return () => clearInterval(pollRef.current!);
  }, [activeRunId, toast]);

  const handleForge = async () => {
    if (!description.trim()) return;
    setForging(true);
    try {
      const { runId } = await zoaClient.forgeSkill(description.trim());
      setActiveRunId(runId);
      setRuns((prev) => [
        {
          runId,
          description: description.trim(),
          status: "pending",
          stage: "pending",
          retryCount: 0,
          createdAt: Date.now(),
        },
        ...prev,
      ]);
      setDescription("");
      toast({ title: "Forge started", description: `Run ${runId.slice(0, 8)}…` });
    } catch (err) {
      setForging(false);
      toast({
        title: "Failed to start forge",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  const activeRun = runs.find((r) => r.runId === activeRunId) ?? runs[0] ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
          <Hammer className="w-4 h-4 text-primary" />
          Zeta Skill Forge
        </h3>
        <p className="text-[11px] text-muted-foreground mb-3">
          Describe a skill in plain English. The pipeline generates TypeScript, runs L0 syntax
          validation, benchmarks L1–L4, and catalogs certified skills automatically.
        </p>
        <div className="flex gap-2">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A skill that extracts invoice line items from unstructured text and returns structured JSON with amount, description, and tax fields"
            className="font-mono text-xs min-h-[80px] resize-none"
            disabled={forging}
          />
        </div>
        <Button
          onClick={handleForge}
          disabled={forging || !description.trim()}
          className="mt-2 text-xs font-mono"
          size="sm"
        >
          {forging ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Forging…
            </>
          ) : (
            <>
              <Zap className="w-3 h-3 mr-1.5" />
              Forge Skill
            </>
          )}
        </Button>
      </div>

      {activeRun && (
        <div className="border border-border rounded-lg p-4 space-y-3 bg-card/50">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-mono text-muted-foreground">
                Run {activeRun.runId.slice(0, 8)}
              </p>
              <p className="text-xs text-foreground mt-0.5 line-clamp-2">
                {activeRun.description}
              </p>
            </div>
            <span
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                activeRun.status === "completed"
                  ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                  : activeRun.status === "failed"
                  ? "text-red-400 border-red-500/30 bg-red-500/10"
                  : "text-primary border-primary/30 bg-primary/10"
              }`}
            >
              {activeRun.status.toUpperCase()}
            </span>
          </div>
          <ForgeStatusBar run={activeRun} />
          {activeRun.skill && (
            <div className="bg-zinc-900/60 rounded p-3 space-y-1">
              <p className="text-[10px] font-mono text-primary font-bold">
                {activeRun.skill.name}
              </p>
              <p className="text-[10px] text-muted-foreground">{activeRun.skill.description}</p>
              <p className="text-[9px] font-mono text-zinc-500">
                Category: {activeRun.skill.category}
              </p>
            </div>
          )}
          {activeRun.l0Result && !activeRun.l0Result.l0_pass && (
            <div className="text-[10px] font-mono text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded p-2">
              L0 error: {activeRun.l0Result.error}
            </div>
          )}
          {activeRun.error && (
            <div className="text-[10px] font-mono text-red-400 bg-red-500/5 border border-red-500/20 rounded p-2">
              {activeRun.error}
            </div>
          )}
        </div>
      )}

      {runs.length > 1 && (
        <div>
          <p className="text-[10px] font-mono text-muted-foreground mb-2">Recent runs</p>
          <div className="space-y-1.5">
            {runs.slice(1, 6).map((run) => (
              <div
                key={run.runId}
                className="flex items-center justify-between text-[10px] font-mono border border-border/50 rounded px-3 py-1.5 bg-card/30"
              >
                <span className="text-zinc-400 truncate max-w-[60%]">
                  {run.description.slice(0, 60)}…
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {run.benchmarkResult && (
                    <GradeBadge grade={run.benchmarkResult.grade as BenchmarkGrade} />
                  )}
                  <span
                    className={`${
                      run.status === "completed"
                        ? "text-emerald-400"
                        : run.status === "failed"
                        ? "text-red-400"
                        : "text-primary"
                    }`}
                  >
                    {run.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Kairos Execution Tab ─────────────────────────────────────────────────────

const KAIROS_PHASES: KairosPhase[] = ["planning", "acting", "observing", "refining", "done"];

const PHASE_COLOR: Record<KairosPhase, string> = {
  idle:      "text-muted-foreground",
  planning:  "text-blue-400",
  acting:    "text-yellow-400",
  observing: "text-purple-400",
  refining:  "text-orange-400",
  done:      "text-green-400",
  failed:    "text-red-400",
};

const PHASE_BG: Record<KairosPhase, string> = {
  idle:      "bg-muted",
  planning:  "bg-blue-500",
  acting:    "bg-yellow-500",
  observing: "bg-purple-500",
  refining:  "bg-orange-500",
  done:      "bg-green-500",
  failed:    "bg-red-500",
};

function KairosPhaseBar({ phase }: { phase: KairosPhase }) {
  const activeIdx = KAIROS_PHASES.indexOf(phase === "failed" ? "done" : phase);
  return (
    <div className="flex items-center gap-1">
      {KAIROS_PHASES.map((p, i) => (
        <div key={p} className="flex items-center gap-1">
          <div className={`h-2 w-8 rounded-full transition-all duration-300 ${
            phase === "failed" && p === "done" ? "bg-red-500" :
            i <= activeIdx ? PHASE_BG[phase] : "bg-muted"
          }`} />
          <span className={`text-[9px] font-mono uppercase ${i <= activeIdx ? PHASE_COLOR[phase] : "text-muted-foreground/40"}`}>
            {p}
          </span>
        </div>
      ))}
    </div>
  );
}

function BenchmarkExplainer({ result }: { result: BenchmarkResult }) {
  const grade = result.grade;
  const levelScores = result.levelScores as Record<string, number> | null;

  const explanations: Record<string, string> = {
    CERTIFIED: "Passed all L1–L4 benchmark tests. Cleared for production execution.",
    CONDITIONAL: "Passed with caveats. Review L3/L4 scores before running in production.",
    FAILED: "Failed benchmark testing. Execution is blocked. Reforge via Archon to re-certify.",
    INCONCLUSIVE: "Benchmark completed but results were inconclusive. Re-run recommended.",
  };

  if (!grade) {
    return <p className="text-[9px] font-mono text-muted-foreground">Not yet benchmarked. Install on a tenant to trigger a benchmark run.</p>;
  }

  return (
    <div className="space-y-0.5">
      <p className="text-[9px] font-mono text-muted-foreground">{explanations[grade] ?? grade}</p>
      {levelScores && (
        <div className="flex gap-3 flex-wrap">
          {Object.entries(levelScores).map(([k, v]) => (
            <span key={k} className="text-[8px] font-mono text-muted-foreground">
              {k.toUpperCase()}: <span className={Number(v) >= 60 ? "text-green-400" : "text-red-400"}>{v}</span>
            </span>
          ))}
        </div>
      )}
      {result.overallScore !== null && result.overallScore !== undefined && (
        <p className="text-[8px] font-mono text-muted-foreground">Overall: {result.overallScore}</p>
      )}
    </div>
  );
}

function useBenchmarkGrade(skillId: number | null): { grade: string | null; loading: boolean } {
  const [grade, setGrade] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!skillId) { setGrade(null); return; }
    setLoading(true);
    getSkillBenchmarkResult(skillId)
      .then(r => setGrade(r.grade))
      .catch(() => setGrade(null))
      .finally(() => setLoading(false));
  }, [skillId]);
  return { grade, loading };
}

function KairosRunHistory({ tenantId, skillSlug }: { tenantId: number | null; skillSlug: string }) {
  const [runs, setRuns] = useState<KairosRunStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [inspecting, setInspecting] = useState<KairosRunStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRuns = async () => {
    if (!tenantId) return;
    try {
      const data = await listKairosRuns(skillSlug || undefined, String(tenantId));
      setRuns((data.runs ?? []) as unknown as KairosRunStatus[]);
    } catch { /* silent */ }
  };

  useEffect(() => {
    if (!tenantId) { setRuns([]); return; }
    setLoading(true);
    fetchRuns().finally(() => setLoading(false));
    intervalRef.current = setInterval(fetchRuns, 10000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [tenantId, skillSlug]);

  if (!tenantId) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-muted-foreground uppercase">Run History</p>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>

      {inspecting && (
        <div className="rounded border border-border bg-black/20 p-2 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-mono text-muted-foreground uppercase">Run Detail</p>
            <button className="text-[9px] font-mono text-muted-foreground hover:text-foreground" onClick={() => setInspecting(null)}>✕ close</button>
          </div>
          <p className="text-[9px] font-mono"><span className="text-muted-foreground">run_id:</span> {inspecting.run_id}</p>
          <p className="text-[9px] font-mono"><span className="text-muted-foreground">phase:</span> {inspecting.phase}</p>
          <p className="text-[9px] font-mono"><span className="text-muted-foreground">degraded:</span> {String(inspecting.degraded)}</p>
          <p className="text-[9px] font-mono"><span className="text-muted-foreground">violations:</span> {inspecting.violations?.length ?? 0}</p>
          {inspecting.result && (
            <p className="text-[9px] font-mono text-green-400/80 whitespace-pre-wrap">{String(inspecting.result).slice(0, 300)}</p>
          )}
          {inspecting.error && (
            <p className="text-[9px] font-mono text-red-400/80">{inspecting.error}</p>
          )}
        </div>
      )}

      {runs.length === 0 ? (
        <p className="text-[9px] font-mono text-muted-foreground">No runs yet for this workspace.</p>
      ) : (
        <div className="rounded border border-border overflow-hidden">
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-2 py-1 text-muted-foreground">Run ID</th>
                <th className="text-left px-2 py-1 text-muted-foreground">Phase</th>
                <th className="text-left px-2 py-1 text-muted-foreground">Degraded</th>
                <th className="text-left px-2 py-1 text-muted-foreground">Started</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r: any) => (
                <tr key={r.run_id} className="border-b border-border/50 hover:bg-muted/10">
                  <td className="px-2 py-1 text-muted-foreground">{r.run_id?.slice(0, 8)}…</td>
                  <td className="px-2 py-1">
                    <span className={r.phase === "done" ? "text-green-400" : r.phase === "failed" ? "text-red-400" : "text-yellow-400"}>
                      {r.phase ?? r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    {r.degraded ? <span className="text-orange-400">DEGRADED</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {r.started_at ? new Date(r.started_at).toLocaleTimeString() : "—"}
                  </td>
                  <td className="px-2 py-1">
                    <button className="text-[8px] text-primary hover:underline" onClick={() => setInspecting(r)}>Inspect</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KairosTab() {
  const { toast } = useToast();

  // ── Tenant + skill selection (control plane) ──────────────────────────────
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [tenantSkills, setTenantSkills] = useState<TenantSkillRecord[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<number | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingBenchmark, setLoadingBenchmark] = useState(false);

  // ── Run state ─────────────────────────────────────────────────────────────
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<KairosPhase>("idle");
  const [events, setEvents] = useState<KairosEvent[]>([]);
  const [violations, setViolations] = useState<Array<{ tool_name: string; reason: string; benchmark_score: number }>>([]);
  const [toolCalls, setToolCalls] = useState<Array<{ name: string; result: string; permitted: boolean }>>([]);
  const [finalText, setFinalText] = useState("");
  const [runStatus, setRunStatus] = useState<KairosRunStatus | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"events" | "tools" | "violations">("events");
  const cleanupRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  // ── Load tenants on mount ─────────────────────────────────────────────────
  useEffect(() => {
    setLoadingTenants(true);
    getTenants()
      .then(setTenants)
      .catch(err => toast({ title: "Could not load tenants", description: String(err), variant: "destructive" }))
      .finally(() => setLoadingTenants(false));
  }, []);

  // ── Load skills when tenant changes ──────────────────────────────────────
  useEffect(() => {
    if (selectedTenantId === null) { setTenantSkills([]); setSelectedSkillId(null); return; }
    setLoadingSkills(true);
    setSelectedSkillId(null);
    setBenchmarkResult(null);
    getTenantSkills(selectedTenantId)
      .then(setTenantSkills)
      .catch(err => toast({ title: "Could not load skills", description: String(err), variant: "destructive" }))
      .finally(() => setLoadingSkills(false));
  }, [selectedTenantId]);

  // ── Load benchmark when skill changes ────────────────────────────────────
  useEffect(() => {
    if (selectedSkillId === null) { setBenchmarkResult(null); return; }
    setLoadingBenchmark(true);
    getSkillBenchmarkResult(selectedSkillId)
      .then(setBenchmarkResult)
      .catch(() => setBenchmarkResult({ grade: null, overallScore: null, levelScores: null, status: "not_tested" }))
      .finally(() => setLoadingBenchmark(false));
  }, [selectedSkillId]);

  const reset = () => {
    setPhase("idle"); setEvents([]); setViolations([]); setToolCalls([]);
    setFinalText(""); setRunStatus(null);
  };

  const startPolling = (runId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await getKairosRun(runId);
        setPhase(s.phase);
        if (s.status === "done" || s.status === "failed") {
          setRunStatus(s);
          setFinalText(s.result || "");
          setRunning(false);
          clearInterval(pollRef.current!);
          toast({ title: s.status === "done" ? "Run complete" : "Run failed", description: s.error || undefined, variant: s.status === "failed" ? "destructive" : undefined });
        }
      } catch { /* ignore poll errors */ }
    }, 1000);
  };

  // Derive execution eligibility from stored benchmark — never from user input
  const selectedSkillRecord = tenantSkills.find(ts => ts.skillId === selectedSkillId);
  const selectedSkillSlug = selectedSkillRecord?.skill?.slug ?? (selectedSkillId ? String(selectedSkillId) : "");
  const grade = benchmarkResult?.grade ?? null;
  const isFailed = grade === "FAILED";
  const isNotTested = !grade || grade === null;
  const isEligible = selectedTenantId !== null && selectedSkillId !== null && !isFailed;

  // Resolve scores from stored benchmark for the run request
  const resolvedScores = {
    l4_score: benchmarkResult?.levelScores?.l4 ?? benchmarkResult?.levelScores?.L4 ?? (grade === "CERTIFIED" ? 8.0 : grade === "CONDITIONAL" ? 6.5 : grade === "FAILED" ? 3.0 : 0.0),
    l2_score: benchmarkResult?.levelScores?.l2 ?? benchmarkResult?.levelScores?.L2 ?? (grade === "CERTIFIED" ? 85 : grade === "CONDITIONAL" ? 65 : 0),
    l3_score: benchmarkResult?.levelScores?.l3 ?? benchmarkResult?.levelScores?.L3 ?? (grade === "CERTIFIED" ? 85 : grade === "CONDITIONAL" ? 65 : 0),
  };

  const handleRun = async () => {
    if (!goal.trim() || !selectedTenantId || !selectedSkillId) return;
    reset();
    setRunning(true);
    try {
      const started = await runKairos({
        skill_id: selectedSkillSlug,
        goal: goal.trim(),
        tenant_id: String(selectedTenantId),
        l4_score: resolvedScores.l4_score,
        l2_score: resolvedScores.l2_score,
        l3_score: resolvedScores.l3_score,
        max_turns: 10,
      });
      toast({ title: "Kairos run started", description: `run_id: ${started.run_id.slice(0, 8)}…` });

      let sseWorking = false;
      cleanupRef.current = streamKairosRun(
        started.run_id,
        (ev) => {
          sseWorking = true;
          setEvents(prev => [...prev, ev]);
          if (ev.type === "phase_change") setPhase((ev.payload as { phase: KairosPhase }).phase);
          if (ev.type === "text_chunk") setFinalText(prev => prev + ((ev.payload as { text: string }).text || ""));
          if (ev.type === "tool_end") {
            const d = ev.payload as { name: string; result: string; permitted: boolean };
            setToolCalls(prev => [...prev, { name: d.name, result: d.result, permitted: d.permitted }]);
          }
          if (ev.type === "permission_violation") {
            const d = ev.payload as { tool_name: string; reason: string; benchmark_score: number };
            setViolations(prev => [...prev, d]);
          }
          setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 30);
        },
        (finalStatus) => {
          setRunning(false);
          if (finalStatus) {
            setRunStatus(finalStatus as unknown as KairosRunStatus);
            setPhase((finalStatus as unknown as KairosRunStatus).phase || "done");
          }
        },
        () => { if (!sseWorking) startPolling(started.run_id); }
      );
    } catch (err) {
      setRunning(false);
      setPhase("failed");
      toast({ title: "Failed to start run", description: String(err), variant: "destructive" });
    }
  };

  const handleStop = () => {
    cleanupRef.current?.();
    if (pollRef.current) clearInterval(pollRef.current);
    setRunning(false);
    setPhase("failed");
  };

  // ── Benchmark grade badge ─────────────────────────────────────────────────
  const gradeColor: Record<string, string> = {
    CERTIFIED: "border-green-500/50 text-green-400",
    CONDITIONAL: "border-yellow-500/50 text-yellow-400",
    FAILED: "border-red-500/50 text-red-400",
    INCONCLUSIVE: "border-gray-500/50 text-gray-400",
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-mono font-bold flex items-center gap-2">
            <Cpu className="w-4 h-4 text-yellow-400" />
            Kairos Execution Engine
          </h3>
          <p className="text-[10px] text-muted-foreground mt-0.5">Plan → Act → Observe → Refine</p>
        </div>
        <div className={`text-[10px] font-mono font-bold uppercase tracking-widest ${PHASE_COLOR[phase]}`}>
          {phase}
        </div>
      </div>

      {/* Phase bar */}
      <KairosPhaseBar phase={phase} />

      {/* Tenant selector */}
      <div className="space-y-1">
        <label className="text-[10px] font-mono text-muted-foreground uppercase">Workspace (Tenant)</label>
        <select
          className="w-full h-7 text-xs font-mono bg-background border border-input rounded px-2 disabled:opacity-50"
          value={selectedTenantId ?? ""}
          onChange={e => setSelectedTenantId(e.target.value ? Number(e.target.value) : null)}
          disabled={running || loadingTenants}
        >
          <option value="">{loadingTenants ? "Loading…" : "Select workspace…"}</option>
          {tenants.map(t => (
            <option key={t.id} value={t.id}>{t.name} ({t.status})</option>
          ))}
        </select>
      </div>

      {/* Skill selector */}
      <div className="space-y-1">
        <label className="text-[10px] font-mono text-muted-foreground uppercase">Installed Skill</label>
        <select
          className="w-full h-7 text-xs font-mono bg-background border border-input rounded px-2 disabled:opacity-50"
          value={selectedSkillId ?? ""}
          onChange={e => setSelectedSkillId(e.target.value ? Number(e.target.value) : null)}
          disabled={running || loadingSkills || selectedTenantId === null}
        >
          <option value="">
            {selectedTenantId === null ? "Select workspace first" : loadingSkills ? "Loading…" : tenantSkills.length === 0 ? "No skills installed" : "Select skill…"}
          </option>
          {tenantSkills.map(ts => (
            <option key={ts.skillId} value={ts.skillId}>
              {ts.skill?.name ?? `Skill #${ts.skillId}`} — {ts.skill?.category ?? ""}
            </option>
          ))}
        </select>
      </div>

      {/* Benchmark grade — server-side, read-only */}
      {selectedSkillId !== null && (
        <div className="rounded border border-border p-2 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground uppercase">Benchmark Status</span>
            {loadingBenchmark ? (
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            ) : (
              <Badge variant="outline" className={`text-[9px] ${gradeColor[grade ?? ""] ?? "border-gray-500/50 text-gray-400"}`}>
                {grade ?? "NOT TESTED"}
              </Badge>
            )}
          </div>
          {benchmarkResult && (
            <BenchmarkExplainer result={benchmarkResult} />
          )}
          {isFailed && (
            <p className="text-[9px] text-red-400 font-mono">Execution blocked — skill failed benchmark. Reforge via Archon to re-certify.</p>
          )}
        </div>
      )}

      {/* Goal input */}
      <div className="space-y-1">
        <label className="text-[10px] font-mono text-muted-foreground uppercase">Goal</label>
        <Textarea value={goal} onChange={e => setGoal(e.target.value)}
          placeholder="Describe what Kairos should accomplish…"
          className="text-xs font-mono min-h-[64px] resize-none" disabled={running} />
      </div>

      {/* Run button */}
      <div className="flex gap-2 items-center">
        <Button size="sm" className="h-7 text-xs font-mono"
          onClick={handleRun}
          disabled={running || !goal.trim() || !isEligible}>
          {running ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Zap className="w-3 h-3 mr-1" />}
          {running ? "Running…" : "Run Kairos"}
        </Button>
        {running && (
          <Button size="sm" variant="outline" className="h-7 text-xs font-mono" onClick={handleStop}>Stop</Button>
        )}
        {!selectedTenantId && <span className="text-[10px] text-muted-foreground font-mono">Select a workspace</span>}
        {selectedTenantId && !selectedSkillId && <span className="text-[10px] text-muted-foreground font-mono">Select a skill</span>}
        {isFailed && <span className="text-[10px] text-red-400 font-mono">FAILED benchmark — execution blocked</span>}
      </div>

      {/* Result summary */}
      {runStatus && (
        <div className={`rounded border p-3 text-xs font-mono space-y-1 ${
          runStatus.status === "done" ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"
        }`}>
          <div className="flex items-center gap-2">
            {runStatus.status === "done"
              ? <CheckCircle className="w-3 h-3 text-green-400" />
              : <AlertTriangle className="w-3 h-3 text-red-400" />}
            <span className="font-bold">{runStatus.status === "done" ? "Completed" : "Failed"}</span>
            {runStatus.degraded && (
              <Badge variant="outline" className="text-[9px] border-orange-500/50 text-orange-400">DEGRADED</Badge>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Turns: {runStatus.turn_count} · Tools: {runStatus.tool_calls_made} · Violations: {runStatus.violations.length}
          </div>
          {runStatus.error && <div className="text-[10px] text-red-400">{runStatus.error}</div>}
          {runStatus.archon_reforge_ready && (
            <Button size="sm" variant="outline"
              className="h-6 text-[10px] font-mono border-orange-500/50 text-orange-400 hover:bg-orange-500/10 mt-1"
              onClick={() => {
                const ctx = runStatus.archon_context;
                toast({ title: "Archon Reforge", description: `Reforge payload ready for skill ${ctx?.skill_id}. Connect Archon endpoint to execute.` });
              }}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Reforge via Archon
            </Button>
          )}
        </div>
      )}

      {/* Sub-tabs: events / tools / violations */}
      {events.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-1">
            {(["events", "tools", "violations"] as const).map(tab => (
              <button key={tab}
                className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded border transition-colors ${
                  activeSubTab === tab ? "border-primary text-primary" : "border-border text-muted-foreground hover:border-primary/50"
                }`}
                onClick={() => setActiveSubTab(tab)}>
                {tab} {tab === "violations" && violations.length > 0 ? `(${violations.length})` : ""}
              </button>
            ))}
          </div>

          {activeSubTab === "events" && (
            <div className="rounded border border-border bg-black/20 p-2 max-h-48 overflow-y-auto space-y-0.5">
              {events.map((ev, i) => (
                <div key={i} className="text-[9px] font-mono text-muted-foreground">
                  <span className="text-yellow-400/70">[{ev.type}]</span>{" "}
                  {JSON.stringify(ev.payload).slice(0, 120)}
                </div>
              ))}
              <div ref={streamEndRef} />
            </div>
          )}

          {activeSubTab === "tools" && (
            <div className="rounded border border-border bg-black/20 p-2 max-h-48 overflow-y-auto space-y-1">
              {toolCalls.length === 0
                ? <p className="text-[9px] text-muted-foreground font-mono">No tool calls yet</p>
                : toolCalls.map((tc, i) => (
                  <div key={i} className={`text-[9px] font-mono flex gap-2 ${tc.permitted ? "text-green-400/80" : "text-red-400/80"}`}>
                    <span>{tc.permitted ? "✓" : "✗"}</span>
                    <span className="font-bold">{tc.name}</span>
                    <span className="text-muted-foreground truncate">{String(tc.result).slice(0, 80)}</span>
                  </div>
                ))
              }
            </div>
          )}

          {activeSubTab === "violations" && (
            <div className="rounded border border-border bg-black/20 p-2 max-h-48 overflow-y-auto space-y-1">
              {violations.length === 0
                ? <p className="text-[9px] text-muted-foreground font-mono">No violations</p>
                : violations.map((v, i) => (
                  <div key={i} className="text-[9px] font-mono text-red-400/80 space-y-0.5">
                    <div className="font-bold">{v.tool_name}</div>
                    <div className="text-muted-foreground">{v.reason}</div>
                    <div>score: {v.benchmark_score}</div>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      )}

      {/* Final text output */}
      {finalText && (
        <div className="rounded border border-border bg-black/20 p-2">
          <p className="text-[9px] font-mono text-muted-foreground uppercase mb-1">Result</p>
          <p className="text-xs font-mono whitespace-pre-wrap">{finalText}</p>
        </div>
      )}

      {/* Run history */}
      <KairosRunHistory tenantId={selectedTenantId} skillSlug={selectedSkillSlug} />
    </div>
  );
}

// ─── ZOA-W Writing Tab ────────────────────────────────────────────────────────

const WRITING_STAGE_LABELS: Record<string, string> = {
  pending: "Queued",
  running: "Pipeline running…",
  outline: "Outlining…",
  draft: "Drafting…",
  critique: "Critiquing…",
  refine: "Refining…",
  publish: "Publishing…",
  completed: "Published",
  failed: "Pipeline failed",
};

const TONE_OPTIONS: { value: WritingTone; label: string; desc: string }[] = [
  { value: "zeta_warlord", label: "Zeta Warlord", desc: "Aggressive, commanding, zero fluff" },
  { value: "professional", label: "Professional", desc: "Polished, authoritative" },
  { value: "technical", label: "Technical", desc: "Precise, data-driven" },
  { value: "satirical", label: "Satirical", desc: "Sharp wit, industry critique" },
];

const PLATFORM_OPTIONS: { value: WritingPlatform; label: string }[] = [
  { value: "medium", label: "Medium" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "blog", label: "Blog" },
  { value: "cold_email", label: "Cold Email" },
];

function WritingScoreBar({ score }: { score: number }) {
  const pct = Math.round((score / 10) * 100);
  const color =
    score >= 8 ? "bg-emerald-500" : score >= 6 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-zinc-400 w-8 text-right">{score}/10</span>
    </div>
  );
}

function WritingTab() {
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState<WritingTone>("zeta_warlord");
  const [platform, setPlatform] = useState<WritingPlatform>("linkedin");
  const [maxLoops, setMaxLoops] = useState(3);
  const [run, setRun] = useState<WritingRun | null>(null);
  const [running, setRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<"pipeline" | "critique" | "output">("pipeline");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleRun = async () => {
    if (!topic.trim()) return;
    setRunning(true);
    setRun(null);
    try {
      const { run_id } = await zoaClient.runWritingPipeline(topic.trim(), tone, platform, maxLoops);
      toast({ title: "Writing pipeline started", description: `Run ${run_id.slice(0, 8)}…` });
      pollRef.current = setInterval(async () => {
        try {
          const updated = await zoaClient.getWritingStatus(run_id);
          setRun(updated);
          if (updated.status === "completed" || updated.status === "failed") {
            stopPoll();
            setRunning(false);
            if (updated.status === "completed") {
              setActiveTab("output");
              toast({
                title: "Writing complete!",
                description: `Score: ${updated.final_score ?? "?"}/10 — ${updated.loops_taken ?? 0} refinement loop(s)`,
              });
            } else {
              toast({ title: "Pipeline failed", description: updated.error, variant: "destructive" });
            }
          }
        } catch {
          // backend may be starting
        }
      }, 3000);
    } catch (err) {
      setRunning(false);
      toast({
        title: "Failed to start pipeline",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  useEffect(() => () => stopPoll(), []);

  const stageOrder = ["outline", "draft", "critique", "refine", "publish"];
  const currentStageIdx = run ? stageOrder.indexOf(run.stage) : -1;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
          <PenLine className="w-4 h-4 text-primary" />
          ZOA-W Writing Overlord
        </h3>
        <p className="text-[11px] text-muted-foreground mb-3">
          5-agent pipeline: Outline → Draft → Critique → Refine (loop until ≥8/10) → Publish.
          Powered by Hermes 3 405B, Dolphin Venice, and Arcee Trinity.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-mono text-muted-foreground mb-1 block">Topic</label>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Why most AI agents fail in production"
              className="font-mono text-xs"
              disabled={running}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground mb-1 block">Tone</label>
              <div className="grid grid-cols-2 gap-1">
                {TONE_OPTIONS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setTone(t.value)}
                    disabled={running}
                    className={`text-left px-2 py-1.5 rounded border text-[10px] font-mono transition-colors ${
                      tone === t.value
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-border/80"
                    }`}
                  >
                    <div className="font-semibold">{t.label}</div>
                    <div className="text-[9px] opacity-70 mt-0.5">{t.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-mono text-muted-foreground mb-1 block">Platform</label>
              <div className="grid grid-cols-2 gap-1">
                {PLATFORM_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPlatform(p.value)}
                    disabled={running}
                    className={`px-2 py-1.5 rounded border text-[10px] font-mono transition-colors ${
                      platform === p.value
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-border/80"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="mt-2">
                <label className="text-[10px] font-mono text-muted-foreground mb-1 block">
                  Max refinement loops: {maxLoops}
                </label>
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={maxLoops}
                  onChange={(e) => setMaxLoops(Number(e.target.value))}
                  disabled={running}
                  className="w-full accent-primary"
                />
              </div>
            </div>
          </div>

          <Button
            onClick={handleRun}
            disabled={running || !topic.trim()}
            className="text-xs font-mono"
            size="sm"
          >
            {running ? (
              <>
                <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                Writing…
              </>
            ) : (
              <>
                <PenLine className="w-3 h-3 mr-1.5" />
                Run Pipeline
              </>
            )}
          </Button>
        </div>
      </div>

      {run && (
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Stage progress bar */}
          <div className="p-3 border-b border-border bg-card/50 space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono">
              <span className="text-zinc-400">
                {WRITING_STAGE_LABELS[run.stage] ?? run.stage}
              </span>
              {run.final_score != null && (
                <span className="text-emerald-400">Final: {run.final_score}/10</span>
              )}
            </div>
            <div className="flex gap-1">
              {stageOrder.map((s, i) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-full transition-all duration-500 ${
                    run.status === "failed" && i === currentStageIdx
                      ? "bg-red-500"
                      : i < currentStageIdx
                      ? "bg-emerald-500"
                      : i === currentStageIdx
                      ? "bg-primary animate-pulse"
                      : "bg-zinc-800"
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex border-b border-border">
            {(["pipeline", "critique", "output"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-4 py-2 text-[10px] font-mono capitalize transition-colors ${
                  activeTab === t
                    ? "text-primary border-b-2 border-primary bg-primary/5"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="p-4">
            {activeTab === "pipeline" && (
              <div className="space-y-2">
                {stageOrder.map((s, i) => {
                  const done = i < currentStageIdx || run.status === "completed";
                  const active = i === currentStageIdx && run.status === "running";
                  return (
                    <div
                      key={s}
                      className={`flex items-center gap-2 text-[10px] font-mono ${
                        done
                          ? "text-emerald-400"
                          : active
                          ? "text-primary"
                          : "text-zinc-600"
                      }`}
                    >
                      {done ? (
                        <CheckCircle className="w-3 h-3" />
                      ) : active ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Clock className="w-3 h-3" />
                      )}
                      <span className="capitalize">{s}</span>
                      {s === "critique" && run.critique_score != null && (
                        <span className="ml-auto">{run.critique_score}/10</span>
                      )}
                      {s === "refine" && run.loops_taken != null && (
                        <span className="ml-auto">{run.loops_taken} loop(s)</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === "critique" && run.critique && (
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] font-mono text-muted-foreground mb-1">Score</p>
                  <WritingScoreBar score={run.critique.score} />
                </div>
                <div>
                  <p className="text-[10px] font-mono text-emerald-400 mb-1">Strengths</p>
                  <ul className="space-y-0.5">
                    {run.critique.strengths.map((s, i) => (
                      <li key={i} className="text-[10px] text-zinc-300 flex gap-1.5">
                        <span className="text-emerald-500 shrink-0">+</span>
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[10px] font-mono text-amber-400 mb-1">Fixes applied</p>
                  <ul className="space-y-0.5">
                    {run.critique.specific_fixes.map((f, i) => (
                      <li key={i} className="text-[10px] text-zinc-300 flex gap-1.5">
                        <span className="text-amber-500 shrink-0">→</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="text-[10px] font-mono text-zinc-400 border border-border/50 rounded p-2">
                  Verdict: {run.critique.verdict}
                </div>
              </div>
            )}

            {activeTab === "output" && run.published && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                  <span>
                    {run.published.word_count} words · {run.published.char_count} chars
                  </span>
                  <span className="capitalize">{run.published.platform}</span>
                </div>
                {run.published.subject_line && (
                  <div className="text-[11px] font-semibold text-foreground border-b border-border pb-2">
                    {run.published.subject_line}
                  </div>
                )}
                <pre className="text-[10px] font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-zinc-900/50 rounded p-3">
                  {run.published.formatted_content}
                </pre>
                {run.published.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {run.published.hashtags.map((h) => (
                      <span
                        key={h}
                        className="text-[9px] font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                )}
                <div className="text-[10px] font-mono text-zinc-500 border border-border/50 rounded p-2">
                  CTA: {run.published.cta}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[10px] font-mono"
                  onClick={() => {
                    navigator.clipboard.writeText(run.published!.formatted_content);
                    toast({ title: "Copied to clipboard" });
                  }}
                >
                  Copy Content
                </Button>
              </div>
            )}

            {activeTab === "output" && !run.published && run.status !== "completed" && (
              <p className="text-[10px] font-mono text-muted-foreground">
                Output will appear here once the pipeline completes.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
            <span className="text-[10px] font-mono text-primary font-bold">ZOA v2</span>
          </div>
        }
      />

      <AgentHealthBar agents={agentStatuses} />

      <div className="p-6">
        <Tabs defaultValue="billing">
          <TabsList className="bg-card border border-border mb-6 h-auto p-1 gap-0.5 flex-wrap">
            {[
              { value: "billing", label: "Billing" },
              { value: "scheduling", label: "Scheduling" },
              { value: "payroll", label: "Payroll" },
              { value: "hr", label: "HR" },
              { value: "procurement", label: "Procurement" },
              { value: "compliance", label: "Compliance" },
              { value: "skill-factory", label: "⚡ Skill Forge" },
              { value: "writing", label: "✍ ZOA-W" },
              { value: "kairos", label: "⚙ Kairos" },
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
            <TabsContent value="skill-factory" className="mt-0">
              <SkillFactoryTab />
            </TabsContent>
            <TabsContent value="writing" className="mt-0">
              <WritingTab />
            </TabsContent>
            <TabsContent value="kairos" className="mt-0">
              <KairosTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      <EventFeed events={pendingEvents} />
    </Layout>
  );
}
