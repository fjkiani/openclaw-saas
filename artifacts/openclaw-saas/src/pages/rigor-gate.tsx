/**
 * rigor-gate.tsx — Rigor-Gate verification moat frontend.
 *
 * Full end-to-end UI for all 11 verification workflows:
 *   - Verification Gate (generic_llm, legal_draft, mcp_server, sql_gen)
 *   - Legal Draft Builder
 *   - Legal Counsel Analysis (4-lens orchestrator)
 *   - MCP Server Benchmark (live)
 *   - Reconciliation Gate
 *   - Panel Benchmark
 *   - LLM-as-Judge Baseline (no-cache)
 *   - Methodology Audit
 *   - Baseline Integrity Audit
 *   - Rubric Calibration
 *   - Provider Quota Probe
 *
 * Admin-token gated. All calls go to /api/v1/rigor/*.
 * Nothing is stubbed — every workflow makes a real live API call.
 */

import { useState, useCallback, useEffect } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Activity,
  FlaskConical,
  Scale,
  Server,
  GitCompare,
  Gauge,
  ScanSearch,
  FileSearch,
  SlidersHorizontal,
  Zap,
  Info,
  Clock,
  ArrowRight,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkflowDef {
  id: string;
  name: string;
  method: string;
  path: string;
  description: string;
  domains?: string[];
  input_fields?: InputField[];
  next_steps: string;
}

interface InputField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  options?: string[];
  default?: unknown;
  min?: number;
  max?: number;
}

interface RunRecord {
  id: string;
  workflow: string;
  ts: string;
  status: "ok" | "error";
  duration_ms: number;
  summary: string;
}

// ── Admin token management ───────────────────────────────────────────────────

const TOKEN_KEY = "openclaw-rigor-admin-token";

function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

// ── API helper ───────────────────────────────────────────────────────────────

async function rigorFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-openclaw-admin-token", token);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`/api/v1/rigor${path}`, { ...init, headers });
}

// ── Workflow icon mapping ────────────────────────────────────────────────────

function workflowIcon(id: string) {
  const map: Record<string, React.ComponentType<{ className?: string }>> = {
    verify: ShieldCheck,
    legal_draft: FileSearch,
    legal_counsel: Scale,
    mcp_benchmark: Server,
    reconcile: GitCompare,
    benchmark: Gauge,
    judge_baseline: FlaskConical,
    audit: ScanSearch,
    audit_baseline: Activity,
    audit_rubric: SlidersHorizontal,
    quota: Zap,
  };
  return map[id] ?? Activity;
}

// ── Collapsible section ──────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/30 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        <span className="text-xs font-mono font-semibold text-foreground">{title}</span>
        {badge}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-2">{children}</div>}
    </div>
  );
}

