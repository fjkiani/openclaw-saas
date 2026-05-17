import { Link } from "wouter";
import {
  ArrowRight,
  Shield,
  Scale,
  Building2,
  FlaskConical,
  Microscope,
  Zap,
  Database,
  Server,
  CheckCircle2,
} from "lucide-react";

// ─── Data ─────────────────────────────────────────────────────────────────────

const PROOF_BAR = [
  { value: "791+", label: "skills in catalog" },
  { value: "8",    label: "live legal endpoints" },
  { value: "100%", label: "governed outputs — audit trail on every call" },
  { value: "MT",   label: "multi-tenant factory infrastructure" },
];

const HOW_IT_WORKS = [
  {
    icon: Database,
    step: "01",
    title: "Pick your domain",
    desc: "The factory provisions your workspace, skill bundle, data layer, and governance policy.",
    color: "text-blue-400",
    border: "border-blue-500/20",
    bg: "bg-blue-500/5",
  },
  {
    icon: FlaskConical,
    step: "02",
    title: "Your data goes in",
    desc: "A retrieval asset is prepared and evaluated. Your knowledge graph is built. No manual prompt engineering.",
    color: "text-purple-400",
    border: "border-purple-500/20",
    bg: "bg-purple-500/5",
  },
  {
    icon: Server,
    step: "03",
    title: "Your workforce is live",
    desc: "Governed endpoints, human-in-the-loop controls, and a full audit trail on every call.",
    color: "text-emerald-400",
    border: "border-emerald-500/20",
    bg: "bg-emerald-500/5",
  },
];

const VERTICALS = [
  {
    icon: Scale,
    name: "Law Firm",
    skills: ["Clause Extractor", "Intake Router", "Contract Analyst"],
    connectors: ["OpenRouter"],
    status: "live" as const,
    badge: "LIVE",
    badgeCls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    dotCls: "bg-emerald-400",
  },
  {
    icon: Building2,
    name: "Investor Relations",
    skills: ["Investor Research", "Outreach Drafter", "Diligence Responder"],
    connectors: ["Crunchbase", "Gmail"],
    status: "soon" as const,
    badge: "COMING",
    badgeCls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    dotCls: "bg-zinc-400",
  },
  {
    icon: Shield,
    name: "HR & Compliance",
    skills: ["Policy Analyzer", "Offer Letter Reviewer", "Compliance Checker"],
    connectors: ["HRIS", "Slack"],
    status: "soon" as const,
    badge: "COMING",
    badgeCls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    dotCls: "bg-zinc-400",
  },
  {
    icon: Microscope,
    name: "Biotech / Research",
    skills: ["Protocol Generator", "Literature Reviewer", "Compliance Checker"],
    connectors: ["PubMed", "Internal DB"],
    status: "soon" as const,
    badge: "COMING",
    badgeCls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    dotCls: "bg-zinc-400",
  },
];

