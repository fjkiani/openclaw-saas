import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/apiFetch";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListForgeWorkspaces,
  useCreateForgeWorkspace,
  getListForgeWorkspacesQueryKey,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/Layout";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import {
  FlaskConical,
  Plus,
  X,
  Loader2,
  Database,
  Cpu,
  CheckCircle2,
  Server,
  Shield,
  ArrowRight,
  ChevronRight,
} from "lucide-react";

// ─── Pipeline visualization ───────────────────────────────────────────────────

const PIPELINE_NODES = [
  { icon: Database, label: "Dataset",    color: "text-blue-400",    border: "border-blue-500/20",    bg: "bg-blue-500/5" },
  { icon: Cpu,      label: "Training",   color: "text-purple-400",  border: "border-purple-500/20",  bg: "bg-purple-500/5" },
  { icon: CheckCircle2, label: "Eval",   color: "text-amber-400",   border: "border-amber-500/20",   bg: "bg-amber-500/5" },
  { icon: FlaskConical, label: "Registry", color: "text-primary",   border: "border-primary/20",     bg: "bg-primary/5" },
  { icon: Server,   label: "Deployment", color: "text-emerald-400", border: "border-emerald-500/20", bg: "bg-emerald-500/5" },
];

function PipelineViz({ workspaceCount }: { workspaceCount: number }) {
  return (
    <div className="bg-card border border-border rounded-lg p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <FlaskConical className="w-4 h-4 text-primary" />
        <span className="text-xs font-mono font-bold text-foreground">The Model Forge</span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          Dataset → Training → Eval → Registry → Deployment
        </span>
      </div>

      <div className="flex items-center gap-0 overflow-x-auto pb-1">
        {PIPELINE_NODES.map(({ icon: Icon, label, color, border, bg }, i) => (
          <div key={label} className="flex items-center shrink-0">
            <div className={`flex flex-col items-center gap-1.5 px-4 py-3 rounded-lg border ${border} ${bg} min-w-[90px]`}>
              <Icon className={`w-4 h-4 ${color}`} />
              <span className={`text-[10px] font-mono font-bold ${color}`}>{label}</span>
              {i === 0 && workspaceCount > 0 && (
                <span className="text-[9px] font-mono text-muted-foreground">{workspaceCount} ready</span>
              )}
            </div>
            {i < PIPELINE_NODES.length - 1 && (
              <ChevronRight className="w-4 h-4 text-muted-foreground mx-1 shrink-0" />
            )}
          </div>
        ))}
      </div>

      <p className="text-[10px] font-mono text-muted-foreground mt-3">
        Where your AI workforce is built. Each workspace runs the full pipeline — from raw data to governed live endpoint.
      </p>
    </div>
  );
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":   return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    case "archived": return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
    default:         return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ForgePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const provisionedRef = useRef(false);

  const { data: workspaces, isLoading } = useListForgeWorkspaces();

  // On first load: call provision endpoint to ensure tenant + starter workspace exist.
  // If a new workspace was provisioned, redirect directly to its registry tab.
  useEffect(() => {
    if (provisionedRef.current) return;
    provisionedRef.current = true;

    setProvisioning(true);
    apiFetch("/api/onboarding/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const raw = await r.text();
        if (!raw || !raw.trim()) throw new Error("Service is warming up — please try again in a few seconds.");
        try { return JSON.parse(raw); } catch { throw new Error("Invalid response from server. Please retry."); }
      })
      .then((data: { workspace_id: number; provisioned: boolean }) => {
        setProvisioning(false);
        if (data.provisioned) {
          queryClient.invalidateQueries({ queryKey: getListForgeWorkspacesQueryKey() });
          navigate(`/forge/${data.workspace_id}/registry`);
        }
      })
      .catch(() => {
        setProvisioning(false);
      });
  }, [navigate, queryClient]);

  const createWorkspace = useCreateForgeWorkspace({
    mutation: {
      onSuccess: (ws) => {
        queryClient.invalidateQueries({ queryKey: getListForgeWorkspacesQueryKey() });
        toast({ title: "Workspace created" });
        setShowForm(false);
        setName("");
        setDomain("");
        setDescription("");
        navigate(`/forge/${ws.id}/datasets`);
      },
      onError: () => {
        toast({ title: "Error", description: "Could not create workspace", variant: "destructive" });
      },
    },
  });

  const handleCreate = () => {
    if (!name.trim() || !domain.trim()) {
      toast({ title: "Name and domain are required" });
      return;
    }
    createWorkspace.mutate({
      data: { name: name.trim(), domain: domain.trim(), description: description.trim() || undefined },
    });
  };

  if (provisioning) {
    return (
      <Layout>
        <PageHeader
          title="The Model Forge"
          subtitle="Where your AI workforce is built"
        />
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin mb-4" />
          <p className="text-xs font-mono text-muted-foreground">Initializing your workspace...</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title="The Model Forge"
        subtitle="Where your AI workforce is built. Dataset → Training → Eval → Registry → Deployment."
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Workspace
          </button>
        }
      />

      <div className="p-6 space-y-6">
        {/* Pipeline visualization */}
        <PipelineViz workspaceCount={workspaces?.length ?? 0} />

        {/* Inline create form */}
        {showForm && (
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-foreground">New Model Workspace</span>
              <button
                onClick={() => setShowForm(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
                  Name *
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Model Workspace"
                  className="w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
                  Domain *
                </label>
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. legal, medical, finance"
                  className="w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
                Description (optional)
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the purpose of this workspace..."
                rows={2}
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={createWorkspace.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-3 py-1.5 rounded disabled:opacity-50"
              >
                {createWorkspace.isPending ? "Creating..." : "Create Workspace"}
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="font-mono text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Workspace list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-card border border-border rounded-lg animate-pulse" />
            ))}
          </div>
        ) : !workspaces?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
              <FlaskConical className="w-6 h-6 text-primary" />
            </div>
            <h3 className="text-sm font-mono font-bold text-foreground mb-1">
              You haven't built a vertical yet.
            </h3>
            <p className="text-xs font-mono text-muted-foreground max-w-xs mb-4">
              The factory provisions your workspace, skill bundle, data layer, and governance policy.
            </p>
            <Link
              href="/onboarding"
              className="flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-4 py-2 rounded transition-colors"
              data-testid="link-launch-vertical"
            >
              Launch your first vertical <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                onClick={() => navigate(`/forge/${ws.id}/registry`)}
                className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                      <FlaskConical className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs font-mono font-bold text-foreground">{ws.name}</p>
                      <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                        domain: {ws.domain}
                        {ws.description ? ` · ${ws.description}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${statusBadgeClass(ws.status)}`}
                    >
                      {ws.status.toUpperCase()}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {new Date(ws.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
