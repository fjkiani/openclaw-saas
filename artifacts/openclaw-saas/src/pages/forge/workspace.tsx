import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetForgeWorkspace,
  useListForgeDatasets,
  useCreateForgeDataset,
  useGetForgeDataset,
  useRegisterDatasetDocument,
  useDeleteDatasetDocument,
  useSnapshotDatasetVersion,
  useListTrainingJobs,
  useCreateTrainingJob,
  useSubmitTrainingJob,
  useDispatchTrainingJob,
  useCancelTrainingJob,
  useListModelRegistry,
  useListModelDeployments,
  useGetForgePolicy,
  useUpdateForgePolicy,
  getListForgeDatasetsQueryKey,
  getGetForgeDatasetQueryKey,
  getListTrainingJobsQueryKey,
  getGetForgePolicyQueryKey,
} from "@workspace/api-client-react";
import type {
  ForgeDataset,
  DatasetDocument,
  TrainingJob,
  ModelPolicy,
} from "@workspace/api-client-react";
import { Layout, PageHeader } from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Plus, X, Database, Briefcase, BookOpen, Server, Shield } from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${className ?? ""}`}>
      {children}
    </span>
  );
}

function datasetStatusClass(status: string): string {
  switch (status) {
    case "ready":      return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    case "processing": return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
    case "error":      return "bg-red-500/10 text-red-400 border border-red-500/20";
    case "pending":    return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
    default:           return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
  }
}

function jobStatusClass(status: string): string {
  switch (status) {
    case "draft":       return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
    case "validating":  return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
    case "queued":      return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
    case "running":     return "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20";
    case "evaluating":  return "bg-purple-500/10 text-purple-400 border border-purple-500/20";
    case "completed":   return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    case "failed":      return "bg-red-500/10 text-red-400 border border-red-500/20";
    case "deployed":    return "bg-emerald-600/10 text-emerald-300 border border-emerald-600/20";
    default:            return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";
  }
}

const inputCls = "w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground";
const selectCls = "w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary";
const textareaCls = "w-full bg-background border border-border rounded px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none placeholder:text-muted-foreground";
const btnPrimary = "bg-primary text-primary-foreground hover:bg-primary/90 font-mono text-xs px-3 py-1.5 rounded disabled:opacity-50";
const btnSecondary = "font-mono text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50";

// ─── Datasets Tab ─────────────────────────────────────────────────────────────

function DatasetDocumentRow({
  wid,
  did,
  doc,
}: {
  wid: number;
  did: number;
  doc: DatasetDocument;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deleteDoc = useDeleteDatasetDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForgeDatasetQueryKey(wid, did) });
        toast({ title: "Document deleted" });
      },
      onError: () => toast({ title: "Error", description: "Could not delete document", variant: "destructive" }),
    },
  });

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 last:border-0 hover:bg-secondary/20">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-mono text-foreground truncate">{doc.filename}</span>
        <Badge className="bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 shrink-0">unverified</Badge>
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-2">
        <span className="text-[10px] font-mono text-muted-foreground">{doc.mime_type ?? "—"}</span>
        <span className="text-[10px] font-mono text-muted-foreground">{doc.size_bytes.toLocaleString()} B</span>
        <button
          onClick={() => deleteDoc.mutate({ wid, did, docId: doc.id })}
          disabled={deleteDoc.isPending}
          className="text-muted-foreground hover:text-red-400 transition-colors"
          title="Delete document"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function DatasetCard({ wid, dataset }: { wid: number; dataset: ForgeDataset }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [docFilename, setDocFilename] = useState("");
  const [docSizeBytes, setDocSizeBytes] = useState("");
  const [docMimeType, setDocMimeType] = useState("");
  const [docSourceUrl, setDocSourceUrl] = useState("");

  const { data: datasetDetail, isLoading: detailLoading } = useGetForgeDataset(wid, dataset.id, {
    query: { enabled: expanded },
  });

  const registerDoc = useRegisterDatasetDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForgeDatasetQueryKey(wid, dataset.id) });
        queryClient.invalidateQueries({ queryKey: getListForgeDatasetsQueryKey(wid) });
        toast({ title: "Document registered" });
        setShowAddDoc(false);
        setDocFilename("");
        setDocSizeBytes("");
        setDocMimeType("");
        setDocSourceUrl("");
      },
      onError: () => toast({ title: "Error", description: "Could not register document", variant: "destructive" }),
    },
  });

  const snapshotVersion = useSnapshotDatasetVersion({
    mutation: {
      onSuccess: (v) => {
        queryClient.invalidateQueries({ queryKey: getListForgeDatasetsQueryKey(wid) });
        toast({ title: `Snapshot created — version ${v.version}`, description: `Version ID: ${v.id}` });
      },
      onError: () => toast({ title: "Error", description: "Could not snapshot version", variant: "destructive" }),
    },
  });

  const handleAddDoc = () => {
    if (!docFilename.trim()) {
      toast({ title: "Filename is required" });
      return;
    }
    registerDoc.mutate({
      wid,
      did: dataset.id,
      data: {
        filename: docFilename.trim(),
        size_bytes: docSizeBytes ? Number(docSizeBytes) : undefined,
        mime_type: docMimeType.trim() || undefined,
        source_url: docSourceUrl.trim() || undefined,
      },
    });
  };

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-secondary/20"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <div>
            <p className="text-xs font-mono font-bold text-foreground">{dataset.name}</p>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
              {dataset.source_type} · {dataset.document_count} docs
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Badge className={datasetStatusClass(dataset.status)}>{dataset.status.toUpperCase()}</Badge>
          <button
            onClick={() => snapshotVersion.mutate({ wid, did: dataset.id })}
            disabled={snapshotVersion.isPending}
            className={btnSecondary}
            title="Snapshot Version"
          >
            {snapshotVersion.isPending ? "Snapshotting..." : "Snapshot Version"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          {detailLoading ? (
            <div className="p-4 text-xs font-mono text-muted-foreground">Loading documents...</div>
          ) : (
            <>
              {datasetDetail?.documents && datasetDetail.documents.length > 0 ? (
                <div>
                  {datasetDetail.documents.map((doc) => (
                    <DatasetDocumentRow key={doc.id} wid={wid} did={dataset.id} doc={doc} />
                  ))}
                </div>
              ) : (
                <div className="p-4 text-xs font-mono text-muted-foreground">No documents yet.</div>
              )}

              <div className="p-3 border-t border-border/50">
                {showAddDoc ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-mono text-muted-foreground block mb-1">Filename *</label>
                        <input value={docFilename} onChange={(e) => setDocFilename(e.target.value)} placeholder="document.pdf" className={inputCls} />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-muted-foreground block mb-1">Size (bytes)</label>
                        <input type="number" value={docSizeBytes} onChange={(e) => setDocSizeBytes(e.target.value)} placeholder="0" className={inputCls} />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-muted-foreground block mb-1">MIME Type</label>
                        <input value={docMimeType} onChange={(e) => setDocMimeType(e.target.value)} placeholder="application/pdf" className={inputCls} />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-muted-foreground block mb-1">Source URL</label>
                        <input value={docSourceUrl} onChange={(e) => setDocSourceUrl(e.target.value)} placeholder="https://..." className={inputCls} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleAddDoc} disabled={registerDoc.isPending} className={btnPrimary}>
                        {registerDoc.isPending ? "Adding..." : "Add Document"}
                      </button>
                      <button onClick={() => setShowAddDoc(false)} className={btnSecondary}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAddDoc(true)}
                    className="flex items-center gap-1.5 text-xs font-mono text-primary hover:text-primary/80"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Document
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DatasetsTab({ wid }: { wid: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [dsName, setDsName] = useState("");
  const [dsSourceType, setDsSourceType] = useState<"upload" | "url" | "connector">("upload");
  const [dsSensitivity, setDsSensitivity] = useState<"public" | "internal" | "confidential" | "restricted">("internal");
  const [dsDescription, setDsDescription] = useState("");

  const { data: datasets, isLoading } = useListForgeDatasets(wid);

  const createDataset = useCreateForgeDataset({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListForgeDatasetsQueryKey(wid) });
        toast({ title: "Dataset created" });
        setShowForm(false);
        setDsName("");
        setDsSourceType("upload");
        setDsSensitivity("internal");
        setDsDescription("");
      },
      onError: () => toast({ title: "Error", description: "Could not create dataset", variant: "destructive" }),
    },
  });

  const handleCreate = () => {
    if (!dsName.trim()) {
      toast({ title: "Name is required" });
      return;
    }
    createDataset.mutate({
      wid,
      data: {
        name: dsName.trim(),
        source_type: dsSourceType,
        sensitivity: dsSensitivity,
        description: dsDescription.trim() || undefined,
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-bold text-foreground">Datasets</span>
        <button onClick={() => setShowForm((v) => !v)} className={btnPrimary + " flex items-center gap-1.5"}>
          <Plus className="w-3.5 h-3.5" />
          New Dataset
        </button>
      </div>

      {showForm && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-foreground">New Dataset</span>
            <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Name *</label>
              <input value={dsName} onChange={(e) => setDsName(e.target.value)} placeholder="My Dataset" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Source Type</label>
              <select value={dsSourceType} onChange={(e) => setDsSourceType(e.target.value as "upload" | "url" | "connector")} className={selectCls}>
                <option value="upload">upload</option>
                <option value="url">url</option>
                <option value="connector">connector</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Sensitivity</label>
              <select value={dsSensitivity} onChange={(e) => setDsSensitivity(e.target.value as "public" | "internal" | "confidential" | "restricted")} className={selectCls}>
                <option value="public">public</option>
                <option value="internal">internal</option>
                <option value="confidential">confidential</option>
                <option value="restricted">restricted</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Description</label>
              <input value={dsDescription} onChange={(e) => setDsDescription(e.target.value)} placeholder="Optional description" className={inputCls} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={createDataset.isPending} className={btnPrimary}>
              {createDataset.isPending ? "Creating..." : "Create Dataset"}
            </button>
            <button onClick={() => setShowForm(false)} className={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-16 bg-card border border-border rounded-lg animate-pulse" />)}
        </div>
      ) : !datasets?.length ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Database className="w-8 h-8 text-muted-foreground mb-3" />
          <p className="text-xs font-mono text-muted-foreground">No datasets yet. Create your first dataset.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {datasets.map((ds) => (
            <DatasetCard key={ds.id} wid={wid} dataset={ds} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Jobs Tab ─────────────────────────────────────────────────────────────────

function JobCard({ wid, job }: { wid: number; job: TrainingJob }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateJobs = () => queryClient.invalidateQueries({ queryKey: getListTrainingJobsQueryKey(wid) });

  const submitJob = useSubmitTrainingJob({
    mutation: {
      onSuccess: () => { invalidateJobs(); toast({ title: "Job submitted" }); },
      onError: () => toast({ title: "Error", description: "Could not submit job", variant: "destructive" }),
    },
  });

  const dispatchJob = useDispatchTrainingJob({
    mutation: {
      onSuccess: () => { invalidateJobs(); toast({ title: "Job dispatched" }); },
      onError: () => toast({ title: "Error", description: "Could not dispatch job", variant: "destructive" }),
    },
  });

  const cancelJob = useCancelTrainingJob({
    mutation: {
      onSuccess: () => { invalidateJobs(); toast({ title: "Job cancelled" }); },
      onError: () => toast({ title: "Error", description: "Could not cancel job", variant: "destructive" }),
    },
  });

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-xs font-mono font-bold text-foreground truncate">{job.name}</p>
            <Badge className="bg-primary/10 text-primary border border-primary/20 shrink-0">{job.mode}</Badge>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground">
            base: {job.base_model} · dataset: {job.dataset_id} · version: {job.dataset_version_id}
          </p>
          {job.error && (
            <p className="text-[10px] font-mono text-red-400 mt-1">{job.error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge className={jobStatusClass(job.status)}>{job.status.toUpperCase()}</Badge>
          {job.status === "draft" && (
            <button
              onClick={() => submitJob.mutate({ wid, jid: job.id })}
              disabled={submitJob.isPending}
              className={btnPrimary}
            >
              Submit
            </button>
          )}
          {job.status === "queued" && (
            <button
              onClick={() => dispatchJob.mutate({ wid, jid: job.id })}
              disabled={dispatchJob.isPending}
              className={btnPrimary}
            >
              Dispatch
            </button>
          )}
          {(job.status === "queued" || job.status === "running") && (
            <button
              onClick={() => cancelJob.mutate({ wid, jid: job.id })}
              disabled={cancelJob.isPending}
              className={btnSecondary}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function JobsTab({ wid }: { wid: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [jobName, setJobName] = useState("");
  const [jobMode, setJobMode] = useState<"prompt_tuning" | "rag_adaptation" | "fine_tuning">("prompt_tuning");
  const [jobBaseModel, setJobBaseModel] = useState("");
  const [jobDatasetId, setJobDatasetId] = useState("");
  const [jobDatasetVersionId, setJobDatasetVersionId] = useState("");
  const [jobHyperparams, setJobHyperparams] = useState("{}");

  const { data: jobs, isLoading } = useListTrainingJobs(wid);
  const { data: datasets } = useListForgeDatasets(wid);

  const createJob = useCreateTrainingJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTrainingJobsQueryKey(wid) });
        toast({ title: "Training job created" });
        setShowForm(false);
        setJobName("");
        setJobMode("prompt_tuning");
        setJobBaseModel("");
        setJobDatasetId("");
        setJobDatasetVersionId("");
        setJobHyperparams("{}");
      },
      onError: () => toast({ title: "Error", description: "Could not create job", variant: "destructive" }),
    },
  });

  const handleCreate = () => {
    if (!jobName.trim() || !jobBaseModel.trim() || !jobDatasetId || !jobDatasetVersionId) {
      toast({ title: "All fields are required" });
      return;
    }
    let hyperparams: Record<string, unknown> = {};
    try { hyperparams = JSON.parse(jobHyperparams); } catch { /* ignore */ }
    createJob.mutate({
      wid,
      data: {
        name: jobName.trim(),
        mode: jobMode,
        base_model: jobBaseModel.trim(),
        dataset_id: Number(jobDatasetId),
        dataset_version_id: Number(jobDatasetVersionId),
        hyperparams: Object.keys(hyperparams).length > 0 ? hyperparams : undefined,
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-bold text-foreground">Training Jobs</span>
        <button onClick={() => setShowForm((v) => !v)} className={btnPrimary + " flex items-center gap-1.5"}>
          <Plus className="w-3.5 h-3.5" />
          New Job
        </button>
      </div>

      {showForm && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-foreground">New Training Job</span>
            <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Name *</label>
              <input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder="My Training Job" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Mode</label>
              <select value={jobMode} onChange={(e) => setJobMode(e.target.value as "prompt_tuning" | "rag_adaptation" | "fine_tuning")} className={selectCls}>
                <option value="prompt_tuning">prompt_tuning</option>
                <option value="rag_adaptation">rag_adaptation</option>
                <option value="fine_tuning">fine_tuning</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Base Model *</label>
              <input value={jobBaseModel} onChange={(e) => setJobBaseModel(e.target.value)} placeholder="e.g. gpt-4o-mini" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Dataset *</label>
              <select value={jobDatasetId} onChange={(e) => setJobDatasetId(e.target.value)} className={selectCls}>
                <option value="">Select dataset...</option>
                {datasets?.map((ds) => (
                  <option key={ds.id} value={ds.id}>{ds.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Dataset Version ID *</label>
              <input type="number" value={jobDatasetVersionId} onChange={(e) => setJobDatasetVersionId(e.target.value)} placeholder="Version ID from snapshot" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Hyperparams (JSON)</label>
              <textarea value={jobHyperparams} onChange={(e) => setJobHyperparams(e.target.value)} rows={2} className={textareaCls} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={createJob.isPending} className={btnPrimary}>
              {createJob.isPending ? "Creating..." : "Create Job"}
            </button>
            <button onClick={() => setShowForm(false)} className={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-20 bg-card border border-border rounded-lg animate-pulse" />)}
        </div>
      ) : !jobs?.length ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Briefcase className="w-8 h-8 text-muted-foreground mb-3" />
          <p className="text-xs font-mono text-muted-foreground">No training jobs yet. Create your first job.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobCard key={job.id} wid={wid} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Registry Tab ─────────────────────────────────────────────────────────────

function RegistryTab({ wid }: { wid: number }) {
  const { data: registry, isLoading } = useListModelRegistry(wid);

  return (
    <div className="space-y-4">
      <span className="text-xs font-mono font-bold text-foreground">Model Registry</span>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-16 bg-card border border-border rounded-lg animate-pulse" />)}
        </div>
      ) : !registry?.length ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <BookOpen className="w-8 h-8 text-muted-foreground mb-3" />
          <p className="text-xs font-mono text-muted-foreground">No models registered yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {registry.map((item, idx) => {
            const reg = item.registration;
            const versions = item.versions ?? [];
            const latestVersion = versions[versions.length - 1];
            return (
              <div key={reg?.id ?? idx} className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-mono font-bold text-foreground">{reg?.name ?? "—"}</p>
                    <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                      {versions.length} version{versions.length !== 1 ? "s" : ""}
                      {latestVersion?.status ? ` · latest: ${latestVersion.status}` : ""}
                    </p>
                  </div>
                  <button
                    disabled
                    title="Coming in Phase 6"
                    className="font-mono text-xs px-3 py-1.5 rounded border border-border text-muted-foreground opacity-40 cursor-not-allowed"
                  >
                    Approve
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Deployments Tab ──────────────────────────────────────────────────────────

function DeploymentsTab({ wid }: { wid: number }) {
  const { data: deployments, isLoading } = useListModelDeployments(wid);

  return (
    <div className="space-y-4">
      <span className="text-xs font-mono font-bold text-foreground">Deployments</span>

      {isLoading ? (
        <div className="h-24 bg-card border border-border rounded-lg animate-pulse" />
      ) : !deployments?.length ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Server className="w-8 h-8 text-muted-foreground mb-3" />
          <p className="text-xs font-mono text-muted-foreground">No deployments yet.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-widest">Version ID</th>
                <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-widest">Status</th>
                <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-widest">Backend</th>
                <th className="text-left px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-widest">Deployed At</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((dep, idx) => (
                <tr key={dep.id ?? idx} className="border-b border-border/50 last:border-0 hover:bg-secondary/20">
                  <td className="px-4 py-2 text-foreground">{dep.version_id ?? "—"}</td>
                  <td className="px-4 py-2">
                    <Badge className={dep.status === "active" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"}>
                      {dep.status?.toUpperCase() ?? "—"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{dep.compute_backend ?? "—"}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {dep.deployed_at ? new Date(dep.deployed_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Policies Tab ─────────────────────────────────────────────────────────────

function PoliciesTab({ wid }: { wid: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [allowedModels, setAllowedModels] = useState("");
  const [maxJobs, setMaxJobs] = useState("");
  const [maxBytes, setMaxBytes] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  const { data: policy, isLoading } = useGetForgePolicy(wid);

  const updatePolicy = useUpdateForgePolicy({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForgePolicyQueryKey(wid) });
        toast({ title: "Policy updated" });
        setEditing(false);
      },
      onError: () => toast({ title: "Error", description: "Could not update policy", variant: "destructive" }),
    },
  });

  const startEdit = (p: ModelPolicy) => {
    setAllowedModels((p.allowed_base_models ?? []).join(", "));
    setMaxJobs(String(p.max_concurrent_jobs ?? ""));
    setMaxBytes(String(p.max_dataset_bytes != null ? Math.round(p.max_dataset_bytes / (1024 * 1024)) : ""));
    setRequiresApproval(p.deployment_requires_approval ?? false);
    setEditing(true);
  };

  const handleSave = () => {
    updatePolicy.mutate({
      wid,
      data: {
        allowed_base_models: allowedModels.split(",").map((s) => s.trim()).filter(Boolean),
        max_concurrent_jobs: maxJobs ? Number(maxJobs) : undefined,
        max_dataset_bytes: maxBytes ? Number(maxBytes) * 1024 * 1024 : undefined,
        deployment_requires_approval: requiresApproval,
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-bold text-foreground">Policies</span>
        {!editing && policy && (
          <button onClick={() => startEdit(policy)} className={btnSecondary}>
            Edit Policy
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="h-32 bg-card border border-border rounded-lg animate-pulse" />
      ) : editing ? (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Allowed Base Models (comma-separated)</label>
              <input value={allowedModels} onChange={(e) => setAllowedModels(e.target.value)} placeholder="gpt-4o-mini, claude-3-haiku" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Max Concurrent Jobs</label>
              <input type="number" value={maxJobs} onChange={(e) => setMaxJobs(e.target.value)} placeholder="5" className={inputCls} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground block mb-1">Max Dataset Size (MB)</label>
              <input type="number" value={maxBytes} onChange={(e) => setMaxBytes(e.target.value)} placeholder="1024" className={inputCls} />
            </div>
            <div className="flex items-center gap-2 pt-4">
              <input
                type="checkbox"
                id="requires-approval"
                checked={requiresApproval}
                onChange={(e) => setRequiresApproval(e.target.checked)}
                className="w-4 h-4"
              />
              <label htmlFor="requires-approval" className="text-xs font-mono text-foreground">
                Deployment requires approval
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={updatePolicy.isPending} className={btnPrimary}>
              {updatePolicy.isPending ? "Saving..." : "Save Policy"}
            </button>
            <button onClick={() => setEditing(false)} className={btnSecondary}>Cancel</button>
          </div>
        </div>
      ) : policy ? (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Allowed Base Models</p>
              <p className="text-xs font-mono text-foreground">
                {policy.allowed_base_models?.length ? policy.allowed_base_models.join(", ") : "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Max Concurrent Jobs</p>
              <p className="text-xs font-mono text-foreground">{policy.max_concurrent_jobs ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Max Dataset Size</p>
              <p className="text-xs font-mono text-foreground">
                {policy.max_dataset_bytes != null
                  ? `${Math.round(policy.max_dataset_bytes / (1024 * 1024))} MB`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Deployment Requires Approval</p>
              <p className="text-xs font-mono text-foreground">
                {policy.deployment_requires_approval ? "Yes" : "No"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Shield className="w-8 h-8 text-muted-foreground mb-3" />
          <p className="text-xs font-mono text-muted-foreground">No policy configured yet.</p>
        </div>
      )}
    </div>
  );
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

const TABS = [
  { key: "datasets",    label: "Datasets" },
  { key: "jobs",        label: "Jobs" },
  { key: "registry",   label: "Registry" },
  { key: "deployments", label: "Deployments" },
  { key: "policies",   label: "Policies" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// ─── Workspace Page ───────────────────────────────────────────────────────────

export default function ForgeWorkspacePage() {
  const params = useParams<{ wid: string; tab?: string }>();
  const [, navigate] = useLocation();

  const wid = Number(params.wid);
  const tab: TabKey = (params.tab as TabKey) ?? "datasets";

  const { data: workspace, isLoading } = useGetForgeWorkspace(wid);

  const handleTabChange = (key: TabKey) => {
    navigate(`/forge/${wid}/${key}`);
  };

  return (
    <Layout>
      <PageHeader
        title={isLoading ? "—" : (workspace?.name ?? "Workspace")}
        subtitle={workspace ? `domain: ${workspace.domain}` : undefined}
        action={
          workspace ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
              {workspace.status.toUpperCase()}
            </span>
          ) : undefined
        }
      />

      <div className="flex flex-col h-full">
        {/* Tab bar */}
        <div className="flex items-center gap-0 border-b border-border px-6 bg-card/30">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleTabChange(key)}
              className={`px-4 py-3 text-xs font-mono border-b-2 transition-colors ${
                tab === key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-6 space-y-6 flex-1 overflow-auto">
          {tab === "datasets"    && <DatasetsTab wid={wid} />}
          {tab === "jobs"        && <JobsTab wid={wid} />}
          {tab === "registry"    && <RegistryTab wid={wid} />}
          {tab === "deployments" && <DeploymentsTab wid={wid} />}
          {tab === "policies"    && <PoliciesTab wid={wid} />}
        </div>
      </div>
    </Layout>
  );
}