const GOVERNANCE_JSON = `{
  "human_review_required": true,
  "privilege_warning": "AI interaction does not create attorney-client privilege",
  "escalation_flag": false,
  "not_legal_advice": true,
  "trace": {
    "model_used": "liquid/lfm-2.5-1.2b-instruct",
    "latency_ms": 312,
    "usage_event_id": "evt_01jx..."
  },
  "lineage": {
    "dataset_version": "cuad-v2",
    "eval_run": "legal-clause-extraction-v2",
    "asset_version": "v1.0.0"
  }
}`;

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
          <a href="#how-it-works" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
            How it works
          </a>
          <a href="#verticals" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
            Verticals
          </a>
          <a href="#governance" className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
            Governance
          </a>
          <Link
            href="/sign-in"
            className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-signin"
          >
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
      <section className="px-6 pt-24 pb-20 text-center max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-emerald-400 text-xs font-mono mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
          Legal vertical live · Law Firm workforce ready in 30 seconds
        </div>

        <h1 className="text-5xl sm:text-6xl font-mono font-bold tracking-tight text-foreground mb-6 leading-tight">
          Your AI workforce,<br />
          <span className="text-primary">built for your domain.</span>
        </h1>

        <p className="text-lg font-mono text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed">
          Describe your domain. OpenClaw provisions the workspace, data layer, governance,
          and live agents. You get a working AI workforce — not a chatbot.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link
            href="/sign-up"
            className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono font-bold rounded hover:bg-primary/90 transition-colors"
            data-testid="button-hero-signup"
          >
            Launch your workforce <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/forge"
            className="px-6 py-3 border border-border font-mono text-sm text-foreground rounded hover:bg-secondary/50 transition-colors"
            data-testid="button-hero-demo"
          >
            See the legal vertical
          </Link>
        </div>
      </section>

      {/* Proof bar */}
      <section className="border-y border-border bg-card/50 px-6 py-6">
        <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-6">
          {PROOF_BAR.map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-2xl font-mono font-bold text-primary mb-1">{value}</div>
              <div className="text-[11px] font-mono text-muted-foreground leading-snug">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-20 max-w-4xl mx-auto" id="how-it-works">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">How it works</h2>
          <p className="text-base font-mono text-muted-foreground">
            Three steps from domain to live AI workforce.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {HOW_IT_WORKS.map(({ icon: Icon, step, title, desc, color, border, bg }) => (
            <div key={step} className={`rounded-lg border p-5 ${border} ${bg}`}>
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-8 h-8 rounded flex items-center justify-center border ${border}`}>
                  <Icon className={`w-4 h-4 ${color}`} />
                </div>
                <span className={`text-xs font-mono font-bold ${color}`}>{step}</span>
              </div>
              <h3 className={`font-mono font-bold text-sm mb-2 ${color}`}>{title}</h3>
              <p className="text-sm font-mono text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Verticals */}
      <section className="px-6 py-20 max-w-4xl mx-auto" id="verticals">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-mono font-bold text-foreground mb-3">
            One factory. Every domain.
          </h2>
          <p className="text-base font-mono text-muted-foreground">
            The legal vertical is live. More coming.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {VERTICALS.map(({ icon: Icon, name, skills, connectors, badge, badgeCls, dotCls }) => (
            <div
              key={name}
              className="border border-border rounded-lg p-5 bg-card hover:border-primary/30 transition-colors"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <span className="font-mono font-bold text-sm text-foreground">{name}</span>
                </div>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${badgeCls}`}>
                  {badge}
                </span>
              </div>

              <div className="mb-3">
                <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1.5">Skills</div>
                <div className="flex flex-wrap gap-1.5">
                  {skills.map((s) => (
                    <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-foreground">
                      {s}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1.5">Connectors</div>
                <div className="flex flex-wrap gap-1.5">
                  {connectors.map((c) => (
                    <span key={c} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Governance proof */}
      <section className="px-6 py-20 max-w-4xl mx-auto" id="governance">
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-8">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-5 h-5 text-amber-400" />
            <h2 className="text-xl font-mono font-bold text-foreground">
              Governed by design. Not by policy.
            </h2>
          </div>
          <p className="text-sm font-mono text-muted-foreground mb-6">
            Every output. Every call. Always.
          </p>

          {/* JSON block */}
          <div className="bg-background rounded-lg border border-border p-4 font-mono text-xs leading-6 overflow-x-auto">
            {GOVERNANCE_JSON.split("\n").map((line, i) => {
              // Syntax highlight key parts
              const highlighted = line
                .replace(
                  /"(human_review_required|privilege_warning|escalation_flag|not_legal_advice|trace|lineage|model_used|latency_ms|usage_event_id|dataset_version|eval_run|asset_version)":/g,
                  (m) => `<span class="text-emerald-400">${m}</span>`
                )
                .replace(/: true/g, ': <span class="text-amber-400">true</span>')
                .replace(/: false/g, ': <span class="text-zinc-400">false</span>')
                .replace(/"([^"]+)"(?=,|\n|})/g, (m) => `<span class="text-blue-400">${m}</span>`);

              return (
                <div
                  key={i}
                  className="text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />
            <p className="text-xs font-mono text-amber-400">
              human_review_required: true — always present, never collapsed, never optional.
            </p>
          </div>
        </div>
      </section>

      {/* CTA strip */}
      <section className="px-6 py-16 border-t border-border">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-mono font-bold text-foreground mb-3">
            Ready to build your AI workforce?
          </h2>
          <p className="text-sm font-mono text-muted-foreground mb-8">
            The legal vertical is live. Sign up and reach your first governed endpoint in under 3 minutes.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link
              href="/sign-up"
              className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono font-bold rounded hover:bg-primary/90 transition-colors"
              data-testid="button-cta-signup"
            >
              Launch your workforce <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/sign-in"
              className="px-6 py-3 border border-border font-mono text-sm text-foreground rounded hover:bg-secondary/50 transition-colors"
              data-testid="button-cta-signin"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-10">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <img src="/logo.svg" alt="OpenClaw" className="w-5 h-5" />
              <span className="font-mono font-bold text-foreground">OpenClaw</span>
            </div>
            <p className="text-[11px] font-mono text-muted-foreground max-w-xs">
              Factory-built AI workforces. Governed outputs. Full audit lineage.
              Not a law firm. Not legal advice.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/sign-in" className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors">
              Sign in
            </Link>
            <Link href="/sign-up" className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors">
              Sign up
            </Link>
            <a
              href="https://github.com/fjkiani/openclaw-saas"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
