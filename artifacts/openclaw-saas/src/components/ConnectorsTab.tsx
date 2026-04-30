import { useState } from "react";
import {
  useListConnectorRegistry,
  useListTenantConnectors,
  useInstallConnectorOnTenant,
  useRemoveConnectorFromTenant,
  getListTenantConnectorsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Check, AlertCircle, Key, Plug } from "lucide-react";

function InstallConnectorModal({
  tenantId,
  onClose,
}: {
  tenantId: number;
  onClose: () => void;
}) {
  const [selectedConnectorId, setSelectedConnectorId] = useState<number | null>(null);
  const [credential, setCredential] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: registry } = useListConnectorRegistry();
  const { data: installed } = useListTenantConnectors(tenantId);

  const install = useInstallConnectorOnTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantConnectorsQueryKey(tenantId) });
        toast({ title: "Connector installed" });
        onClose();
      },
      onError: () => {
        toast({ title: "Error", description: "Could not install connector", variant: "destructive" });
      },
    },
  });

  const installedConnectorIds = new Set(installed?.map((c) => c.connectorId) ?? []);
  const selected = registry?.find((c) => c.id === selectedConnectorId);

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-5 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono font-bold text-foreground">Install Connector</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs font-mono">
            Close
          </button>
        </div>

        <div className="space-y-3 mb-4">
          {registry?.map((connector) => (
            <button
              key={connector.id}
              onClick={() => setSelectedConnectorId(connector.id)}
              disabled={installedConnectorIds.has(connector.id)}
              className={`w-full text-left p-3 rounded border transition-colors ${
                installedConnectorIds.has(connector.id)
                  ? "border-border opacity-40 cursor-not-allowed"
                  : selectedConnectorId === connector.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-mono font-bold text-foreground">{connector.name}</p>
                  <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{connector.description}</p>
                </div>
                {installedConnectorIds.has(connector.id) && (
                  <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                )}
              </div>
            </button>
          ))}
        </div>

        {selected && (
          <div className="mb-4">
            <label className="block text-[10px] font-mono text-muted-foreground mb-1.5">
              {selected.credentialLabel}
            </label>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={`Paste your ${selected.name} ${selected.credentialLabel}`}
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="text-[10px] font-mono text-muted-foreground mt-1">
              Stored encrypted (AES-256-GCM). Never exposed in responses.
            </p>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (!selectedConnectorId || !credential.trim()) return;
              install.mutate({ id: tenantId, data: { connectorId: selectedConnectorId, credential: credential.trim() } });
            }}
            disabled={!selectedConnectorId || !credential.trim() || install.isPending}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ConnectorsTab({ tenantId }: { tenantId: number }) {
  const [showInstall, setShowInstall] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: installed = [], isLoading } = useListTenantConnectors(tenantId, {
    query: { queryKey: getListTenantConnectorsQueryKey(tenantId) },
  });

  const remove = useRemoveConnectorFromTenant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTenantConnectorsQueryKey(tenantId) });
        toast({ title: "Connector removed" });
      },
    },
  });

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Plug className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-mono font-bold text-foreground">
              Installed Connectors ({installed.length})
            </span>
          </div>
          <button
            onClick={() => setShowInstall(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Connector
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-center text-[10px] font-mono text-muted-foreground">Loading…</div>
        ) : installed.length === 0 ? (
          <div className="p-10 text-center">
            <Key className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-xs font-mono text-muted-foreground">No connectors installed</p>
            <button
              onClick={() => setShowInstall(true)}
              className="text-xs font-mono text-primary hover:underline mt-1"
            >
              Add Crunchbase to enable IR research
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {installed.map((conn) => (
              <div key={conn.id} className="flex items-center justify-between px-4 py-3 hover:bg-secondary/20 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-xs font-mono font-bold text-foreground">{conn.connectorName}</p>
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {conn.connectorSlug} · Connected {new Date(conn.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {conn.verified ? (
                    <span className="text-[10px] font-mono text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded">Verified</span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-amber-400">
                      <AlertCircle className="w-3 h-3" /> Unverified
                    </span>
                  )}
                  <button
                    onClick={() => remove.mutate({ id: tenantId, connectorId: conn.id })}
                    className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Phase Availability</h3>
        <div className="space-y-1.5">
          {[
            { name: "Crunchbase", phase: "Phase 1", status: "available", desc: "Investor and org search" },
            { name: "Gmail", phase: "Phase 2", status: "pending", desc: "Outreach send (deferred)" },
            { name: "LinkedIn", phase: "Phase 3", status: "pending", desc: "Enrichment (partner approval pending)" },
          ].map((c) => (
            <div key={c.name} className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-mono text-foreground">{c.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground ml-2">{c.desc}</span>
              </div>
              <span className={`text-[10px] font-mono border px-1.5 py-0.5 rounded ${
                c.status === "available"
                  ? "text-emerald-400 border-emerald-500/20"
                  : "text-muted-foreground border-border"
              }`}>
                {c.phase}
              </span>
            </div>
          ))}
        </div>
      </div>

      {showInstall && (
        <InstallConnectorModal tenantId={tenantId} onClose={() => setShowInstall(false)} />
      )}
    </div>
  );
}
