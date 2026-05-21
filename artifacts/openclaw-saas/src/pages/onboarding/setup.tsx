import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import {
  CheckCircle2,
  Circle,
  Loader2,
  ChevronRight,
  Shield,
  Database,
  Cpu,
  Server,
  Zap,
  Copy,
  Check,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type StepStatus = "pending" | "active" | "done";

interface GovernanceEnvelope {
  human_review_required: boolean;
  privilege_warning: string;
  not_legal_advice: boolean;
  escalation_flag: boolean;
  jurisdiction_scope: string[];
}

interface TraceBlock {
  retrieval_used: boolean;
  retrieval_chunks: number;
  fallback_used: boolean;
  model_used: string;
  latency_ms: number;
  usage_event_id: string;
}

interface LineageBlock {
  asset_version: string;
  dataset_version: string;
  eval_run: string;
  model_eval_accuracy: number;
}

interface EndpointResult {
  clause_type: string;
  confidence: number;
  reasoning: string;
  governance: GovernanceEnvelope;
  trace: TraceBlock;
  lineage: LineageBlock;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EXAMPLE_CLAUSE =
  "This Agreement shall be governed by the laws of the State of Delaware, without regard to its conflict of law provisions. Any disputes arising under this Agreement shall be subject to the exclusive jurisdiction of the courts located in Wilmington, Delaware.";

const STEPS = [
  { id: "workspace", label: "Workspace Ready" },
  { id: "data",      label: "Your Data" },
  { id: "training",  label: "Training Job" },
  { id: "deploy",    label: "Workforce Live" },
  { id: "try",       label: "Try It" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StepIndicator({ steps, current }: { steps: typeof STEPS; current: number }) {
  return (
    <div className="flex items-center gap-0 w-full max-w-2xl mx-auto mb-10">
      {steps.map((s, i) => {
        const status: StepStatus = i < current ? "done" : i === current ? "active" : "pending";
        return (
          <div key={s.id} className="flex items-center flex-1 min-w-0">
            <div className="flex flex-col items-center shrink-0">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center border transition-all ${
                  status === "done"
                    ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                    : status === "active"
                    ? "bg-primary/20 border-primary text-primary"
                    : "bg-zinc-500/10 border-zinc-500/20 text-zinc-500"
                }`}
              >
                {status === "done" ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <span className="text-[10px] font-mono font-bold">{i + 1}</span>
                )}
              </div>
              <span
                className={`text-[9px] font-mono mt-1 whitespace-nowrap ${
                  status === "active" ? "text-primary" : status === "done" ? "text-emerald-400" : "text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-px mx-1 transition-all ${
                  i < current ? "bg-emerald-500/40" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card border border-border rounded-lg p-6 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function NextButton({
  onClick,
  disabled,
  loading,
  label = "Next",
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded disabled:opacity-50 transition-colors"
    >
      {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      {label}
      {!loading && <ChevronRight className="w-3 h-3" />}
    </button>
  );
}

// ─── Step panels ──────────────────────────────────────────────────────────────

function StepWorkspace({ workspaceId, onNext }: { workspaceId: number | null; onNext: () => void }) {
  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-emerald-500/10 rounded">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <div className="text-sm font-mono font-bold text-foreground">Workspace provisioned</div>
          <div className="text-[10px] font-mono text-muted-foreground">Legal AI Operating Layer</div>
        </div>
        <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
          ACTIVE
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Domain", value: "legal" },
          { label: "Workspace ID", value: workspaceId ? `#${workspaceId}` : "—" },
          { label: "Status", value: "active" },
        ].map((item) => (
          <div key={item.label} className="bg-background border border-border rounded p-3">
            <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{item.label}</div>
            <div className="text-xs font-mono text-foreground">{item.value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs font-mono text-muted-foreground mb-6">
        Your Legal AI workspace is ready. The factory has provisioned your training pipeline,
        skill bundle, and governance layer.
      </p>
      <NextButton onClick={onNext} label="Set up your data" />
    </Card>
  );
}

function StepData({ onNext }: { onNext: () => void }) {
  const [mode, setMode] = useState<"sample" | "upload">("sample");

  return (
    <Card>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded">
          <Database className="w-5 h-5 text-primary" />
        </div>
        <div>
          <div className="text-sm font-mono font-bold text-foreground">Your data</div>
          <div className="text-[10px] font-mono text-muted-foreground">Choose how to ground your AI workforce</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        {/* Sample data */}
        <button
          onClick={() => setMode("sample")}
          className={`text-left p-4 rounded-lg border transition-all ${
            mode === "sample"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border/80"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono font-bold text-foreground">Use sample data</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
              INCLUDED
            </span>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
            CUAD Legal Clause Dataset — 50 labeled examples across 5 clause types.
            Pre-loaded. Ready immediately.
          </p>
          {mode === "sample" && (
            <div className="mt-3 flex items-center gap-1.5 text-[10px] font-mono text-emerald-400">
              <CheckCircle2 className="w-3 h-3" />
              50 documents · status: ready
            </div>
          )}
        </button>

        {/* Upload */}
        <button
          onClick={() => setMode("upload")}
          className={`text-left p-4 rounded-lg border transition-all ${
            mode === "upload"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-border/80"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono font-bold text-foreground">Upload your own</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-zinc-500/10 text-zinc-400 border-zinc-500/20">
              ADVANCED
            </span>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
            Your documents will be chunked, indexed, and used to ground your AI workforce.
            PDF, TXT, CSV supported.
          </p>
          {mode === "upload" && (
            <div className="mt-3 border-2 border-dashed border-border rounded p-4 text-center">
              <p className="text-[10px] font-mono text-muted-foreground">
                Drag files here or click to browse
              </p>
              <p className="text-[9px] font-mono text-muted-foreground mt-1">PDF · TXT · CSV · max 20MB</p>
            </div>
          )}
        </button>
      </div>

      <NextButton
        onClick={onNext}
        label={mode === "sample" ? "Use sample data" : "Continue with upload"}
      />
    </Card>
  );
}

function StepTraining({ workspaceId, onNext }: { workspaceId: number | null; onNext: () => void }) {
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // We call the registry list to find the registration + version to approve.
  // For the seeded workspace, there is exactly one registration with one version.
  function handleApprove() {
    if (!workspaceId || approving || approved) return;
    setApproving(true);
    setError(null);

    // Fetch registry to get registration + version IDs
    fetch(`/api/forge/workspaces/${workspaceId}/registry`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Registry fetch failed: ${r.status}`);
        const raw = await r.text();
        if (!raw || !raw.trim()) throw new Error("Registry unavailable — please try again.");
        try { return JSON.parse(raw) as Array<{ registration: { id: number }; versions: Array<{ id: number; status: string }> }>; } catch { throw new Error("Invalid registry response."); }
      })
      .then((registry) => {
        const reg = registry[0];
        if (!reg) throw new Error("No model registration found");
        const version = reg.versions.find((v) => v.status === "candidate") ?? reg.versions[0];
        if (!version) throw new Error("No model version found");

        // If already approved, skip the approve call
        if (version.status === "approved") {
          setApproved(true);
          setApproving(false);
          return;
        }

        return fetch(
          `/api/forge/workspaces/${workspaceId}/registry/${reg.registration.id}/versions/${version.id}/approve`,
          { method: "POST", credentials: "include" }
        ).then((r) => {
          if (!r.ok) throw new Error(`Approve failed: ${r.status}`);
          setApproved(true);
          setApproving(false);
        });
      })
      .catch((err) => {
        setError(err.message ?? "Approval failed");
        setApproving(false);
      });
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded">
          <Cpu className="w-5 h-5 text-primary" />
        </div>
        <div>
          <div className="text-sm font-mono font-bold text-foreground">Training job</div>
          <div className="text-[10px] font-mono text-muted-foreground">Review and approve your model before deployment</div>
        </div>
      </div>

      {/* Job card */}
      <div className="bg-background border border-border rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono font-bold text-foreground">Legal Clause Extractor v1</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
            COMPLETED
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[
            { label: "Mode", value: "RAG Adaptation" },
            { label: "Base model", value: "lfm-2.5-1.2b" },
            { label: "Dataset", value: "CUAD v2 · 50 examples" },
            { label: "Eval accuracy", value: "1.0 (n=10)" },
          ].map((item) => (
            <div key={item.label}>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">{item.label}</div>
              <div className="text-[10px] font-mono text-foreground mt-0.5">{item.value}</div>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded p-2">
          <AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[10px] font-mono text-amber-400">
            Internal eval only (n=10). Not production-ready. Human review required before use in any legal workflow.
          </p>
        </div>
      </div>

      {/* Governance note */}
      <div className="flex items-start gap-2 mb-6">
        <Shield className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-[10px] font-mono text-muted-foreground">
          This model requires your approval before deployment. Only the workspace owner can approve.
          Approval is logged in the audit trail.
        </p>
      </div>

      {error && (
        <div className="mb-4 text-[10px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {approved ? (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
            Model approved
          </div>
          <NextButton onClick={onNext} label="Deploy workforce" />
        </div>
      ) : (
        <button
          onClick={handleApprove}
          disabled={approving}
          className="flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded disabled:opacity-50 transition-colors"
        >
          {approving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
          {approving ? "Approving..." : "Approve model"}
        </button>
      )}
    </Card>
  );
}

function StepDeploy({ onNext }: { onNext: () => void }) {
  return (
    <Card>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-emerald-500/10 rounded">
          <Server className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <div className="text-sm font-mono font-bold text-foreground">Your AI workforce is live</div>
          <div className="text-[10px] font-mono text-muted-foreground">Governed endpoints ready to call</div>
        </div>
      </div>

      {/* Deployment card */}
      <div className="bg-background border border-emerald-500/20 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono font-bold text-foreground">Legal Clause Extractor</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
            ACTIVE
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {[
            { label: "Endpoint", value: "POST /api/v1/legal/extract-clause" },
            { label: "Model", value: "Legal Clause Extractor v1" },
            { label: "Governance", value: "human_review_required: true" },
            { label: "Audit trail", value: "Enabled — every call logged" },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-3">
              <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest w-24 shrink-0">{item.label}</span>
              <span className="text-[10px] font-mono text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <Zap className="w-3.5 h-3.5 text-primary" />
        <p className="text-xs font-mono text-muted-foreground">
          The factory has built your AI workforce. Now let's invoke it.
        </p>
      </div>

      <NextButton onClick={onNext} label="Try it now" />
    </Card>
  );
}

function StepTry({ workspaceId, onFinish }: { workspaceId: number | null; onFinish: () => void }) {
  const [input, setInput] = useState(EXAMPLE_CLAUSE);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EndpointResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState(false);

  function handleRun() {
    if (!input.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);

    fetch("/api/v1/legal/extract-clause", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.trim(), use_rag: true }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Endpoint returned ${r.status}`);
        const raw = await r.text();
        if (!raw || !raw.trim()) throw new Error("Service is warming up — please try again in a few seconds.");
        try { return JSON.parse(raw) as EndpointResult; } catch { throw new Error("Service returned an invalid response. Please retry."); }
      })
      .then((data) => {
        setResult(data);
        setRunning(false);
        setSuccess(true);
      })
      .catch((err) => {
        setError(err.message ?? "Request failed");
        setRunning(false);
      });
  }

  function handleCopy() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded">
          <Zap className="w-5 h-5 text-primary" />
        </div>
        <div>
          <div className="text-sm font-mono font-bold text-foreground">Try it</div>
          <div className="text-[10px] font-mono text-muted-foreground">Invoke your live governed endpoint</div>
        </div>
      </div>

      <div className={`grid gap-6 ${result ? "grid-cols-2" : "grid-cols-1"}`}>
        {/* Input */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">
            Contract clause
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={6}
            className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none placeholder:text-muted-foreground"
            placeholder="Paste a contract clause..."
          />
          <button
            onClick={handleRun}
            disabled={!input.trim() || running}
            className="mt-3 flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded disabled:opacity-50 transition-colors"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
            {running ? "Running..." : "Run"}
          </button>
          {error && (
            <div className="mt-3 text-[10px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Output */}
        {result && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Output</div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied" : "Copy JSON"}
              </button>
            </div>

            {/* Result */}
            <div className="bg-background border border-border rounded p-3 mb-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest w-20">clause_type</span>
                <span className="text-xs font-mono text-primary font-bold">{result.clause_type}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest w-20">confidence</span>
                <span className="text-xs font-mono text-foreground">{result.confidence}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest w-20 mt-0.5">reasoning</span>
                <span className="text-[10px] font-mono text-foreground leading-relaxed">{result.reasoning}</span>
              </div>
            </div>

            {/* Governance envelope — open by default */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded p-3 mb-3">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-3 h-3 text-amber-400" />
                <span className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-widest">Governance</span>
                <span className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">
                  ALWAYS PRESENT
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-32">human_review_required</span>
                  <span className="text-[10px] font-mono text-amber-400 font-bold">true</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-32 mt-0.5">privilege_warning</span>
                  <span className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                    {result.governance.privilege_warning}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-32">escalation_flag</span>
                  <span className={`text-[10px] font-mono ${result.governance.escalation_flag ? "text-red-400" : "text-zinc-400"}`}>
                    {String(result.governance.escalation_flag)}
                  </span>
                </div>
              </div>
            </div>

            {/* Trace + lineage */}
            <div className="bg-background border border-border rounded p-3 space-y-1">
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Trace · Lineage</div>
              {[
                { label: "model_used", value: result.trace.model_used },
                { label: "latency_ms", value: String(result.trace.latency_ms) },
                { label: "retrieval_used", value: String(result.trace.retrieval_used) },
                { label: "dataset_version", value: result.lineage.dataset_version },
                { label: "eval_run", value: result.lineage.eval_run },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-28">{item.label}</span>
                  <span className="text-[10px] font-mono text-foreground">{item.value}</span>
                </div>
              ))}
            </div>

            <p className="mt-3 text-[10px] font-mono text-muted-foreground">
              This output requires human review before use in any legal workflow.
            </p>
          </div>
        )}
      </div>

      {/* Success banner */}
      {success && (
        <div className="mt-6 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-mono font-bold text-emerald-400">
              Your AI workforce just processed its first matter.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onFinish}
              className="flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded transition-colors"
            >
              Go to your workspace
              <ArrowRight className="w-3 h-3" />
            </button>
            <button
              onClick={() => window.location.assign("/dashboard")}
              className="font-mono text-xs px-4 py-2 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Explore the platform
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SetupPage() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const workspaceId = useRef<number | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("oc_onboarding_wid");
    if (stored) workspaceId.current = parseInt(stored, 10);
  }, []);

  function advance() {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function handleFinish() {
    const wid = workspaceId.current;
    sessionStorage.removeItem("oc_onboarding_wid");
    if (wid) {
      navigate(`/forge/${wid}/overview`);
    } else {
      navigate("/forge");
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <span className="text-sm font-mono font-bold text-foreground tracking-tight">OPENCLAW</span>
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
          Setting up your AI workforce
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center justify-start px-6 py-10">
        <div className="w-full max-w-2xl">
          <StepIndicator steps={STEPS} current={step} />

          {step === 0 && (
            <StepWorkspace workspaceId={workspaceId.current} onNext={advance} />
          )}
          {step === 1 && (
            <StepData onNext={advance} />
          )}
          {step === 2 && (
            <StepTraining workspaceId={workspaceId.current} onNext={advance} />
          )}
          {step === 3 && (
            <StepDeploy onNext={advance} />
          )}
          {step === 4 && (
            <StepTry workspaceId={workspaceId.current} onFinish={handleFinish} />
          )}
        </div>
      </div>
    </div>
  );
}
