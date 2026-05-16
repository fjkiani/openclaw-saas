import { Link } from "wouter";
import {
  ArrowRight,
  Check,
  Shield,
  Scale,
  FileText,
  Zap,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Database,
  Cpu,
  Building2,
  Globe,
} from "lucide-react";

// ─── Data ─────────────────────────────────────────────────────────────────────

const AGENTS = [
  { name: "Intake Router", endpoint: "POST /v1/legal/intake", desc: "Classifies matter type, assigns confidence, routes to specialist" },
  { name: "Contract Analyst", endpoint: "POST /v1/legal/contract/analyze", desc: "Governing law, termination, IP assignment, indemnification" },
  { name: "Litigation Analyst", endpoint: "POST /v1/legal/litigation/analyze", desc: "Jurisdiction, escalation triggers, privilege detection" },
  { name: "IP Analyst", endpoint: "POST /v1/legal/ip/analyze", desc: "Assignment validity, licensing scope, moral rights, work-for-hire" },
  { name: "Employment Analyst", endpoint: "POST /v1/legal/employment/analyze", desc: "Non-compete enforceability, wage compliance, termination risk" },
  { name: "Corporate Analyst", endpoint: "POST /v1/legal/corporate/analyze", desc: "M&A clause review, board resolution, regulatory flags" },
  { name: "Clause Extractor", endpoint: "POST /v1/legal/extract-clause", desc: "RAG-augmented extraction across 5 clause types" },
];

const MOAT = [
  {
    icon: Database,
    title: "Trained, not prompted",
    desc: "RAG adaptation on CUAD v1 — 510 commercial contracts, 41 clause types. Zero-shot acc=0.925 → RAG acc=1.0. The retrieval index is the moat, not the model.",
  },
  {
    icon: Shield,
    title: "Governed by design",
    desc: "Every output carries human_review_required, privilege_warning, escalation_flag, and a full audit trace. Governance is not a feature — it's the envelope every response exits through.",
  },
  {
    icon: AlertTriangle,
    title: "Adversarially tested",
    desc: "10 adversarial scenarios. Injection resistance confirmed (S9). Multi-clause parsing confirmed (S2). 3 known gaps documented with deterministic fixes — no model retraining required.",
  },
  {
    icon: Cpu,
    title: "Full lineage on every call",
    desc: "Model version, dataset version, eval score, deployment ID, and trace ID on every response. You know exactly what produced every output.",
  },
];

const WORKFLOW = [
  {
    step: "01",
    label: "Intake",
    desc: "Client submits a matter. The intake router classifies it, assigns a confidence score, and routes to the right specialist.",
    color: "text-blue-400",
    border: "border-blue-500/20",
    bg: "bg-blue-500/5",
  },
  {
    step: "02",
    label: "Specialist",
    desc: "The right agent analyzes the matter — clause extraction, risk flags, jurisdiction, escalation triggers.",
    color: "text-purple-400",
    border: "border-purple-500/20",
    bg: "bg-purple-500/5",
  },
  {
    step: "03",
    label: "Governance",
    desc: "Every output is wrapped: human_review_required=true, privilege_warning, compliance_flags, escalation_flag.",
    color: "text-amber-400",
    border: "border-amber-500/20",
    bg: "bg-amber-500/5",
  },
  {
    step: "04",
    label: "Trace",
    desc: "Full audit trail attached: model, dataset version, eval score, deployment ID, timestamp. Immutable.",
    color: "text-emerald-400",
    border: "border-emerald-500/20",
    bg: "bg-emerald-500/5",
  },
];

const VERTICALS = [
  { icon: Scale, name: "Law Firms", desc: "Contract review, litigation intake, IP analysis, employment compliance — all governed, all auditable.", status: "live" },
  { icon: Building2, name: "Corporate Legal", desc: "In-house counsel AI layer. Contract lifecycle, M&A due diligence, regulatory compliance.", status: "soon" },
  { icon: FileText, name: "Insurance", desc: "Policy clause extraction, claims triage, coverage analysis, subrogation.", status: "soon" },
  { icon: Globe, name: "Real Estate", desc: "Purchase agreements, title review, lease analysis, zoning compliance.", status: "soon" },
];

