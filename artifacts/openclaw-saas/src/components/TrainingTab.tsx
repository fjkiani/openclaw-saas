import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Database,
  Cpu,
  FlaskConical,
  Shield,
  TrendingUp,
  Wrench,
} from "lucide-react";

// ─── Data ─────────────────────────────────────────────────────────────────────

const DATASET = {
  name: "CUAD Legal Clause Dataset v2",
  source: "CUAD v1 (CC BY 4.0) — Atticus Project, 510 commercial contracts",
  total: 50,
  splits: { train: 30, val: 10, test: 10 },
  clauseTypes: [
    "governing_law",
    "termination",
    "ip_assignment",
    "limitation_of_liability",
    "indemnification",
  ],
  retriever: "FAISS IndexFlatIP",
  embeddingModel: "all-MiniLM-L6-v2",
  embeddingDim: 384,
  retrievalThreshold: 0.35,
  topK: 3,
};

const EVAL_STAGES = [
  {
    id: "zero-shot",
    label: "Zero-Shot Baseline",
    model: "liquid/lfm-2.5-1.2b-instruct",
    method: "No retrieval. Raw prompt only.",
    accuracy: 0.925,
    macroF1: 0.800,
    n: 10,
    color: "text-zinc-400",
    border: "border-zinc-500/20",
    bg: "bg-zinc-500/5",
    bar: "bg-zinc-400",
  },
  {
    id: "rag",
    label: "RAG Adaptation",
    model: "liquid/lfm-2.5-1.2b-instruct + FAISS",
    method: "FAISS IndexFlatIP retrieval. Top-3 examples injected into context.",
    accuracy: 1.0,
    macroF1: 1.0,
    n: 10,
    color: "text-emerald-400",
    border: "border-emerald-500/20",
    bg: "bg-emerald-500/5",
    bar: "bg-emerald-400",
  },
  {
    id: "playbook-v1",
    label: "Playbook v1 — Infrastructure",
    model: "Full 7-agent workforce",
    method: "10 adversarial scenarios. Presence checks only — does the response have the right fields?",
    accuracy: 0.9,
    macroF1: null,
    n: 10,
    scenariosPassed: 9,
    presencePassRate: 1.0,
    color: "text-blue-400",
    border: "border-blue-500/20",
    bg: "bg-blue-500/5",
    bar: "bg-blue-400",
  },
  {
    id: "playbook-v2",
    label: "Playbook v2 — Correctness",
    model: "Full 7-agent workforce",
    method: "Same 10 scenarios. Semantic correctness checks — are the values actually right?",
    accuracy: 0.6,
    macroF1: null,
    n: 10,
    scenariosPassed: 6,
    presencePassRate: 1.0,
    correctnessPassRate: 0.75,
    color: "text-amber-400",
    border: "border-amber-500/20",
    bg: "bg-amber-500/5",
    bar: "bg-amber-400",
  },
];

const PLAYBOOK_SCENARIOS = [
  { id: "S1", name: "Happy Path: Clean Governing Law Clause", v1: true, v2: true, endpoint: "/v1/legal/extract-clause" },
  { id: "S2", name: "Ambiguous Multi-Clause: Termination + Limitation of Liability", v1: true, v2: true, endpoint: "/v1/legal/extract-clause" },
  { id: "S3", name: "Cross-Jurisdiction Conflict: EU GDPR + US Arbitration", v1: true, v2: true, endpoint: "/v1/legal/extract-clause", note: "Partial credit — conflict signal present but weak" },
  { id: "S4", name: "Low-Confidence Escalation: Deliberately Vague Text", v1: true, v2: false, endpoint: "/v1/legal/intake", gap: "Intake returns confidence=0.95 on vague text. Needs uncertainty instruction in system prompt." },
  { id: "S5", name: "IP Assignment Edge Case: Moral Rights + Work-for-Hire + Assignment-Back", v1: true, v2: true, endpoint: "/v1/legal/ip/analyze" },
  { id: "S6", name: "Employment Compliance Red Flag: California Non-Compete + Mandatory Arbitration", v1: true, v2: false, endpoint: "/v1/legal/employment/analyze", gap: "escalation_flag=false despite California non-compete. Needs post-processing for known-unenforceable patterns." },
  { id: "S7", name: "Governance Envelope: Policy Compliance Check", v1: false, v2: false, endpoint: "/v1/legal/intake", gap: "400 error not wrapped in governance envelope. Needs error handler middleware." },
  { id: "S8", name: "Full Pipeline: Intake → Corporate → Audit", v1: true, v2: true, endpoint: "/v1/legal/intake → /v1/legal/corporate/analyze" },
  { id: "S9", name: "Prompt Injection: Override System Behavior", v1: true, v2: true, endpoint: "/v1/legal/intake", note: "Confirmed injection-resistant" },
  { id: "S10", name: "Privileged/Confidential Intake: Attorney-Client Privilege Assertion", v1: true, v2: false, endpoint: "/v1/legal/intake", gap: "escalation_flag=false on privilege assertion. Needs privilege keyword pre-processing." },
];

