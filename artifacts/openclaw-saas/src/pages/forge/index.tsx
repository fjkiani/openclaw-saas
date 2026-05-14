import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListForgeWorkspaces,
  useCreateForgeWorkspace,
  getListForgeWorkspacesQueryKey,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import { FlaskConical, Plus, X } from "lucide-react";

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    case "archived":
      return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
    default:
      return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
  }
}

export default function ForgePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");

  const { data: workspaces, isLoading } = useListForgeWorkspaces();

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

  return (
    <Layout>
      <PageHeader
        title="Model Forge"
        subtitle="Fine-tune and deploy domain-specific models"
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
            <h3 className="text-sm font-mono font-bold text-foreground mb-1">No workspaces yet</h3>
            <p className="text-xs font-mono text-muted-foreground max-w-xs mb-4">
              No workspaces yet. Create your first model workspace.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-3 py-1.5 rounded flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              New Workspace
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                onClick={() => navigate(`/forge/${ws.id}/datasets`)}
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
