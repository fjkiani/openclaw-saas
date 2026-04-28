import { useState } from "react";
import { Link } from "wouter";
import {
  useListTenants,
  useCreateTenant,
  useStartTenant,
  useStopTenant,
  useDeleteTenant,
  getListTenantsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout, PageHeader, StatusBadge, EmptyState } from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import { Bot, Plus, Play, Square, Trash2, ArrowRight, MemoryStick, Cpu } from "lucide-react";

function ProvisionModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skillPack, setSkillPack] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createTenant = useCreateTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
        toast({ title: "Agent provisioned", description: `"${name}" is initializing` });
        onClose();
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to provision agent", variant: "destructive" });
      },
    },
  });

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50" data-testid="modal-provision">
      <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md">
        <h2 className="text-sm font-mono font-bold text-foreground mb-4">
          Provision Agent Instance
        </h2>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
              Name *
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="my-research-agent"
              data-testid="input-agent-name"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              placeholder="What will this agent do?"
              rows={2}
              data-testid="input-agent-description"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
              Skill Pack
            </label>
            <select
              value={skillPack}
              onChange={(e) => setSkillPack(e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-skill-pack"
            >
              <option value="">None (install manually)</option>
              <option value="biotech">BioTech Research Pack</option>
              <option value="devops">DevOps Automation Pack</option>
              <option value="finance">Finance Analysis Pack</option>
              <option value="legal">Legal Research Pack</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2 border border-border rounded text-xs font-mono text-muted-foreground hover:bg-secondary/50 transition-colors"
            data-testid="button-cancel-provision"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              createTenant.mutate({
                data: {
                  name,
                  description: description || null,
                  skillPack: skillPack || null,
                },
              })
            }
            disabled={!name.trim() || createTenant.isPending}
            className="flex-1 py-2 bg-primary text-primary-foreground rounded text-xs font-mono font-bold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="button-submit-provision"
          >
            {createTenant.isPending ? "Provisioning..." : "Provision"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [showProvision, setShowProvision] = useState(false);
  const { data: tenants, isLoading } = useListTenants();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const startTenant = useStartTenant({
    mutation: {
      onSuccess: (tenant) => {
        queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
        toast({ title: "Agent started", description: `"${tenant.name}" is now running` });
      },
    },
  });

  const stopTenant = useStopTenant({
    mutation: {
      onSuccess: (tenant) => {
        queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
        toast({ title: "Agent stopped", description: `"${tenant.name}" is now stopped` });
      },
    },
  });

  const deleteTenant = useDeleteTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
        toast({ title: "Agent deleted" });
      },
    },
  });

  return (
    <Layout>
      <PageHeader
        title="Agents"
        subtitle="Manage your isolated agent instances"
        action={
          <button
            onClick={() => setShowProvision(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-xs font-mono font-bold rounded hover:bg-primary/90 transition-colors"
            data-testid="button-provision"
          >
            <Plus className="w-3.5 h-3.5" />
            Provision Agent
          </button>
        }
      />

      <div className="p-6">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-card border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : !tenants?.length ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Provision your first isolated agent instance to get started. Each agent gets its own memory, skills, and Gateway connection."
            action={
              <button
                onClick={() => setShowProvision(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground text-xs font-mono font-bold rounded hover:bg-primary/90 transition-colors"
                data-testid="button-provision-empty"
              >
                <Plus className="w-3.5 h-3.5" />
                Provision first agent
              </button>
            }
          />
        ) : (
          <div className="space-y-3">
            {tenants.map((tenant) => (
              <div
                key={tenant.id}
                className="bg-card border border-border rounded-lg p-4 hover:border-primary/20 transition-colors"
                data-testid={`card-agent-${tenant.id}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-mono font-bold text-foreground">
                          {tenant.name}
                        </h3>
                        <StatusBadge status={tenant.status} />
                      </div>
                      {tenant.description && (
                        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                          {tenant.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 mt-1">
                        <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                          <MemoryStick className="w-3 h-3" />
                          {Math.round((tenant.memoryUsedKb ?? 0) / 1024)} MB
                        </span>
                        <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                          <Cpu className="w-3 h-3" />
                          {tenant.agentCount} agent
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          Created {new Date(tenant.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {tenant.status === "stopped" && (
                      <button
                        onClick={() => startTenant.mutate({ id: tenant.id })}
                        disabled={startTenant.isPending}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded text-[10px] font-mono hover:bg-emerald-500/20 transition-colors"
                        data-testid={`button-start-${tenant.id}`}
                      >
                        <Play className="w-3 h-3" />
                        Start
                      </button>
                    )}
                    {tenant.status === "running" && (
                      <button
                        onClick={() => stopTenant.mutate({ id: tenant.id })}
                        disabled={stopTenant.isPending}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 rounded text-[10px] font-mono hover:bg-zinc-500/20 transition-colors"
                        data-testid={`button-stop-${tenant.id}`}
                      >
                        <Square className="w-3 h-3" />
                        Stop
                      </button>
                    )}
                    <Link
                      href={`/agents/${tenant.id}`}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-border rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                      data-testid={`link-detail-${tenant.id}`}
                    >
                      Detail <ArrowRight className="w-3 h-3" />
                    </Link>
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${tenant.name}"?`)) {
                          deleteTenant.mutate({ id: tenant.id });
                        }
                      }}
                      className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      data-testid={`button-delete-${tenant.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showProvision && <ProvisionModal onClose={() => setShowProvision(false)} />}
    </Layout>
  );
}
