import { useState } from "react";
import {
  Building2,
  ArrowRight,
  CheckCircle2,
  Zap,
  Shield,
  Users,
  FileText,
  Scale,
  Briefcase,
  Globe,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

type WorkflowStep = {
  id: string; label: string; agent: string; endpoint: string;
  description: string; output: string;
  color: string; border: string; bg: string;
  icon: React.ComponentType<{ className?: string }>;
};
type Vertical = {
  id: string; name: string; tagline: string;
  icon: React.ComponentType<{ className?: string }>;
  status: "live" | "coming-soon"; description: string;
  workflow: WorkflowStep[]; capabilities: string[]; governance: string[];
};

const VERTICALS: Vertical[] = [
  {
    id: "law-firm", name: "Law Firm", tagline: "AI-augmented legal practice", icon: Scale, status: "live",
    description: "A fully deployed AI workforce for legal practices. Every client matter flows through an intake router, gets triaged to the right specialist, and exits with a governance-wrapped output ready for attorney review.",
    workflow: [
      { id: "intake", label: "Intake Router", agent: "Intake Router", endpoint: "POST /v1/legal/intake", description: "Classifies the matter type, assigns confidence, and routes to the right specialist.", output: '{ "matter_type": "contract", "confidence": 0.94, "recommended_specialist": "contract_analyst" }', color: "text-blue-400", border: "border-blue-500/20", bg: "bg-blue-500/5", icon: ArrowRight },
      { id: "specialist", label: "Specialist Agent", agent: "Contract / Litigation / IP / Employment / Corporate", endpoint: "POST /v1/legal/{matter}/analyze", description: "Domain-specific analysis: clause extraction, risk flags, jurisdiction, escalation triggers.", output: '{ "clauses": [...], "risk_flags": [...], "escalation_flag": false, "jurisdiction": "Delaware" }', color: "text-purple-400", border: "border-purple-500/20", bg: "bg-purple-500/5", icon: Briefcase },
      { id: "governance", label: "Governance Layer", agent: "Policy Engine", endpoint: "Wraps every response", description: "Injects human_review_required, privilege_warning, and compliance metadata on every output.", output: '{ "human_review_required": true, "privilege_warning": "AI interaction does not create attorney-client privilege", "compliance_flags": [] }', color: "text-amber-400", border: "border-amber-500/20", bg: "bg-amber-500/5", icon: Shield },
      { id: "trace", label: "Audit Trace", agent: "Trace Logger", endpoint: "Attached to every response", description: "Full lineage: model version, dataset, eval score, deployment ID, and timestamp on every call.", output: '{ "model": "liquid/lfm-2.5-1.2b-instruct", "dataset_version": "cuad-v2", "deployment_id": "dep_001", "trace_id": "trc_..." }', color: "text-emerald-400", border: "border-emerald-500/20", bg: "bg-emerald-500/5", icon: FileText },
    ],
    capabilities: [
      "Contract review: governing law, termination, IP assignment, indemnification, limitation of liability",
      "Litigation intake: matter classification, jurisdiction detection, escalation triggers",
      "IP analysis: assignment validity, licensing scope, ownership chain",
      "Employment: non-compete enforceability, wage compliance, termination risk",
      "Corporate: M&A clause review, board resolution analysis, regulatory flags",
      "Injection-resistant: adversarially tested against prompt injection (S9 — confirmed pass)",
      "Multi-clause parsing: extracts all clause types in a single pass (S2 — confirmed pass)",
    ],
    governance: [
      "human_review_required=true on every legal output",
      "privilege_warning on every response — AI does not create attorney-client privilege",
      "escalation_flag=true when confidence < threshold or matter is complex",
      "Deployment requires approval — allowed models enforced by policy",
      "Full audit trace: model version, dataset lineage, eval score, deployment ID",
    ],
  },
  {
    id: "corporate-legal", name: "Corporate Legal", tagline: "In-house counsel AI layer", icon: Building2, status: "coming-soon",
    description: "AI workforce for in-house legal teams. Contract lifecycle management, regulatory compliance monitoring, and M&A due diligence — all governed and auditable.",
    workflow: [],
    capabilities: ["Contract lifecycle: draft → review → redline → execution", "Regulatory compliance: jurisdiction-specific flag detection", "M&A due diligence: clause-level risk scoring across data rooms", "Board governance: resolution drafting and approval tracking"],
    governance: ["Same governance envelope as Law Firm vertical", "Role-based access: GC, associate counsel, paralegal tiers", "Data residency controls for regulated industries"],
  },
  {
    id: "insurance", name: "Insurance", tagline: "Policy and claims AI workforce", icon: FileText, status: "coming-soon",
    description: "Automated policy review, claims triage, and coverage analysis. Built on the same governed AI infrastructure as the Law Firm vertical.",
    workflow: [],
    capabilities: ["Policy clause extraction: coverage limits, exclusions, conditions", "Claims triage: liability assessment, coverage determination", "Subrogation analysis: third-party recovery potential", "Regulatory compliance: state-specific insurance law flags"],
    governance: ["Same governance envelope as Law Firm vertical", "Jurisdiction-aware: 50-state insurance regulation coverage", "Human review required on all coverage determinations"],
  },
  {
    id: "real-estate", name: "Real Estate", tagline: "Transaction and title AI layer", icon: Globe, status: "coming-soon",
    description: "AI workforce for real estate transactions: purchase agreements, title review, lease analysis, and zoning compliance.",
    workflow: [],
    capabilities: ["Purchase agreement review: contingencies, closing conditions, representations", "Lease analysis: rent escalation, termination rights, assignment clauses", "Title review: encumbrances, easements, chain of title", "Zoning compliance: permitted use, variance requirements"],
    governance: ["Same governance envelope as Law Firm vertical", "Jurisdiction-specific: state and local law awareness", "Human review required on all title and zoning determinations"],
  },
];

function WorkflowStepCard({ step, index, total }: { step: WorkflowStep; index: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = step.icon;
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center shrink-0">
        <div className={`w-7 h-7 rounded-full border flex items-center justify-center ${step.border} ${step.bg}`}>
          <Icon className={`w-3.5 h-3.5 ${step.color}`} aria-hidden="true" />
        </div>
        {index < total - 1 && <div className="w-px h-full min-h-[24px] bg-border/50 mt-1" aria-hidden="true" />}
      </div>
      <div className={`flex-1 mb-4 rounded-lg border p-3 ${step.border} ${step.bg}`}>
        <button className="w-full flex items-center justify-between text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <div>
            <p className={`text-xs font-mono font-bold ${step.color}`}>{step.label}</p>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{step.agent}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="text-[10px] font-mono text-muted-foreground hidden sm:block">{step.endpoint}</span>
            {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" aria-hidden="true" />}
          </div>
        </button>
        {expanded && (
          <div className="mt-2 pt-2 border-t border-border/40 space-y-2">
            <p className="text-[11px] font-mono text-muted-foreground">{step.description}</p>
            <div>
              <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">Sample Output</p>
              <pre className="text-[10px] font-mono text-foreground bg-background/60 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all border border-border/40">{step.output}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VerticalCard({ vertical, defaultOpen }: { vertical: Vertical; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [section, setSection] = useState<"workflow" | "capabilities" | "governance">("workflow");
  const Icon = vertical.icon;
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button className="w-full flex items-center justify-between p-4 hover:bg-secondary/20 transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-mono font-bold text-foreground">{vertical.name}</p>
              {vertical.status === "live" ? (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE</span>
              ) : (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">COMING SOON</span>
              )}
            </div>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{vertical.tagline}</p>
          </div>
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />}
      </button>
      {open && (
        <div className="border-t border-border">
          <div className="px-4 pt-3 pb-2">
            <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">{vertical.description}</p>
          </div>
          <div className="flex border-b border-border px-4 gap-4">
            {(["workflow", "capabilities", "governance"] as const).map((s) => (
              <button key={s} onClick={() => setSection(s)} className={`text-[10px] font-mono py-2 border-b-2 transition-colors capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${section === s ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`} aria-selected={section === s} role="tab">{s}</button>
            ))}
          </div>
          <div className="p-4">
            {section === "workflow" && vertical.workflow.length > 0 && vertical.workflow.map((step, i) => <WorkflowStepCard key={step.id} step={step} index={i} total={vertical.workflow.length} />)}
            {section === "workflow" && vertical.workflow.length === 0 && <p className="text-xs font-mono text-muted-foreground py-4 text-center">Workflow diagram available at launch.</p>}
            {section === "capabilities" && (
              <ul className="space-y-1.5" role="list">
                {vertical.capabilities.map((cap, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] font-mono text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />{cap}
                  </li>
                ))}
              </ul>
            )}
            {section === "governance" && (
              <ul className="space-y-1.5" role="list">
                {vertical.governance.map((g, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] font-mono text-muted-foreground">
                    <Shield className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />{g}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SaaSShowcaseTab() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="text-xs font-mono font-bold text-foreground">OpenClaw Platform</span>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">Governed AI infrastructure for legal workflows. One platform, multiple verticals.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">1 LIVE</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">3 COMING SOON</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Live Endpoints", value: "7", icon: Zap, color: "text-primary" },
          { label: "Agents", value: "7", icon: Users, color: "text-purple-400" },
          { label: "Governance Rules", value: "5", icon: Shield, color: "text-amber-400" },
          { label: "Playbook Scenarios", value: "10", icon: FileText, color: "text-emerald-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card border border-border rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Icon className={`w-3 h-3 ${color}`} aria-hidden="true" />
              <span className="text-[10px] font-mono text-muted-foreground">{label}</span>
            </div>
            <p className={`text-lg font-mono font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>
      <div className="space-y-3" role="list" aria-label="Platform verticals">
        {VERTICALS.map((v, i) => <div key={v.id} role="listitem"><VerticalCard vertical={v} defaultOpen={i === 0} /></div>)}
      </div>
      <div className="bg-card border border-border rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ExternalLink className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
          <span className="text-xs font-mono font-bold text-foreground">API Access</span>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground">All endpoints are live at <span className="text-primary font-mono">https://openclaw-api-k30t.onrender.com</span>. Authentication via Clerk JWT. Rate limits apply.</p>
        <p className="text-[10px] font-mono text-amber-400/80">Free tier: service may take 20–30s to respond after inactivity. First request warms the instance.</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {["/v1/legal/matter","/v1/legal/intake","/v1/legal/extract-clause","/v1/legal/contract/analyze","/v1/legal/litigation/analyze","/v1/legal/ip/analyze","/v1/legal/employment/analyze","/v1/legal/corporate/analyze"].map((ep) => (
            <span key={ep} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">{ep}</span>
          ))}
        </div>
      </div>
      <div className="pt-2 border-t border-border/50">
        <p className="text-[10px] font-mono text-muted-foreground">OpenClaw is governed AI infrastructure for legal workflows. All outputs require human review. This system is not a law firm and does not provide legal advice.</p>
      </div>
    </div>
  );
}