// ── Verdict badge ────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict: string }) {
  const cls =
    verdict === "PASS"
      ? "bg-green-500/10 text-green-600 border-green-500/30"
      : verdict === "FAIL"
        ? "bg-red-500/10 text-red-600 border-red-500/30"
        : "bg-amber-500/10 text-amber-600 border-amber-500/30";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold border px-2 py-0.5 rounded ${cls}`}>
      {verdict === "PASS" && <CheckCircle2 className="w-3 h-3" />}
      {verdict === "FAIL" && <XCircle className="w-3 h-3" />}
      {verdict === "DEGRADED" && <AlertTriangle className="w-3 h-3" />}
      {verdict}
    </span>
  );
}

// ── JSON result viewer ───────────────────────────────────────────────────────

function JsonViewer({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const jsonStr = JSON.stringify(data, null, 2);

  return (
    <pre className="text-[10px] font-mono text-foreground/80 bg-background/50 border border-border rounded p-3 overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words">
      {jsonStr}
    </pre>
  );
}

// ── Next steps panel ─────────────────────────────────────────────────────────

function NextStepsPanel({ steps }: { steps: string }) {
  if (!steps) return null;
  return (
    <div className="rounded border border-blue-500/20 bg-blue-500/5 p-3">
      <div className="flex items-start gap-2">
        <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-[9px] font-mono text-blue-400 uppercase tracking-widest mb-1">Next Steps</p>
          <p className="text-[11px] font-mono text-foreground/80 leading-relaxed">{steps}</p>
        </div>
      </div>
    </div>
  );
}

// ── Run history ──────────────────────────────────────────────────────────────

function RunHistory({ runs, onRefresh }: { runs: RunRecord[]; onRefresh: () => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Recent Runs</p>
        <Button variant="ghost" size="sm" onClick={onRefresh} className="h-6 text-[10px] font-mono">
          <Activity className="w-3 h-3 mr-1" /> Refresh
        </Button>
      </div>
      {runs.length === 0 ? (
        <p className="text-[10px] font-mono text-muted-foreground italic">No runs yet.</p>
      ) : (
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {runs.map((run) => (
            <div key={run.id} className="flex items-center gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50 bg-background/30">
              {run.status === "ok" ? (
                <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
              ) : (
                <XCircle className="w-3 h-3 text-red-500 shrink-0" />
              )}
              <span className="text-foreground/80 font-semibold">{run.workflow}</span>
              <span className="text-muted-foreground">{run.summary}</span>
              <span className="text-muted-foreground ml-auto flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />
                {run.duration_ms}ms
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workflow runner component ────────────────────────────────────────────────

interface RunState {
  loading: boolean;
  result: unknown;
  error: string | null;
  latency: number | null;
}

const emptyRun: RunState = { loading: false, result: null, error: null, latency: null };

function WorkflowRunner({
  workflow,
  token,
  onRunComplete,
}: {
  workflow: WorkflowDef;
  token: string;
  onRunComplete: () => void;
}) {
  const [run, setRun] = useState<RunState>(emptyRun);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const Icon = workflowIcon(workflow.id);

  const updateField = useCallback((name: string, value: unknown) => {
    setFormValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const buildPayload = useCallback((): Record<string, unknown> => {
    const payload: Record<string, unknown> = {};
    for (const field of workflow.input_fields ?? []) {
      if (field.name === "domain") continue; // domain is in the URL path
      const val = formValues[field.name];
      if (val !== undefined && val !== "") {
        payload[field.name] = val;
      } else if (field.default !== undefined) {
        payload[field.name] = field.default;
      }
    }
    return payload;
  }, [workflow, formValues]);

  const runWorkflow = useCallback(async () => {
    if (!token) return;
    setRun({ loading: true, result: null, error: null, latency: null });

    const t0 = Date.now();
    try {
      let path = workflow.path;
      const payload = buildPayload();

      // Handle domain in path
      if (workflow.id === "verify") {
        const domain = formValues["domain"] ?? workflow.input_fields?.[0]?.options?.[0] ?? "generic_llm";
        path = `/verify/${domain}`;
      }

      // For verify, wrap raw in { raw: payload } unless domain-specific
      let body: string;
      if (workflow.id === "verify") {
        const domain = formValues["domain"] ?? "generic_llm";
        // For generic_llm, the raw is the payload itself
        if (domain === "generic_llm") {
          body = JSON.stringify({ raw: { prompt: formValues["prompt"] ?? "What is 2+2?", output: formValues["output"] ?? "TODO: implement this function" } });
        } else if (domain === "sql_gen") {
          body = JSON.stringify({ raw: { query: formValues["query"] ?? "DROP TABLE users;" } });
        } else if (domain === "legal_draft") {
          body = JSON.stringify({ raw: { sections: [{ section_id: "s1", title: "IP", body: "All IP assigned." }] } });
        } else if (domain === "mcp_server") {
          body = JSON.stringify({ raw: { tools: [{ name: "search", description: "Search the web" }] } });
        } else {
          body = JSON.stringify({ raw: payload });
        }
      } else {
        body = JSON.stringify(payload);
      }

      const resp = await rigorFetch(path, token, {
        method: "POST",
        body,
      });

      const latency = Date.now() - t0;
      const data = await resp.json();

      if (!resp.ok) {
        setRun({ loading: false, result: null, error: data.error ?? `HTTP ${resp.status}`, latency });
      } else {
        setRun({ loading: false, result: data, error: null, latency });
      }
      onRunComplete();
    } catch (err: unknown) {
      setRun({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
        latency: Date.now() - t0,
      });
      onRunComplete();
    }
  }, [workflow, token, formValues, buildPayload, onRunComplete]);

  const hasInputs = (workflow.input_fields?.length ?? 0) > 0;

  return (
    <div className="rounded border border-border bg-card/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3 border-b border-border">
        <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-mono font-bold text-foreground">{workflow.name}</h3>
            <Badge variant="outline" className="text-[8px] font-mono">{workflow.method}</Badge>
            <Badge variant="outline" className="text-[8px] font-mono text-muted-foreground">{workflow.path}</Badge>
          </div>
          <p className="text-[11px] font-mono text-muted-foreground mt-1 leading-relaxed">{workflow.description}</p>
        </div>
      </div>

      {/* Input form */}
      {hasInputs && (
        <div className="px-4 py-3 space-y-3 border-b border-border/50">
          {workflow.input_fields?.map((field) => {
            if (field.name === "domain" && field.options) {
              return (
                <div key={field.name}>
                  <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">
                    {field.name} {field.required && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    className="w-full bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2 focus:ring-primary"
                    value={(formValues[field.name] as string) ?? field.options[0] ?? ""}
                    onChange={(e) => updateField(field.name, e.target.value)}
                  >
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                  {field.description && <p className="text-[9px] font-mono text-muted-foreground mt-0.5">{field.description}</p>}
                </div>
              );
            }

            if (field.type === "enum" && field.options) {
              return (
                <div key={field.name}>
                  <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">
                    {field.name} {field.required && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    className="w-full bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2 focus:ring-primary"
                    value={(formValues[field.name] as string) ?? field.default ?? field.options[0] ?? ""}
                    onChange={(e) => updateField(field.name, e.target.value)}
                  >
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                  {field.description && <p className="text-[9px] font-mono text-muted-foreground mt-0.5">{field.description}</p>}
                </div>
              );
            }

            if (field.type === "boolean") {
              return (
                <div key={field.name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`wf-${workflow.id}-${field.name}`}
                    checked={(formValues[field.name] as boolean) ?? (field.default as boolean) ?? false}
                    onChange={(e) => updateField(field.name, e.target.checked)}
                    className="w-3.5 h-3.5 accent-primary"
                  />
                  <label htmlFor={`wf-${workflow.id}-${field.name}`} className="text-[10px] font-mono text-foreground">
                    {field.name} {field.required && <span className="text-red-500">*</span>}
                  </label>
                  {field.description && <span className="text-[9px] font-mono text-muted-foreground">— {field.description}</span>}
                </div>
              );
            }

            if (field.type === "text" || (field.max && field.max > 200)) {
              return (
                <div key={field.name}>
                  <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">
                    {field.name} {field.required && <span className="text-red-500">*</span>}
                  </label>
                  <Textarea
                    className="text-xs font-mono bg-background border-border text-foreground"
                    rows={6}
                    placeholder={field.description ?? `Enter ${field.name}`}
                    value={(formValues[field.name] as string) ?? ""}
                    onChange={(e) => updateField(field.name, e.target.value)}
                  />
                </div>
              );
            }

            // Default: string input
            return (
              <div key={field.name}>
                <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">
                  {field.name} {field.required && <span className="text-red-500">*</span>}
                </label>
                <Input
                  className="text-xs font-mono bg-background border-border text-foreground h-8"
                  placeholder={field.description ?? `Enter ${field.name}`}
                  value={(formValues[field.name] as string) ?? ""}
                  onChange={(e) => updateField(field.name, e.target.value)}
                />
              </div>
            );
          })}

          {/* Special inputs for verify domain */}
          {workflow.id === "verify" && (
            <VerifyDomainInputs formValues={formValues} updateField={updateField} />
          )}

          {/* Special inputs for legal counsel */}
          {workflow.id === "legal_counsel" && (
            <CounselInputs formValues={formValues} updateField={updateField} />
          )}

          {/* Special inputs for MCP benchmark */}
          {workflow.id === "mcp_benchmark" && (
            <McpInputs formValues={formValues} updateField={updateField} />
          )}
        </div>
      )}

      {/* Run button */}
      <div className="px-4 py-3 border-b border-border/50">
        <Button
          onClick={runWorkflow}
          disabled={run.loading || !token}
          className="w-full h-8 text-xs font-mono"
        >
          {run.loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5 mr-1.5" />
              Run {workflow.name}
            </>
          )}
        </Button>
        {run.latency !== null && !run.loading && (
          <p className="text-[9px] font-mono text-muted-foreground mt-1.5 text-center">
            Completed in {run.latency}ms
          </p>
        )}
      </div>

      {/* Error */}
      {run.error && (
        <div className="px-4 py-3 border-b border-border/50">
          <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
            <p className="text-[11px] font-mono text-red-600 leading-relaxed">{run.error}</p>
          </div>
        </div>
      )}

      {/* Result */}
      {run.result && (
        <div className="px-4 py-3 space-y-3">
          <WorkflowResult workflowId={workflow.id} data={run.result} />
          <CollapsibleSection title="Raw JSON Response">
            <JsonViewer data={run.result} />
          </CollapsibleSection>
        </div>
      )}

      {/* Next steps */}
      <div className="px-4 py-3">
        <NextStepsPanel steps={workflow.next_steps} />
      </div>
    </div>
  );
}

// ── Domain-specific input components ─────────────────────────────────────────

function VerifyDomainInputs({
  formValues,
  updateField,
}: {
  formValues: Record<string, unknown>;
  updateField: (name: string, value: unknown) => void;
}) {
  const domain = (formValues["domain"] as string) ?? "generic_llm";

  if (domain === "generic_llm") {
    return (
      <div className="space-y-2">
        <div>
          <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">prompt</label>
          <Input
            className="text-xs font-mono bg-background border-border h-8"
            placeholder="What is 2+2?"
            value={(formValues["prompt"] as string) ?? ""}
            onChange={(e) => updateField("prompt", e.target.value)}
          />
        </div>
        <div>
          <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">output (artifact to verify)</label>
          <Textarea
            className="text-xs font-mono bg-background border-border"
            rows={3}
            placeholder="TODO: implement this function"
            value={(formValues["output"] as string) ?? ""}
            onChange={(e) => updateField("output", e.target.value)}
          />
        </div>
      </div>
    );
  }

  if (domain === "sql_gen") {
    return (
      <div>
        <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">query (SQL to verify)</label>
        <Textarea
          className="text-xs font-mono bg-background border-border"
          rows={3}
          placeholder="DROP TABLE users;"
          value={(formValues["query"] as string) ?? ""}
          onChange={(e) => updateField("query", e.target.value)}
        />
      </div>
    );
  }

  return null;
}

function CounselInputs({
  formValues,
  updateField,
}: {
  formValues: Record<string, unknown>;
  updateField: (name: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">
          Contract text (min 100 chars)
        </label>
        <Textarea
          className="text-xs font-mono bg-background border-border"
          rows={10}
          placeholder="Paste contract text here..."
          value={(formValues["text"] as string) ?? ""}
          onChange={(e) => updateField("text", e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">perspective</label>
          <select
            className="w-full bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2"
            value={(formValues["perspective"] as string) ?? "company"}
            onChange={(e) => updateField("perspective", e.target.value)}
          >
            <option value="company">company</option>
            <option value="counterparty">counterparty</option>
            <option value="neutral">neutral</option>
          </select>
        </div>
        <div>
          <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">mode</label>
          <select
            className="w-full bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2"
            value={(formValues["mode"] as string) ?? "orchestrator"}
            onChange={(e) => updateField("mode", e.target.value)}
          >
            <option value="orchestrator">orchestrator (4-lens)</option>
            <option value="monolith">monolith (single LLM)</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function McpInputs({
  formValues,
  updateField,
}: {
  formValues: Record<string, unknown>;
  updateField: (name: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-2">
      <div>
        <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">MCP server URL</label>
        <Input
          className="text-xs font-mono bg-background border-border h-8"
          placeholder="https://mcp.deepwiki.com/mcp"
          value={(formValues["mcp_url"] as string) ?? ""}
          onChange={(e) => updateField("mcp_url", e.target.value)}
        />
      </div>
      <div>
        <label className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1 block">server slug (identifier)</label>
        <Input
          className="text-xs font-mono bg-background border-border h-8"
          placeholder="deepwiki"
          value={(formValues["mcp_slug"] as string) ?? ""}
          onChange={(e) => updateField("mcp_slug", e.target.value)}
        />
      </div>
    </div>
  );
}

// ── Workflow-specific result renderers ───────────────────────────────────────

function WorkflowResult({ workflowId, data }: { workflowId: string; data: unknown }) {
  const d = data as Record<string, unknown>;

  switch (workflowId) {
    case "verify":
      return <VerifyResult data={d} />;
    case "legal_draft":
      return <LegalDraftResult data={d} />;
    case "legal_counsel":
      return <CounselResult data={d} />;
    case "mcp_benchmark":
      return <McpResult data={d} />;
    case "reconcile":
      return <ReconcileResult data={d} />;
    case "benchmark":
      return <BenchmarkResult data={d} />;
    case "judge_baseline":
      return <JudgeResult data={d} />;
    case "audit":
      return <AuditResult data={d} />;
    case "audit_baseline":
      return <BaselineIntegrityResult data={d} />;
    case "audit_rubric":
      return <RubricResult data={d} />;
    case "quota":
      return <QuotaResult data={d} />;
    default:
      return null;
  }
}

function VerifyResult({ data }: { data: Record<string, unknown> }) {
  const verdict = data.verdict as string;
  const verified = data.verified as boolean;
  const guardians = (data.guardians ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <VerdictBadge verdict={verdict} />
        <span className="text-[10px] font-mono text-muted-foreground">
          verified={String(verified)}
        </span>
      </div>
      {guardians.length > 0 && (
        <CollapsibleSection title={`Guardians (${guardians.length})`} defaultOpen>
          <div className="space-y-1.5">
            {guardians.map((g, i) => {
              const gVerdict = g.verdict as string;
              const gName = g.guardian_id as string;
              const gReason = g.reason as string;
              return (
                <div key={i} className="flex items-start gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                  <VerdictBadge verdict={gVerdict} />
                  <span className="text-foreground/80 font-semibold">{gName}</span>
                  {gReason && <span className="text-muted-foreground">— {gReason}</span>}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function LegalDraftResult({ data }: { data: Record<string, unknown> }) {
  const artifactStatus = data.artifact_status as string;
  const draft = data.draft as { sections: unknown[]; full_text: string };
  const verifier = data.verifier as { passed: boolean; template_failures: unknown[]; legal_conflicts: unknown[]; missing_data: unknown[] };
  const receipt = data.receipt as { passed: boolean; governance_status: string };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <VerdictBadge verdict={artifactStatus === "ready_for_review" ? "PASS" : "FAIL"} />
        <span className="text-[10px] font-mono text-muted-foreground">
          {draft?.sections?.length ?? 0} sections
        </span>
        {receipt && (
          <span className="text-[10px] font-mono text-muted-foreground">
            governance: {receipt.governance_status}
          </span>
        )}
      </div>
      {verifier && (
        <CollapsibleSection title="Verifier Details" defaultOpen>
          <div className="space-y-1.5 text-[10px] font-mono">
            <div className="flex gap-2">
              <span className="text-muted-foreground">template_failures:</span>
              <span className={verifier.template_failures?.length ? "text-red-500" : "text-green-500"}>
                {verifier.template_failures?.length ?? 0}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">legal_conflicts:</span>
              <span className={verifier.legal_conflicts?.length ? "text-red-500" : "text-green-500"}>
                {verifier.legal_conflicts?.length ?? 0}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">missing_data:</span>
              <span className={verifier.missing_data?.length ? "text-amber-500" : "text-green-500"}>
                {verifier.missing_data?.length ?? 0}
              </span>
            </div>
          </div>
        </CollapsibleSection>
      )}
      {draft?.full_text && (
        <CollapsibleSection title="Draft Full Text">
          <pre className="text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
            {draft.full_text}
          </pre>
        </CollapsibleSection>
      )}
    </div>
  );
}

function CounselResult({ data }: { data: Record<string, unknown> }) {
  const output = (data.output ?? {}) as Record<string, unknown>;
  const meta = (data.meta ?? {}) as Record<string, unknown>;
  const overallRisk = output.overall_risk as string;
  const groundedRatio = meta.grounded_ratio as number;
  const lensModels = (meta.lens_models ?? []) as string[];
  const retrievalMode = meta.retrieval_mode as string;
  const ragSources = (data.rag_sources ?? []) as string[];
  const findingsGrounded = (output.findings_grounded ?? []) as Array<Record<string, unknown>>;
  const findingsInferred = (output.findings_inferred ?? []) as Array<Record<string, unknown>>;
  const blockingIssues = (output.blocking_issues ?? []) as string[];
  const nextSteps = (output.next_steps ?? []) as string[];
  const opportunities = (output.opportunities_for_company ?? []) as Array<Record<string, unknown>>;

  const riskColor = (r: string) =>
    r === "critical" ? "bg-red-500/15 text-red-600 border-red-500/30" :
    r === "high" ? "bg-orange-500/15 text-orange-600 border-orange-500/30" :
    r === "medium" ? "bg-amber-500/15 text-amber-600 border-amber-500/30" :
    "bg-green-500/15 text-green-600 border-green-500/30";

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold border uppercase ${riskColor(overallRisk)}`}>
          Risk: {overallRisk}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          grounded_ratio: <span className={groundedRatio >= 0.5 ? "text-green-500" : "text-amber-500"}>{(groundedRatio * 100).toFixed(0)}%</span>
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          retrieval: {retrievalMode}
        </span>
      </div>

      {/* Lens models */}
      {lensModels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Lenses:</span>
          {lensModels.map((m) => (
            <span key={m} className="text-[9px] font-mono bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded">
              {m}
            </span>
          ))}
        </div>
      )}

      {/* RAG sources */}
      {ragSources.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Corpus:</span>
          {ragSources.map((s) => (
            <span key={s} className="text-[9px] font-mono bg-secondary text-foreground/70 border border-border px-1.5 py-0.5 rounded">
              {s}
            </span>
          ))}
        </div>
      )}

      {/* Blocking issues */}
      {blockingIssues.length > 0 && (
        <div className="rounded border border-red-500/30 bg-red-500/5 p-2.5 space-y-1">
          <p className="text-[9px] font-mono text-red-500 uppercase tracking-widest">Blocking Issues</p>
          {blockingIssues.map((b, i) => (
            <p key={i} className="text-[10px] font-mono text-red-600">{b}</p>
          ))}
        </div>
      )}

      {/* Grounded findings */}
      {findingsGrounded.length > 0 && (
        <CollapsibleSection title={`Grounded Findings (${findingsGrounded.length})`} defaultOpen>
          <div className="space-y-2">
            {findingsGrounded.map((f, i) => (
              <div key={i} className="rounded border border-border/50 p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[8px] font-mono border px-1 py-0.5 rounded ${riskColor(f.severity as string)}`}>
                    {f.severity as string}
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground">{f.lens as string}</span>
                  {f.slug && <span className="text-[9px] font-mono text-primary">[{f.slug as string}]</span>}
                </div>
                <p className="text-[10px] font-mono text-foreground/80">{f.issue as string}</p>
                <p className="text-[10px] font-mono text-muted-foreground italic">{f.recommendation as string}</p>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Inferred findings */}
      {findingsInferred.length > 0 && (
        <CollapsibleSection title={`Inferred Findings (${findingsInferred.length})`}>
          <div className="space-y-2">
            {findingsInferred.map((f, i) => (
              <div key={i} className="rounded border border-border/50 p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[8px] font-mono border px-1 py-0.5 rounded ${riskColor(f.severity as string)}`}>
                    {f.severity as string}
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground">{f.lens as string}</span>
                </div>
                <p className="text-[10px] font-mono text-foreground/80">{f.issue as string}</p>
                {f.reason && <p className="text-[10px] font-mono text-muted-foreground italic">{f.reason as string}</p>}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Opportunities */}
      {opportunities.length > 0 && (
        <CollapsibleSection title={`Company Opportunities (${opportunities.length})`}>
          <div className="space-y-2">
            {opportunities.map((o, i) => (
              <div key={i} className="rounded border border-green-500/20 bg-green-500/5 p-2 space-y-1">
                <p className="text-[10px] font-mono font-semibold text-green-600">{o.title as string}</p>
                <p className="text-[10px] font-mono text-foreground/70">{o.description as string}</p>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Next steps from output */}
      {nextSteps.length > 0 && (
        <div className="rounded border border-blue-500/20 bg-blue-500/5 p-2.5">
          <p className="text-[9px] font-mono text-blue-400 uppercase tracking-widest mb-1.5">Recommended Actions</p>
          <ul className="space-y-1">
            {nextSteps.map((s, i) => (
              <li key={i} className="text-[10px] font-mono text-foreground/80 flex items-start gap-1.5">
                <ArrowRight className="w-2.5 h-2.5 text-blue-400 mt-0.5 shrink-0" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function McpResult({ data }: { data: Record<string, unknown> }) {
  const safetyPct = data.safety_pct as number;
  const nTools = data.n_tools_reachable as number;
  const gatePass = data.gate_pass as boolean;
  const dry = data.dry as boolean;
  const probes = (data.probes ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <VerdictBadge verdict={gatePass ? "PASS" : "FAIL"} />
        <span className="text-[10px] font-mono text-muted-foreground">
          safety: <span className={safetyPct === 100 ? "text-green-500" : "text-red-500"}>{safetyPct}%</span>
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          tools reachable: {nTools}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          mode: {dry ? "dry" : "live"}
        </span>
      </div>
      {probes.length > 0 && (
        <CollapsibleSection title={`Safety Probes (${probes.length})`} defaultOpen>
          <div className="space-y-1.5">
            {probes.map((p, i) => {
              const refused = p.refused as boolean;
              const label = p.label as string;
              const payload = p.payload as string;
              return (
                <div key={i} className="flex items-start gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                  {refused ? (
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                  )}
                  <div>
                    <span className="text-foreground/80 font-semibold">{label}</span>
                    <p className="text-[9px] text-muted-foreground italic mt-0.5">payload: {payload?.slice(0, 80)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function ReconcileResult({ data }: { data: Record<string, unknown> }) {
  const agreementRate = data.agreement_rate as number;
  const items = (data.items ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <VerdictBadge verdict={agreementRate === 1 ? "PASS" : "FAIL"} />
        <span className="text-[10px] font-mono text-muted-foreground">
          agreement_rate: {(agreementRate * 100).toFixed(0)}%
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {items.length} items
        </span>
      </div>
      {items.length > 0 && (
        <CollapsibleSection title="Per-Item Results" defaultOpen>
          <div className="space-y-1">
            {items.map((item, i) => {
              const decision = item.decision as string;
              const intake = item.intake as string;
              return (
                <div key={i} className="flex items-center gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                  {decision === "identical" ? (
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                  )}
                  <span className="text-foreground/80">{intake}</span>
                  <span className="text-muted-foreground ml-auto">{decision}</span>
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function BenchmarkResult({ data }: { data: Record<string, unknown> }) {
  const overall = (data.overall ?? {}) as Record<string, unknown>;
  const recall = overall.recall as number;
  const frr = overall.false_reject_rate as number;
  const perDomain = (data.per_domain ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-mono text-muted-foreground">
          recall: <span className="text-green-500">{((recall ?? 0) * 100).toFixed(0)}%</span>
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          false_reject_rate: <span className="text-amber-500">{((frr ?? 0) * 100).toFixed(0)}%</span>
        </span>
      </div>
      {perDomain.length > 0 && (
        <CollapsibleSection title={`Per-Domain (${perDomain.length})`} defaultOpen>
          <div className="space-y-1">
            {perDomain.map((dom, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                <span className="text-foreground/80 font-semibold">{dom.domain as string}</span>
                <span className="text-muted-foreground">recall: {(((dom.recall as number) ?? 0) * 100).toFixed(0)}%</span>
                <span className="text-muted-foreground">frr: {(((dom.false_reject_rate as number) ?? 0) * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function JudgeResult({ data }: { data: Record<string, unknown> }) {
  const recall = data.recall as number;
  const frr = data.false_reject_rate as number;
  const mode = data.mode as string;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant="outline" className="text-[9px] font-mono">{mode ?? "grounded"}</Badge>
        <span className="text-[10px] font-mono text-muted-foreground">
          recall: <span className="text-green-500">{((recall ?? 0) * 100).toFixed(0)}%</span>
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          false_reject_rate: <span className="text-amber-500">{((frr ?? 0) * 100).toFixed(0)}%</span>
        </span>
      </div>
    </div>
  );
}

function AuditResult({ data }: { data: Record<string, unknown> }) {
  const ablation = (data.ablation ?? []) as Array<Record<string, unknown>>;
  const redundancy = (data.redundancy ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      {ablation.length > 0 && (
        <CollapsibleSection title={`Ablation (${ablation.length})`} defaultOpen>
          <div className="space-y-1">
            {ablation.map((a, i) => (
              <div key={i} className="text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                <span className="text-foreground/80 font-semibold">{a.guardian as string}</span>
                <span className="text-muted-foreground ml-2">recall_drop: {String(a.recall_drop)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {redundancy.length > 0 && (
        <CollapsibleSection title={`Redundancy (${redundancy.length})`}>
          <div className="space-y-1">
            {redundancy.map((r, i) => (
              <div key={i} className="text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                <span className="text-foreground/80">{r.pair as string}</span>
                <span className="text-muted-foreground ml-2">overlap: {String(r.overlap)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function BaselineIntegrityResult({ data }: { data: Record<string, unknown> }) {
  const findings = (data.findings ?? []) as Array<Record<string, unknown>>;
  const docs = (data.docs ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-mono text-muted-foreground">{findings.length} findings</span>
        <span className="text-[10px] font-mono text-muted-foreground">{docs.length} docs</span>
      </div>
      {findings.length > 0 && (
        <CollapsibleSection title="Findings" defaultOpen>
          <div className="space-y-1">
            {findings.map((f, i) => (
              <div key={i} className="text-[10px] font-mono py-1 px-2 rounded border border-border/50">
                <span className="text-foreground/80">{f.message as string ?? JSON.stringify(f)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function RubricResult({ data }: { data: Record<string, unknown> }) {
  const coverage = data.coverage as number;
  const bestCut = data.best_cut as number | undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-mono text-muted-foreground">
          coverage: <span className={coverage >= 0.8 ? "text-green-500" : "text-amber-500"}>{((coverage ?? 0) * 100).toFixed(0)}%</span>
        </span>
        {bestCut !== undefined && (
          <span className="text-[10px] font-mono text-muted-foreground">
            best_cut: {bestCut}
          </span>
        )}
      </div>
    </div>
  );
}

function QuotaResult({ data }: { data: Record<string, unknown> }) {
  const results = (data.results ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-mono text-muted-foreground">{results.length} entries probed</span>
      </div>
      <div className="space-y-1">
        {results.map((r, i) => {
          const reachable = r.reachable as boolean;
          const modelId = r.model_id as string;
          const provider = r.provider as string;
          const reason = r.reason as string;
          return (
            <div key={i} className="flex items-center gap-2 text-[10px] font-mono py-1 px-2 rounded border border-border/50">
              {reachable ? (
                <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
              ) : (
                <XCircle className="w-3 h-3 text-red-500 shrink-0" />
              )}
              <span className="text-foreground/80 font-semibold">{modelId}</span>
              <span className="text-muted-foreground">({provider})</span>
              {reason && <span className="text-muted-foreground ml-auto">{reason}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function RigorGatePage() {
  const [token, setToken] = useState(getStoredToken());
  const [tokenInput, setTokenInput] = useState(getStoredToken());
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);

  const saveToken = useCallback(() => {
    setToken(tokenInput.trim());
    setStoredToken(tokenInput.trim());
  }, [tokenInput]);

  const fetchWorkflows = useCallback(async () => {
    if (!token) return;
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    try {
      const resp = await rigorFetch("/workflows", token);
      if (!resp.ok) {
        const err = await resp.json();
        setWorkflowsError(err.error ?? `HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      setWorkflows(data.workflows ?? []);
    } catch (err: unknown) {
      setWorkflowsError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkflowsLoading(false);
    }
  }, [token]);

  const fetchRuns = useCallback(async () => {
    if (!token) return;
    try {
      const resp = await rigorFetch("/runs", token);
      if (resp.ok) {
        const data = await resp.json();
        setRuns(data.runs ?? []);
      }
    } catch {
      // silent
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchWorkflows();
      fetchRuns();
    }
  }, [token, fetchWorkflows, fetchRuns]);

  const tokenReady = token.length > 0;

  return (
    <Layout>
      <PageHeader
        title="Rigor Gate"
        subtitle="Verification moat — 11 workflows for fail-closed artifact verification"
        action={
          <Badge variant="outline" className="text-[9px] font-mono">
            <ShieldCheck className="w-3 h-3 mr-1" />
            {workflows.length} workflows
          </Badge>
        }
      />

      {/* Disclaimer */}
      <div className="flex items-start gap-2 px-6 py-2.5 bg-amber-500/5 border-b border-amber-500/20 text-[11px] font-mono text-amber-400/90">
        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          <strong>Verification moat.</strong> All workflows make live API calls — nothing is cached or stubbed.
          The verification gate is fail-closed: a guardian that cannot run returns "degraded", which cannot produce a PASS.
        </span>
      </div>

      <div className="p-6 space-y-6 max-w-5xl">
        {/* Token gate */}
        {!tokenReady ? (
          <div className="rounded border border-border bg-card p-6 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-mono font-bold text-foreground">Admin Token Required</h2>
            </div>
            <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">
              The Rigor Gate requires an admin token to access the verification API.
              Enter the token configured as <code className="bg-muted px-1 rounded">OPENCLAW_ADMIN_TOKEN</code> on the server.
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                className="text-xs font-mono bg-background border-border h-9 flex-1"
                placeholder="Enter admin token..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveToken()}
              />
              <Button onClick={saveToken} className="h-9 text-xs font-mono">
                <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
                Connect
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Token status + workflows loaded */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="text-[11px] font-mono text-muted-foreground">Connected</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] font-mono ml-2"
                  onClick={() => { setToken(""); setStoredToken(""); setTokenInput(""); setWorkflows([]); }}
                >
                  Disconnect
                </Button>
              </div>
              {workflowsLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>

            {workflowsError && (
              <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-3">
                <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-[11px] font-mono text-red-600">{workflowsError}</p>
                  <Button variant="ghost" size="sm" onClick={fetchWorkflows} className="h-6 text-[10px] font-mono mt-1">
                    Retry
                  </Button>
                </div>
              </div>
            )}

            {/* Run history */}
            <CollapsibleSection title="Run History" badge={<Badge variant="outline" className="text-[8px] font-mono ml-1">{runs.length}</Badge>}>
              <RunHistory runs={runs} onRefresh={fetchRuns} />
            </CollapsibleSection>

            {/* Workflow catalog */}
            <div className="space-y-2">
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Workflow Catalog</p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {workflows.map((wf) => {
                  const Icon = workflowIcon(wf.id);
                  const active = selectedWorkflow === wf.id;
                  return (
                    <button
                      key={wf.id}
                      onClick={() => setSelectedWorkflow(active ? null : wf.id)}
                      className={`flex flex-col items-start gap-1.5 p-3 rounded border text-left transition-colors ${
                        active
                          ? "border-primary bg-primary/10"
                          : "border-border bg-card/30 hover:bg-secondary/30"
                      }`}
                    >
                      <Icon className={`w-4 h-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-[10px] font-mono font-semibold text-foreground">{wf.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Selected workflow runner */}
            {selectedWorkflow && (
              <div className="space-y-2">
                <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Run Workflow</p>
                {workflows
                  .filter((wf) => wf.id === selectedWorkflow)
                  .map((wf) => (
                    <WorkflowRunner
                      key={wf.id}
                      workflow={wf}
                      token={token}
                      onRunComplete={fetchRuns}
                    />
                  ))}
              </div>
            )}

            {/* All workflows (expandable) */}
            {!selectedWorkflow && (
              <div className="space-y-3">
                <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">All Workflows</p>
                {workflows.map((wf) => (
                  <WorkflowRunner
                    key={wf.id}
                    workflow={wf}
                    token={token}
                    onRunComplete={fetchRuns}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