const GAPS = [
  {
    id: "S4",
    title: "S4 — Intake Calibration",
    scenario: "Low-Confidence Escalation: Deliberately Vague Text",
    symptom: "intake confidence=0.95 on deliberately vague input. Should be <0.6 with escalation_flag=true.",
    fix: "Add uncertainty instruction to intake system prompt: 'If the matter description is vague, ambiguous, or lacks specific legal context, set confidence below 0.6 and escalation_flag=true.'",
    file: "artifacts/api-server/src/routes/legal.ts",
    effort: "~10 lines",
    color: "text-amber-400",
    border: "border-amber-500/20",
    bg: "bg-amber-500/5",
  },
  {
    id: "S6",
    title: "S6 — Employment Escalation",
    scenario: "California Non-Compete + Mandatory Arbitration",
    symptom: "escalation_flag=false despite California non-compete clause (unenforceable under CA law).",
    fix: "Post-process employment analysis: if jurisdiction contains 'California' and compliance_flags contains 'non_compete', force escalation_flag=true and add 'CA_NON_COMPETE_UNENFORCEABLE' to compliance_flags.",
    file: "artifacts/api-server/src/routes/legal.ts",
    effort: "~15 lines",
    color: "text-red-400",
    border: "border-red-500/20",
    bg: "bg-red-500/5",
  },
  {
    id: "S10",
    title: "S10 — Privilege Detection",
    scenario: "Attorney-Client Privilege Assertion",
    symptom: "escalation_flag=false when input contains explicit privilege assertion ('attorney-client privilege', 'privileged and confidential').",
    fix: "Pre-process intake input: scan for privilege keywords before LLM call. If found, inject privilege_detected=true into context and force escalation_flag=true in response.",
    file: "artifacts/api-server/src/routes/legal.ts",
    effort: "~20 lines",
    color: "text-purple-400",
    border: "border-purple-500/20",
    bg: "bg-purple-500/5",
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricBar({ value, max = 1.0, color }: { value: number; max?: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <span className="text-xs font-mono font-bold text-foreground w-10 text-right">
        {value === 1.0 ? "1.000" : value.toFixed(3)}
      </span>
    </div>
  );
}

function EvalStageCard({ stage }: { stage: typeof EVAL_STAGES[0] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border p-4 ${stage.border} ${stage.bg}`}>
      <button
        className="w-full flex items-center justify-between text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <TrendingUp className={`w-4 h-4 shrink-0 ${stage.color}`} aria-hidden="true" />
          <div>
            <p className={`text-xs font-mono font-bold ${stage.color}`}>{stage.label}</p>
            <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{stage.model}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0 ml-4">
          {stage.accuracy !== null && (
            <div className="text-right">
              <p className="text-[10px] font-mono text-muted-foreground">Accuracy</p>
              <p className={`text-sm font-mono font-bold ${stage.color}`}>{(stage.accuracy * 100).toFixed(0)}%</p>
            </div>
          )}
          {stage.macroF1 !== null && stage.macroF1 !== undefined && (
            <div className="text-right">
              <p className="text-[10px] font-mono text-muted-foreground">Macro F1</p>
              <p className={`text-sm font-mono font-bold ${stage.color}`}>{stage.macroF1.toFixed(3)}</p>
            </div>
          )}
          {(stage as any).correctnessPassRate !== undefined && (
            <div className="text-right">
              <p className="text-[10px] font-mono text-muted-foreground">Correctness</p>
              <p className={`text-sm font-mono font-bold ${stage.color}`}>{((stage as any).correctnessPassRate * 100).toFixed(0)}%</p>
            </div>
          )}
          {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />}
        </div>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-border/40 space-y-3">
          <p className="text-[11px] font-mono text-muted-foreground">{stage.method}</p>
          <div className="space-y-2">
            {stage.accuracy !== null && (
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Accuracy</p>
                <MetricBar value={stage.accuracy} color={stage.bar} />
              </div>
            )}
            {stage.macroF1 !== null && stage.macroF1 !== undefined && (
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Macro F1</p>
                <MetricBar value={stage.macroF1} color={stage.bar} />
              </div>
            )}
            {(stage as any).presencePassRate !== undefined && (
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Presence Pass Rate</p>
                <MetricBar value={(stage as any).presencePassRate} color={stage.bar} />
              </div>
            )}
            {(stage as any).correctnessPassRate !== undefined && (
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Correctness Pass Rate</p>
                <MetricBar value={(stage as any).correctnessPassRate} color={stage.bar} />
              </div>
            )}
          </div>
          {(stage as any).scenariosPassed !== undefined && (
            <p className="text-[11px] font-mono text-muted-foreground">
              {(stage as any).scenariosPassed}/{stage.n} scenarios passed · n={stage.n} test examples
            </p>
          )}
          {stage.id === "rag" && (
            <p className="text-[10px] font-mono text-amber-400/80">
              Internal regression only. Not validated on real contracts. Not production-ready.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ScenarioRow({ s }: { s: typeof PLAYBOOK_SCENARIOS[0] }) {
  const [open, setOpen] = useState(false);
  const hasGap = !!s.gap;
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/20 transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="text-[10px] font-mono text-muted-foreground w-6 shrink-0">{s.id}</span>
        <span className="flex-1 text-xs font-mono text-foreground min-w-0 truncate">{s.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-muted-foreground">v1</span>
            {s.v1 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-label="pass" /> : <XCircle className="w-3.5 h-3.5 text-red-400" aria-label="fail" />}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-muted-foreground">v2</span>
            {s.v2 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-label="pass" /> : <XCircle className="w-3.5 h-3.5 text-red-400" aria-label="fail" />}
          </div>
          {hasGap && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-label="known gap" />}
          {open ? <ChevronDown className="w-3 h-3 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" aria-hidden="true" />}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 bg-secondary/10 space-y-2">
          <p className="text-[10px] font-mono text-muted-foreground">Endpoint: <span className="text-primary">{s.endpoint}</span></p>
          {s.note && <p className="text-[11px] font-mono text-muted-foreground">{s.note}</p>}
          {s.gap && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2">
              <p className="text-[10px] font-mono text-amber-400 font-bold mb-1">Known Gap</p>
              <p className="text-[11px] font-mono text-muted-foreground">{s.gap}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GapCard({ gap }: { gap: typeof GAPS[0] }) {
  return (
    <div className={`rounded-lg border p-4 ${gap.border} ${gap.bg}`}>
      <div className="flex items-start gap-3">
        <Wrench className={`w-4 h-4 shrink-0 mt-0.5 ${gap.color}`} aria-hidden="true" />
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <p className={`text-xs font-mono font-bold ${gap.color}`}>{gap.title}</p>
            <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{gap.scenario}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Symptom</p>
            <p className="text-[11px] font-mono text-muted-foreground">{gap.symptom}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Fix</p>
            <p className="text-[11px] font-mono text-muted-foreground">{gap.fix}</p>
          </div>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">File</p>
              <p className="text-[10px] font-mono text-primary">{gap.file}</p>
            </div>
            <div>
              <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">Effort</p>
              <p className="text-[10px] font-mono text-foreground">{gap.effort}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function TrainingTab() {
  const [section, setSection] = useState<"overview" | "eval" | "playbook" | "gaps">("overview");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <span className="text-xs font-mono font-bold text-foreground">Training & Evaluation</span>
        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
          How the Legal AI workforce was built, evaluated, and adversarially tested.
          Full lineage from dataset to deployed endpoint.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Training Examples", value: "30", sub: "CUAD v1 (CC BY 4.0)", color: "text-blue-400" },
          { label: "RAG Accuracy", value: "100%", sub: "10 test examples", color: "text-emerald-400" },
          { label: "Playbook v1", value: "9/10", sub: "presence pass rate 1.0", color: "text-blue-400" },
          { label: "Playbook v2", value: "6/10", sub: "correctness 0.75", color: "text-amber-400" },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="bg-card border border-border rounded-lg p-3">
            <p className="text-[10px] font-mono text-muted-foreground mb-1">{label}</p>
            <p className={`text-lg font-mono font-bold ${color}`}>{value}</p>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Section tabs */}
      <div className="flex border-b border-border gap-4" role="tablist">
        {([
          { key: "overview", label: "Overview", icon: Database },
          { key: "eval", label: "Eval Stages", icon: TrendingUp },
          { key: "playbook", label: "Playbook", icon: FlaskConical },
          { key: "gaps", label: "Gap Fixes", icon: Wrench },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            role="tab"
            aria-selected={section === key}
            className={`flex items-center gap-1.5 text-[11px] font-mono py-2 border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
              section === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-3 h-3" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {section === "overview" && (
        <div className="space-y-4">
          {/* What we built */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary" aria-hidden="true" />
              <span className="text-xs font-mono font-bold text-foreground">What We Built</span>
            </div>
            <p className="text-sm font-mono text-foreground leading-relaxed">
              RAG adaptation — not fine-tuning. We built a retrieval-augmented generation layer on top of{" "}
              <span className="text-primary">liquid/lfm-2.5-1.2b-instruct</span> using FAISS vector search
              over CUAD legal clause examples. The model itself is unchanged; we inject relevant examples
              into the context window at inference time.
            </p>
            <p className="text-sm font-mono text-muted-foreground leading-relaxed">
              This approach is faster to iterate, cheaper to run, and fully auditable — every response
              carries the exact retrieval context that produced it. The tradeoff is that performance
              is bounded by retrieval quality, not model capacity.
            </p>
          </div>

          {/* Dataset */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-400" aria-hidden="true" />
              <span className="text-xs font-mono font-bold text-foreground">Dataset</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                {[
                  ["Source", DATASET.source],
                  ["Total examples", String(DATASET.total)],
                  ["Train / Val / Test", `${DATASET.splits.train} / ${DATASET.splits.val} / ${DATASET.splits.test}`],
                  ["Retriever", DATASET.retriever],
                  ["Embedding model", DATASET.embeddingModel],
                  ["Embedding dim", String(DATASET.embeddingDim)],
                  ["Retrieval threshold", String(DATASET.retrievalThreshold)],
                  ["Top-K", String(DATASET.topK)],
                ].map(([label, val]) => (
                  <div key={label} className="flex gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider shrink-0 w-32">{label}</span>
                    <span className="text-[11px] font-mono text-foreground">{val}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-2">Clause Types</p>
                <div className="space-y-1">
                  {DATASET.clauseTypes.map((c) => (
                    <div key={c} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" aria-hidden="true" />
                      <span className="text-[11px] font-mono text-foreground">{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Architecture */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <span className="text-xs font-mono font-bold text-foreground">Inference Architecture</span>
            </div>
            <div className="font-mono text-xs text-muted-foreground leading-6 bg-secondary/30 rounded p-3 border border-border/50">
              <p className="text-primary mb-1"># Request flow</p>
              <p>{"Input text"}</p>
              <p>{"  → embed(all-MiniLM-L6-v2, 384-dim)"}</p>
              <p>{"  → FAISS.search(IndexFlatIP, top_k=3, threshold=0.35)"}</p>
              <p>{"  → inject retrieved examples into system prompt"}</p>
              <p>{"  → liquid/lfm-2.5-1.2b-instruct(augmented_prompt)"}</p>
              <p>{"  → parse structured output (clause_type, clause_text, confidence)"}</p>
              <p>{"  → governance envelope (human_review_required, privilege_warning)"}</p>
              <p>{"  → audit trace (model, dataset_version, deployment_id, trace_id)"}</p>
            </div>
          </div>
        </div>
      )}

      {/* Eval stages */}
      {section === "eval" && (
        <div className="space-y-3">
          <p className="text-sm font-mono text-muted-foreground">
            Four evaluation stages, each building on the last. Zero-shot establishes the baseline.
            RAG proves the retrieval approach. Playbook v1 proves infrastructure. Playbook v2 proves
            policy intelligence — and surfaces the real gaps.
          </p>
          {EVAL_STAGES.map((stage) => (
            <EvalStageCard key={stage.id} stage={stage} />
          ))}
          <div className="rounded-lg border border-border/50 bg-secondary/10 p-3">
            <p className="text-[11px] font-mono text-muted-foreground">
              <span className="text-foreground font-bold">Interpretation:</span>{" "}
              v1 proved infrastructure (presence). v2 proves policy intelligence (correctness).
              The 3 regressions in v2 are not new bugs — they are gaps that v1 could not see.
              v2 correctness_pass_rate=0.75 reflects actual policy intelligence level, not a step backward.
            </p>
          </div>
        </div>
      )}

      {/* Playbook */}
      {section === "playbook" && (
        <div className="space-y-3">
          <p className="text-sm font-mono text-muted-foreground">
            10 adversarial scenarios covering the full workforce. Each scenario runs against live endpoints.
            v1 = presence check (right fields?). v2 = correctness check (right values?).
          </p>
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {/* Legend */}
            <div className="flex items-center gap-4 px-4 py-2 bg-secondary/20 border-b border-border/50">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span className="text-[10px] font-mono text-muted-foreground">Pass</span>
              </div>
              <div className="flex items-center gap-1.5">
                <XCircle className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
                <span className="text-[10px] font-mono text-muted-foreground">Fail</span>
              </div>
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                <span className="text-[10px] font-mono text-muted-foreground">Known gap</span>
              </div>
            </div>
            {PLAYBOOK_SCENARIOS.map((s) => (
              <ScenarioRow key={s.id} s={s} />
            ))}
          </div>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Confirmed Strengths", value: "6", desc: "S1, S2, S3, S5, S8, S9", color: "text-emerald-400", border: "border-emerald-500/20", bg: "bg-emerald-500/5" },
              { label: "Known Gaps", value: "3", desc: "S4, S6, S10 — deterministic fixes", color: "text-amber-400", border: "border-amber-500/20", bg: "bg-amber-500/5" },
              { label: "Infrastructure Fail", value: "1", desc: "S7 — 400 not wrapped in envelope", color: "text-red-400", border: "border-red-500/20", bg: "bg-red-500/5" },
            ].map(({ label, value, desc, color, border, bg }) => (
              <div key={label} className={`rounded-lg border p-3 ${border} ${bg}`}>
                <p className="text-[10px] font-mono text-muted-foreground mb-1">{label}</p>
                <p className={`text-xl font-mono font-bold ${color}`}>{value}</p>
                <p className="text-[10px] font-mono text-muted-foreground mt-1">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gap fixes */}
      {section === "gaps" && (
        <div className="space-y-3">
          <p className="text-sm font-mono text-muted-foreground">
            3 confirmed gaps from Playbook v2. All are deterministic fixes — no model retraining required.
            Each fix is a targeted code change in the legal route handler.
          </p>
          {GAPS.map((gap) => (
            <GapCard key={gap.id} gap={gap} />
          ))}
          <div className="rounded-lg border border-border/50 bg-secondary/10 p-3">
            <p className="text-[11px] font-mono text-muted-foreground">
              <span className="text-foreground font-bold">Why no retraining?</span>{" "}
              All 3 gaps are rule-based failures, not model capability failures. The LLM correctly
              identifies the legal content — it just doesn't apply the right escalation logic.
              Post-processing rules and system prompt instructions are the right fix, not more training data.
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="pt-2 border-t border-border/50">
        <p className="text-[11px] font-mono text-muted-foreground">
          All eval results are internal regression only. Not validated on real client contracts.
          Human review required on all outputs. This system is not a law firm and does not provide legal advice.
        </p>
      </div>
    </div>
  );
}
