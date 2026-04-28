import { useGetDashboardSummary, useListTenants, useGetTenantActivity, getGetTenantActivityQueryKey } from "@workspace/api-client-react";
import { Layout, PageHeader, StatusBadge, ActivityIcon } from "@/components/Layout";
import { Link } from "wouter";
import { Bot, Zap, CheckCircle, CreditCard, ArrowRight, Clock } from "lucide-react";

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4" data-testid={`card-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">{label}</span>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="text-2xl font-mono font-bold text-foreground">{value}</div>
      {sub && <div className="text-[10px] font-mono text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: tenants, isLoading: tenantsLoading } = useListTenants();

  const firstTenant = tenants?.[0];
  const { data: activity } = useGetTenantActivity(firstTenant?.id ?? 0, {
    query: { enabled: !!firstTenant?.id, queryKey: getGetTenantActivityQueryKey(firstTenant?.id ?? 0) },
  });

  return (
    <Layout>
      <PageHeader
        title="Control Plane"
        subtitle="Your OpenClaw agent fleet overview"
      />

      <div className="p-6 space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Agents"
            value={summaryLoading ? "—" : summary?.totalAgents ?? 0}
            sub={`${summary?.agentLimit ?? 1} agent limit`}
            icon={Bot}
          />
          <StatCard
            label="Running"
            value={summaryLoading ? "—" : summary?.runningAgents ?? 0}
            sub="active instances"
            icon={CheckCircle}
          />
          <StatCard
            label="Skills Installed"
            value={summaryLoading ? "—" : summary?.totalSkillsInstalled ?? 0}
            sub="across all agents"
            icon={Zap}
          />
          <StatCard
            label="Current Plan"
            value={summaryLoading ? "—" : (summary?.planName ?? "free").toUpperCase()}
            sub="upgrade available"
            icon={CreditCard}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Agents list */}
          <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-mono font-bold text-foreground">AGENT INSTANCES</span>
              <Link
                href="/agents"
                className="text-[10px] font-mono text-primary hover:underline flex items-center gap-1"
                data-testid="link-all-agents"
              >
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            {tenantsLoading ? (
              <div className="p-6 text-center text-xs font-mono text-muted-foreground">Loading...</div>
            ) : !tenants?.length ? (
              <div className="p-8 text-center">
                <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-xs font-mono text-muted-foreground">No agents yet</p>
                <Link
                  href="/agents"
                  className="text-xs font-mono text-primary hover:underline mt-1 block"
                  data-testid="link-provision-first"
                >
                  Provision your first agent
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {tenants.slice(0, 5).map((t) => (
                  <Link
                    key={t.id}
                    href={`/agents/${t.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors"
                    data-testid={`card-agent-${t.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Bot className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-mono font-bold text-foreground">{t.name}</p>
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {Math.round((t.memoryUsedKb ?? 0) / 1024)} MB · {t.agentCount} agent
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={t.status} />
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Activity log */}
          <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-mono font-bold text-foreground">RECENT ACTIVITY</span>
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            {!firstTenant ? (
              <div className="p-8 text-center">
                <p className="text-xs font-mono text-muted-foreground">No activity yet</p>
              </div>
            ) : !activity?.length ? (
              <div className="p-8 text-center">
                <p className="text-xs font-mono text-muted-foreground">No recent activity</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {activity.slice(0, 8).map((entry) => (
                  <div key={entry.id} className="flex items-start gap-3 px-4 py-3" data-testid={`activity-${entry.id}`}>
                    <ActivityIcon type={entry.type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-mono text-foreground truncate">{entry.message}</p>
                      <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Quick links */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Link
            href="/agents"
            className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            data-testid="link-quick-agents"
          >
            <div className="flex items-center gap-3">
              <Bot className="w-4 h-4 text-primary" />
              <div>
                <p className="text-xs font-mono font-bold text-foreground">Manage Agents</p>
                <p className="text-[10px] font-mono text-muted-foreground">Provision, start, stop</p>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
          </Link>
          <Link
            href="/skills"
            className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            data-testid="link-quick-skills"
          >
            <div className="flex items-center gap-3">
              <Zap className="w-4 h-4 text-primary" />
              <div>
                <p className="text-xs font-mono font-bold text-foreground">Browse Skills</p>
                <p className="text-[10px] font-mono text-muted-foreground">5,400+ on ClawHub</p>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
          </Link>
          <Link
            href="/billing"
            className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            data-testid="link-quick-billing"
          >
            <div className="flex items-center gap-3">
              <CreditCard className="w-4 h-4 text-primary" />
              <div>
                <p className="text-xs font-mono font-bold text-foreground">Billing & Plan</p>
                <p className="text-[10px] font-mono text-muted-foreground">Usage & limits</p>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
          </Link>
        </div>
      </div>
    </Layout>
  );
}
