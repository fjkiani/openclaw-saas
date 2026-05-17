import { useGetDashboardSummary, useListTenants, useGetTenantActivity, getGetTenantActivityQueryKey, useListForgeWorkspaces, useListTrainingJobs } from "@workspace/api-client-react";
import { Layout, PageHeader, StatusBadge, ActivityIcon } from "@/components/Layout";
import { Link } from "wouter";
import { Bot, Zap, CheckCircle, CreditCard, ArrowRight, Clock, FlaskConical, Server } from "lucide-react";

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

function FactoryStatusStrip() {
  const { data: workspaces } = useListForgeWorkspaces();

  const workspaceCount = workspaces?.length ?? 0;
  const activeDeployments = workspaces?.filter((w) => w.status === "active").length ?? 0;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <FlaskConical className="w-3.5 h-3.5 text-primary" />
        <span className="text-[10px] font-mono font-bold text-foreground uppercase tracking-widest">Factory Status</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Link
          href="/forge"
          className="flex flex-col gap-0.5 p-3 bg-background border border-border rounded hover:border-primary/30 transition-colors"
          data-testid="factory-stat-workspaces"
        >
          <span className="text-lg font-mono font-bold text-foreground">{workspaceCount}</span>
          <span className="text-[10px] font-mono text-muted-foreground">Forge Workspaces</span>
        </Link>
        <Link
          href="/forge"
          className="flex flex-col gap-0.5 p-3 bg-background border border-border rounded hover:border-primary/30 transition-colors"
          data-testid="factory-stat-deployments"
        >
          <span className="text-lg font-mono font-bold text-foreground">{activeDeployments}</span>
          <span className="text-[10px] font-mono text-muted-foreground">Active Workspaces</span>
        </Link>
        <Link
          href="/forge"
          className="flex flex-col gap-0.5 p-3 bg-background border border-border rounded hover:border-primary/30 transition-colors"
          data-testid="factory-stat-endpoints"
        >
          <span className="text-lg font-mono font-bold text-foreground">8</span>
          <span className="text-[10px] font-mono text-muted-foreground">Live Endpoints</span>
        </Link>
        <Link
          href="/forge"
          className="flex flex-col gap-0.5 p-3 bg-background border border-border rounded hover:border-primary/30 transition-colors"
          data-testid="factory-stat-governed"
        >
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[10px] font-mono font-bold text-emerald-400">ON</span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">Governance Layer</span>
        </Link>
      </div>
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
        title="Your AI Workforce"
        subtitle="Factory-built. Governed. Ready."
      />

      <div className="p-6 space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Workforce Members"
            value={summaryLoading ? "—" : summary?.totalAgents ?? 0}
            sub={`${summary?.agentLimit ?? 1} member limit`}
            icon={Bot}
          />
          <StatCard
            label="Active Now"
            value={summaryLoading ? "—" : summary?.runningAgents ?? 0}
            sub="running instances"
            icon={CheckCircle}
          />
          <StatCard
            label="Skills Deployed"
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

        {/* Factory Status strip */}
        <FactoryStatusStrip />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Workforce list */}
          <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-mono font-bold text-foreground">YOUR WORKFORCE</span>
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
                <p className="text-xs font-mono text-muted-foreground mb-2">No workforce yet</p>
                <Link
                  href="/onboarding"
                  className="text-xs font-mono text-primary hover:underline"
                  data-testid="link-launch-vertical"
                >
                  Launch your first vertical →
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
                <p className="text-xs font-mono font-bold text-foreground">Manage Workforce</p>
                <p className="text-[10px] font-mono text-muted-foreground">Provision, start, stop</p>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
          </Link>
          <Link
            href="/forge"
            className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            data-testid="link-quick-forge"
          >
            <div className="flex items-center gap-3">
              <FlaskConical className="w-4 h-4 text-primary" />
              <div>
                <p className="text-xs font-mono font-bold text-foreground">Model Forge</p>
                <p className="text-[10px] font-mono text-muted-foreground">Build · Train · Deploy</p>
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
