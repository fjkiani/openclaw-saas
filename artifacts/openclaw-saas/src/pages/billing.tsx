import { useGetBillingPlan, useGetBillingUsage } from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Link } from "wouter";
import { Check, CreditCard, ArrowRight, TrendingUp } from "lucide-react";

export default function BillingPage() {
  const { data: plan, isLoading: planLoading } = useGetBillingPlan();
  const { data: usage, isLoading: usageLoading } = useGetBillingUsage();

  const agentUsagePct = usage
    ? Math.min((usage.agentsUsed / usage.agentLimit) * 100, 100)
    : 0;

  const upgradeTiers = [
    {
      name: "Pro",
      price: "$29",
      period: "/month",
      agentLimit: 5,
      features: [
        "5 isolated agent instances",
        "S3 memory backups",
        "Multi-agent dashboard",
        "Priority support",
        "Custom skill packs",
      ],
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      agentLimit: 999,
      features: [
        "Unlimited agent instances",
        "SSO / SAML",
        "Dedicated infrastructure",
        "SLA guarantee",
        "On-prem deployment option",
      ],
    },
  ];

  return (
    <Layout>
      <PageHeader
        title="Billing & Plan"
        subtitle="Manage your subscription and usage"
      />

      <div className="p-6 space-y-6">
        {/* Current plan */}
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest mb-1">
                Current Plan
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-mono font-bold text-foreground">
                  {planLoading ? "—" : (plan?.name ?? "free").toUpperCase()}
                </span>
                <span className="text-[10px] font-mono bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded">
                  ACTIVE
                </span>
              </div>
            </div>
            <CreditCard className="w-5 h-5 text-muted-foreground" />
          </div>

          {plan && (
            <ul className="space-y-1.5 mb-4">
              {plan.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs font-mono text-foreground">
                  <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs font-mono text-muted-foreground">
            {plan?.priceMonthly === 0 ? "Free forever" : `$${plan?.priceMonthly}/month`}
          </p>
        </div>

        {/* Usage */}
        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest mb-4">
            Current Usage
          </h2>
          {usageLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-4 bg-secondary rounded" />
              <div className="h-4 bg-secondary rounded w-2/3" />
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    Agent Instances
                  </span>
                  <span className="text-[10px] font-mono text-foreground">
                    {usage?.agentsUsed} / {usage?.agentLimit}
                  </span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${agentUsagePct >= 90 ? "bg-red-500" : agentUsagePct >= 70 ? "bg-amber-500" : "bg-primary"}`}
                    style={{ width: `${agentUsagePct}%` }}
                    data-testid="usage-bar-agents"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-background border border-border rounded p-3">
                  <p className="text-[10px] font-mono text-muted-foreground mb-1">Skills Installed</p>
                  <p className="text-lg font-mono font-bold text-foreground" data-testid="text-skills-installed">
                    {usage?.skillsInstalled ?? 0}
                  </p>
                </div>
                <div className="bg-background border border-border rounded p-3">
                  <p className="text-[10px] font-mono text-muted-foreground mb-1">Tasks This Month</p>
                  <p className="text-lg font-mono font-bold text-foreground" data-testid="text-tasks-month">
                    {usage?.tasksThisMonth ?? 0}
                  </p>
                </div>
                <div className="bg-background border border-border rounded p-3">
                  <p className="text-[10px] font-mono text-muted-foreground mb-1">Billing Period</p>
                  <p className="text-xs font-mono text-foreground">
                    {usage
                      ? `${new Date(usage.periodStart).toLocaleDateString()} – ${new Date(usage.periodEnd).toLocaleDateString()}`
                      : "—"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Upgrade */}
        {plan?.name === "free" && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-xs font-mono font-bold text-foreground">Upgrade Your Plan</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {upgradeTiers.map((tier) => (
                <div key={tier.name} className="bg-card border border-border rounded-lg p-5 hover:border-primary/30 transition-colors">
                  <div className="flex items-baseline justify-between mb-1">
                    <h3 className="font-mono font-bold text-foreground">{tier.name}</h3>
                    <div>
                      <span className="text-2xl font-mono font-bold text-foreground">{tier.price}</span>
                      <span className="text-xs font-mono text-muted-foreground">{tier.period}</span>
                    </div>
                  </div>
                  <p className="text-[10px] font-mono text-primary mb-4">
                    {tier.agentLimit === 999 ? "Unlimited" : tier.agentLimit} agent instances
                  </p>
                  <ul className="space-y-1.5 mb-4">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                        <Check className="w-3 h-3 text-primary shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/sign-up"
                    className="flex items-center justify-center gap-1.5 w-full py-2 bg-primary text-primary-foreground rounded text-xs font-mono font-bold hover:bg-primary/90 transition-colors"
                    data-testid={`button-upgrade-${tier.name.toLowerCase()}`}
                  >
                    Upgrade to {tier.name}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