const EVAL_PROOF = [
  { label: "Zero-shot baseline", value: "92.5%", sub: "accuracy, no retrieval", color: "text-zinc-400" },
  { label: "RAG adaptation", value: "100%", sub: "accuracy + macro F1=1.0", color: "text-emerald-400" },
  { label: "Playbook v1", value: "9/10", sub: "presence pass rate 1.0", color: "text-blue-400" },
  { label: "Playbook v2", value: "75%", sub: "correctness — 3 known gaps", color: "text-amber-400" },
];

const TIERS = [
  {
    name: "Starter",
    price: "$0",
    period: "/month",
    desc: "Explore the workforce",
    features: [
      "All 7 live endpoints",
      "Legal AI Operating Layer workspace",
      "Dataset Explorer + Schema viewer",
      "Playbook results + gap analysis",
      "Governance envelope on every call",
    ],
    cta: "Start free",
    href: "/sign-up",
    highlighted: false,
  },
  {
    name: "Professional",
    price: "$49",
    period: "/month",
    desc: "For legal teams in production",
    features: [
      "Everything in Starter",
      "Custom vertical configuration",
      "Additional clause type training",
      "Priority support",
      "Audit log export",
      "Custom governance policies",
    ],
    cta: "Start trial",
    href: "/sign-up",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    desc: "For organizations at scale",
    features: [
      "Everything in Professional",
      "On-premise deployment",
      "Custom model training",
      "SSO / SAML",
      "Dedicated infrastructure",
      "SLA guarantee",
    ],
    cta: "Contact us",
    href: "/sign-up",
    highlighted: false,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Nav */}
      <nav className="border-b border-border/50 px-6 py-4 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="OpenClaw" className="w-7 h-7" />
          <span className="font-mono font-bold tracking-tight text-foreground">OpenClaw</span>
          <span className="ml-1 text-[10px] font-mono bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded">BETA</span>
        </div>
        <div className="flex items-center gap-4">
          <a href="#how-it-works" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">How it works</a>
          <a href="#eval" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">Eval</a>
          <a href="#pricing" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">Pricing</a>
          <Link href="/sign-in" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors" data-testid="link-signin">
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="flex items-center gap-1.5 px-4 py-1.5 bg-primary text-primary-foreground text-sm font-mono font-bold rounded hover:bg-primary/90 transition-colors"
            data-testid="link-signup"
          >
            Get access <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-20 pb-16 text-center max-w-5xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-emerald-400 text-xs font-mono mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
          7 agents live · openclaw-api-k30t.onrender.com
        </div>

        <h1 className="text-5xl sm:text-6xl font-mono font-bold tracking-tight text-foreground mb-6 leading-tight">
          The Legal AI<br />
          <span className="text-primary">Workforce</span>
        </h1>

        <p className="text-lg font-mono text-foreground mb-4 max-w-2xl mx-auto leading-relaxed">
          7 governed AI agents for legal workflows. Intake router, 5 domain specialists,
          clause extractor. Every output governed, traced, and ready for attorney review.
        </p>
        <p className="text-base font-mono text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed">
          Not a chatbot. Not a wrapper. A trained, adversarially tested, production-deployed
          AI workforce with full audit lineage on every call.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link
            href="/sign-up"
            className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono font-bold rounded hover:bg-primary/90 transition-colors"
            data-testid="button-hero-signup"
          >
            Access the workforce <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/sign-in"
            className="px-6 py-3 border border-border font-mono text-sm text-foreground rounded hover:bg-secondary/50 transition-colors"
            data-testid="button-hero-signin"
          >
            Sign in to dashboard
          </Link>
        </div>
      </section>

      {/* Live agents */}
      <section className="px-6 py-12 max-w-5xl mx-auto">
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-foreground">Live Endpoints</span>
            <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
              All systems operational
            </span>
          </div>
          <div className="divide-y divide-border/50">
            {AGENTS.map((agent) => (
              <div key={agent.name} className="flex items-start gap-4 px-4 py-3 hover:bg-secondary/20 transition-colors">
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                  <span className="text-[10px] font-mono text-emerald-400">LIVE</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs font-mono font-bold text-foreground">{agent.name}</span>
                    <span className="text-[10px] font-mono text-primary">{agent.endpoint}</span>
                  </div>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{agent.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Moat */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">
            What makes this defensible
          </h2>
          <p className="text-base font-mono text-muted-foreground max-w-2xl mx-auto">
            Anyone can wrap GPT-4 in a legal prompt. This is different.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {MOAT.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="border border-border rounded-lg p-5 bg-card hover:border-primary/30 transition-colors">
              <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center mb-3" aria-hidden="true">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <h3 className="font-mono font-bold text-sm text-foreground mb-2">{title}</h3>
              <p className="text-sm font-mono text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-16 max-w-5xl mx-auto" id="how-it-works">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">How it works</h2>
          <p className="text-base font-mono text-muted-foreground">Every matter flows through the same governed pipeline.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {WORKFLOW.map(({ step, label, desc, color, border, bg }) => (
            <div key={step} className={`rounded-lg border p-4 ${border} ${bg}`}>
              <span className={`text-xs font-mono font-bold ${color} block mb-2`}>{step}</span>
              <h3 className={`font-mono font-bold text-sm mb-2 ${color}`}>{label}</h3>
              <p className="text-sm font-mono text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>

        {/* Governance envelope */}
        <div className="mt-6 rounded-lg border border-amber-500/20 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Shield className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <span className="text-xs font-mono font-bold text-amber-400">Governance Envelope — on every response</span>
          </div>
          <div className="font-mono text-xs text-muted-foreground leading-6 bg-background/40 rounded p-3 border border-border/40">
            <p>{`{`}</p>
            <p className="pl-4"><span className="text-emerald-400">"human_review_required"</span>: <span className="text-amber-400">true</span>,</p>
            <p className="pl-4"><span className="text-emerald-400">"privilege_warning"</span>: <span className="text-blue-400">"AI interaction does not create attorney-client privilege"</span>,</p>
            <p className="pl-4"><span className="text-emerald-400">"escalation_flag"</span>: <span className="text-amber-400">false</span>,</p>
            <p className="pl-4"><span className="text-emerald-400">"compliance_flags"</span>: [],</p>
            <p className="pl-4"><span className="text-emerald-400">"trace"</span>: {"{"} <span className="text-zinc-400">"model"</span>: "liquid/lfm-2.5-1.2b-instruct", <span className="text-zinc-400">"dataset_version"</span>: "cuad-v2", <span className="text-zinc-400">"trace_id"</span>: "trc_..." {"}"}</p>
            <p>{`}`}</p>
          </div>
        </div>
      </section>

      {/* Eval proof */}
      <section className="px-6 py-16 max-w-5xl mx-auto" id="eval">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">Eval results</h2>
          <p className="text-base font-mono text-muted-foreground max-w-2xl mx-auto">
            We publish our numbers — including the gaps. That's the point.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          {EVAL_PROOF.map(({ label, value, sub, color }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4 text-center">
              <p className="text-[11px] font-mono text-muted-foreground mb-2">{label}</p>
              <p className={`text-2xl font-mono font-bold ${color}`}>{value}</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-1">{sub}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card border border-emerald-500/20 rounded-lg p-4">
            <p className="text-xs font-mono font-bold text-emerald-400 mb-3">Confirmed Strengths</p>
            <ul className="space-y-2">
              {[
                "S1 — Clean governing law clause extraction",
                "S2 — Ambiguous multi-clause parsing",
                "S3 — Cross-jurisdiction conflict detection",
                "S5 — IP assignment edge cases (moral rights, work-for-hire)",
                "S8 — Full pipeline: intake → corporate → audit",
                "S9 — Prompt injection resistance",
              ].map((s) => (
                <li key={s} className="flex items-start gap-2 text-sm font-mono text-muted-foreground">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-card border border-amber-500/20 rounded-lg p-4">
            <p className="text-xs font-mono font-bold text-amber-400 mb-3">Known Gaps — Deterministic Fixes</p>
            <ul className="space-y-2">
              {[
                "S4 — Intake calibration: high confidence on vague input",
                "S6 — Employment: CA non-compete not triggering escalation",
                "S10 — Privilege detection: assertion not caught at intake",
              ].map((s) => (
                <li key={s} className="flex items-start gap-2 text-sm font-mono text-muted-foreground">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                  {s}
                </li>
              ))}
            </ul>
            <p className="text-[11px] font-mono text-muted-foreground mt-3 pt-3 border-t border-border/50">
              All 3 are rule-based fixes — no model retraining required. ~45 lines of code total.
            </p>
          </div>
        </div>
      </section>

      {/* Verticals */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">Built for legal workflows</h2>
          <p className="text-base font-mono text-muted-foreground">One governed AI infrastructure. Multiple verticals.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {VERTICALS.map(({ icon: Icon, name, desc, status }) => (
            <div key={name} className="border border-border rounded-lg p-4 bg-card hover:border-primary/30 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center" aria-hidden="true">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                {status === "live" ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE</span>
                ) : (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">SOON</span>
                )}
              </div>
              <h3 className="font-mono font-bold text-sm text-foreground mb-2">{name}</h3>
              <p className="text-sm font-mono text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="px-6 py-16 max-w-5xl mx-auto" id="pricing">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">Pricing</h2>
          <p className="text-base font-mono text-muted-foreground">Start free. The workforce is live.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`rounded-lg border p-6 flex flex-col ${
                tier.highlighted ? "border-primary bg-primary/5" : "border-border bg-card"
              }`}
            >
              {tier.highlighted && (
                <div className="text-[10px] font-mono text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded self-start mb-3">
                  MOST POPULAR
                </div>
              )}
              <h3 className="font-mono font-bold text-foreground mb-1">{tier.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-3xl font-mono font-bold text-foreground">{tier.price}</span>
                <span className="text-xs font-mono text-muted-foreground">{tier.period}</span>
              </div>
              <p className="text-sm font-mono text-muted-foreground mb-5">{tier.desc}</p>
              <ul className="space-y-2 mb-6 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm font-mono text-foreground">
                    <Check className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href={tier.href}
                className={`w-full text-center py-2.5 rounded text-sm font-mono font-bold transition-colors ${
                  tier.highlighted
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border text-foreground hover:bg-secondary/50"
                }`}
                data-testid={`button-cta-${tier.name.toLowerCase()}`}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-10">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 mb-3">
            <img src="/logo.svg" alt="OpenClaw" className="w-5 h-5" />
            <span className="font-mono font-bold text-foreground">OpenClaw</span>
          </div>
          <p className="text-sm font-mono text-muted-foreground mb-4 max-w-xl">
            Governed AI infrastructure for legal workflows. All outputs require human review.
            This system is not a law firm and does not provide legal advice.
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              "/v1/legal/intake",
              "/v1/legal/extract-clause",
              "/v1/legal/contract/analyze",
              "/v1/legal/litigation/analyze",
              "/v1/legal/ip/analyze",
              "/v1/legal/employment/analyze",
              "/v1/legal/corporate/analyze",
            ].map((ep) => (
              <span key={ep} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">
                {ep}
              </span>
            ))}
          </div>
          <p className="text-[11px] font-mono text-muted-foreground mt-4">
            API: <span className="text-primary">https://openclaw-api-k30t.onrender.com</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
