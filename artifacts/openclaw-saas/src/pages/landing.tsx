import { Link } from "wouter";
import { Bot, Zap, Shield, ArrowRight, Check, Terminal, GitBranch, Globe } from "lucide-react";

const features = [
  {
    icon: Bot,
    title: "Isolated Agent Instances",
    description:
      "Each tenant gets a fully isolated Gateway container with its own memory, sessions, and file system.",
  },
  {
    icon: Zap,
    title: "5,400+ Skills from ClawHub",
    description:
      "Install domain-specific skill packs on signup. Biotech, finance, devops — curated packs for every vertical.",
  },
  {
    icon: Shield,
    title: "Zero Cross-Contamination",
    description:
      "OPENCLAW_CONFIG_DIR isolation per tenant. Docker volumes, separate gateway tokens, separate memory.",
  },
  {
    icon: Terminal,
    title: "WebSocket-First Interface",
    description:
      "Direct WebSocket proxy to your agent Gateway. Real-time agent responses, no polling.",
  },
  {
    icon: GitBranch,
    title: "Multi-Agent Orchestration",
    description:
      "Pro and Enterprise tiers unlock multi-agent dashboards via openclaw-mission-control.",
  },
  {
    icon: Globe,
    title: "S3-Backed Memory",
    description:
      "Plain Markdown workspace. Automatic S3 backups. Your agent memory is yours.",
  },
];

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    description: "For individuals exploring AI agents",
    agentLimit: "1 agent",
    features: [
      "1 isolated agent instance",
      "5,400+ ClawHub skills",
      "File-based memory",
      "WebSocket access",
      "Community support",
    ],
    cta: "Start free",
    href: "/sign-up",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$29",
    period: "/month",
    description: "For teams running multiple agents",
    agentLimit: "5 agents",
    features: [
      "5 isolated agent instances",
      "Everything in Free",
      "S3 memory backups",
      "Multi-agent dashboard",
      "Priority support",
      "Custom skill packs",
    ],
    cta: "Start Pro trial",
    href: "/sign-up",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For organizations at scale",
    agentLimit: "Unlimited agents",
    features: [
      "Unlimited agent instances",
      "Everything in Pro",
      "SSO / SAML",
      "Dedicated infrastructure",
      "SLA guarantee",
      "On-prem deployment option",
    ],
    cta: "Contact us",
    href: "/sign-up",
    highlighted: false,
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="border-b border-border/50 px-6 py-4 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="OpenClaw" className="w-7 h-7" />
          <span className="font-mono font-bold tracking-tight text-foreground">OpenClaw</span>
        </div>
        <div className="flex items-center gap-3">
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
            Get started <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 py-24 text-center max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/5 text-primary text-xs font-mono mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          OpenClaw Gateway SaaS — Now in Beta
        </div>
        <h1 className="text-5xl font-mono font-bold tracking-tight text-foreground mb-6 leading-tight">
          Deploy AI agents<br />
          <span className="text-primary">at scale</span>
        </h1>
        <p className="text-lg font-mono text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed">
          The OpenClaw SaaS control plane. Provision isolated agent instances, install skill packs from ClawHub, and monitor your fleet — all from one dashboard.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link
            href="/sign-up"
            className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono font-bold rounded hover:bg-primary/90 transition-colors"
            data-testid="button-hero-signup"
          >
            Start for free <ArrowRight className="w-4 h-4" />
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

      {/* Architecture callout */}
      <section className="px-6 py-12 max-w-5xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-6 font-mono text-xs text-muted-foreground leading-6">
          <p className="text-primary mb-2"># Architecture</p>
          <p>{"┌─────────────────────────────────────────┐"}</p>
          <p>{"│    YOUR SAAS CONTROL PLANE (this app)   │"}</p>
          <p>{"│   Auth + Billing + Agent Dashboard      │"}</p>
          <p>{"└────────────────┬────────────────────────┘"}</p>
          <p>{"                 │ REST / WebSocket proxy"}</p>
          <p>{"┌────────────────▼────────────────────────┐"}</p>
          <p>{"│    TENANT ROUTER / API GATEWAY          │"}</p>
          <p>{"│  tenant_id → Gateway instance mapping   │"}</p>
          <p>{"└────┬──────────────┬──────────────┬──────┘"}</p>
          <p>{"     │              │              │"}</p>
          <p>{"┌────▼───┐    ┌────▼───┐    ┌────▼───┐"}</p>
          <p>{"│Agent A │    │Agent B │    │Agent C │"}</p>
          <p>{"│:18789  │    │:18790  │    │:18791  │"}</p>
          <p>{"└────────┘    └────────┘    └────────┘"}</p>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <h2 className="text-2xl font-mono font-bold text-foreground text-center mb-12">
          Everything you need to run agents in production
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="border border-border rounded-lg p-5 bg-card hover:border-primary/30 transition-colors"
            >
              <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <h3 className="font-mono font-bold text-sm text-foreground mb-1">{title}</h3>
              <p className="text-xs font-mono text-muted-foreground leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="px-6 py-16 max-w-5xl mx-auto" id="pricing">
        <h2 className="text-2xl font-mono font-bold text-foreground text-center mb-3">
          Simple, transparent pricing
        </h2>
        <p className="text-sm font-mono text-muted-foreground text-center mb-12">
          Start free. Scale when you're ready.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`rounded-lg border p-6 flex flex-col ${
                tier.highlighted
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card"
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
              <p className="text-xs font-mono text-muted-foreground mb-1">{tier.agentLimit}</p>
              <p className="text-xs font-mono text-muted-foreground mb-5">{tier.description}</p>
              <ul className="space-y-2 mb-6 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs font-mono text-foreground">
                    <Check className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href={tier.href}
                className={`w-full text-center py-2 rounded text-sm font-mono font-bold transition-colors ${
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
      <footer className="border-t border-border px-6 py-8 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <img src="/logo.svg" alt="OpenClaw" className="w-5 h-5" />
          <span className="font-mono text-sm text-muted-foreground">OpenClaw SaaS</span>
        </div>
        <p className="text-xs font-mono text-muted-foreground">
          Built on the OpenClaw Gateway runtime. 5,400+ skills from ClawHub.
        </p>
      </footer>
    </div>
  );
}
