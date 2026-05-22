import { useState, useRef } from "react";
import {
  useListKnowledgeGraphs,
  useCreateKnowledgeGraph,
  useDeleteKnowledgeGraph,
  useListGraphDocuments,
  useQueryKnowledgeGraph,
  getListKnowledgeGraphsQueryKey,
  getListGraphDocumentsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Database, Plus, Trash2, Upload, Search, FileText, ChevronDown, ChevronRight } from "lucide-react";

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? import.meta.env.BASE_URL ?? "").replace(/\/+$/, "");

function statusColor(status: string) {
  if (status === "ready") return "text-emerald-400 border-emerald-500/20";
  if (status === "error") return "text-red-400 border-red-500/20";
  return "text-amber-400 border-amber-500/20";
}

function GraphPanel({ tenantId, graphId, graphName }: { tenantId: number; graphId: number; graphName: string }) {
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: number; documentId: number; chunkIndex: number; content: string; rank: number }> | null>(null);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: docs = [], isLoading: docsLoading } = useListGraphDocuments(tenantId, graphId, {
    query: { queryKey: getListGraphDocumentsQueryKey(tenantId, graphId) },
  });

  const searchGraph = useQueryKnowledgeGraph();

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${BASE}/api/tenants/${tenantId}/graphs/${graphId}/documents`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!resp.ok) throw new Error(await resp.text());
      queryClient.invalidateQueries({ queryKey: getListGraphDocumentsQueryKey(tenantId, graphId) });
      toast({ title: "Document uploaded", description: "Processing in background — refresh in a moment." });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const result = await searchGraph.mutateAsync({ id: tenantId, graphId, data: { query: query.trim(), limit: 5 } });
      setSearchResults(result.chunks);
    } catch {
      toast({ title: "Search failed", variant: "destructive" });
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="ml-2 mt-2 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
          Documents ({docs.length})
        </span>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt"
            className="hidden"
            onChange={handleUpload}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            <Upload className="w-3 h-3" />
            {uploading ? "Uploading…" : "Upload PDF"}
          </button>
        </div>
      </div>

      {docsLoading ? (
        <div className="text-[10px] font-mono text-muted-foreground">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-center py-4 text-[10px] font-mono text-muted-foreground">
          No documents yet. Upload a PDF to start building this graph.
        </div>
      ) : (
        <div className="space-y-1.5">
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2 p-2 bg-background border border-border rounded">
              <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-mono text-foreground truncate">{doc.filename}</p>
                <p className="text-[9px] font-mono text-muted-foreground">
                  {(doc.sizeBytes / 1024).toFixed(1)} KB · {doc.chunkCount} chunks
                </p>
              </div>
              <span className={`text-[9px] font-mono border px-1.5 py-0.5 rounded flex-shrink-0 ${statusColor(doc.status)}`}>
                {doc.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {docs.some((d) => d.status === "ready") && (
        <div className="mt-3">
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${graphName}…`}
              className="flex-1 bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors disabled:opacity-50"
            >
              <Search className="w-3 h-3" />
              {searching ? "…" : "Search"}
            </button>
          </form>

          {searchResults !== null && (
            <div className="mt-3 space-y-2">
              {searchResults.length === 0 ? (
                <p className="text-[10px] font-mono text-muted-foreground text-center py-2">No results found.</p>
              ) : (
                searchResults.map((chunk) => (
                  <div key={chunk.id} className="p-2.5 bg-background border border-border rounded">
                    <p className="text-[10px] font-mono text-foreground leading-relaxed line-clamp-4">{chunk.content}</p>
                    <p className="text-[9px] font-mono text-muted-foreground mt-1">
                      Chunk {chunk.chunkIndex} · Score {chunk.rank.toFixed(4)}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateGraphModal({ tenantId, onClose }: { tenantId: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [graphType, setGraphType] = useState("document");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const create = useCreateKnowledgeGraph({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListKnowledgeGraphsQueryKey(tenantId) });
        toast({ title: "Graph created" });
        onClose();
      },
      onError: () => toast({ title: "Error", description: "Could not create graph", variant: "destructive" }),
    },
  });

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-5 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono font-bold text-foreground">New Knowledge Graph</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs font-mono">Close</button>
        </div>
        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground mb-1">Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Investor Profiles, Data Room"
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What documents belong in this graph?"
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted-foreground mb-1">Type</label>
            <select
              value={graphType}
              onChange={(e) => setGraphType(e.target.value)}
              className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="document">Document Store</option>
              <option value="investor_profiles">Investor Profiles</option>
              <option value="data_room">Data Room</option>
              <option value="compliance">Compliance Rules</option>
              <option value="brand">Brand Guidelines</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
          <button
            onClick={() => create.mutate({ id: tenantId, data: { name, description: description || null, graphType } })}
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            {create.isPending ? "Creating…" : "Create Graph"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function KnowledgeTab({ tenantId }: { tenantId: number }) {
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: graphs = [], isLoading } = useListKnowledgeGraphs(tenantId, {
    query: { queryKey: getListKnowledgeGraphsQueryKey(tenantId) },
  });

  const deleteGraph = useDeleteKnowledgeGraph({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListKnowledgeGraphsQueryKey(tenantId) });
        toast({ title: "Graph deleted" });
      },
    },
  });

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-mono font-bold text-foreground">
              Knowledge Graphs ({graphs.length})
            </span>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[10px] font-mono hover:bg-primary/20 transition-colors"
          >
            <Plus className="w-3 h-3" />
            New Graph
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-center text-[10px] font-mono text-muted-foreground">Loading…</div>
        ) : graphs.length === 0 ? (
          <div className="p-10 text-center">
            <Database className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-xs font-mono text-muted-foreground">No knowledge graphs yet</p>
            <button onClick={() => setShowCreate(true)} className="text-xs font-mono text-primary hover:underline mt-1">
              Create a Data Room or Investor Profile graph
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {graphs.map((graph) => (
              <div key={graph.id}>
                <div
                  className="flex items-center px-4 py-3 hover:bg-secondary/20 transition-colors cursor-pointer"
                  onClick={() => setExpanded(expanded === graph.id ? null : graph.id)}
                >
                  <div className="mr-2 text-muted-foreground">
                    {expanded === graph.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </div>
                  <div className="w-7 h-7 rounded bg-primary/10 border border-primary/20 flex items-center justify-center mr-3">
                    <Database className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-mono font-bold text-foreground">{graph.name}</p>
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {graph.graphType} · {graph.documentCount} document{graph.documentCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteGraph.mutate({ id: tenantId, graphId: graph.id }); }}
                    className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {expanded === graph.id && (
                  <div className="px-4 pb-4">
                    <GraphPanel tenantId={tenantId} graphId={graph.id} graphName={graph.name} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateGraphModal tenantId={tenantId} onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
