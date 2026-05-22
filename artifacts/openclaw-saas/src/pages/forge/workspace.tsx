import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { apiFetch } from "@/lib/apiFetch";
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
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { DatasetExplorerTab } from "@/components/DatasetExplorer";
import { SaaSShowcaseTab } from "@/components/SaaSShowcase";
import { TrainingTab } from "@/components/TrainingTab";
import MatterTab from "@/components/MatterTab";

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

type DeploymentInfo = {
  registration_id: number;
  registration_name: string;
  version: number;
  version_id: number;
  version_status: string;
  artifact_key: string | null;
  deployment_id: number;
  deployment_status: string;
  endpoint_url: string;
  auth_required: boolean;
  deployed_at: string | null;
};

type InvokeResult = {
  clause_type: string;
  confidence: number;
  reasoning: string;
  metadata: {
    model: string;
    fallback_count: number;
    rag_used: boolean;
    asset_version: string;
    dataset_version: string;
    eval_run: string;
    model_eval_accuracy: number;
    model_eval_macro_f1: number;
    latency_ms: number;
  };
};

function UseModelPanel({
  wid,
  registrationId,
  registrationName,
  onClose,
}: {
  wid: number;
  registrationId: number;
  registrationName: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [deployLoading, setDeployLoading] = useState(true);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  // Fetch deployment info on mount
  useEffect(() => {
    setDeployLoading(true);
    apiFetch(`/api/forge/workspaces/${wid}/registry/${registrationId}/deployment`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d: DeploymentInfo) => {
        setDeployment(d);
        setDeployLoading(false);
      })
      .catch((e: any) => {
        setDeployError(e.message);
        setDeployLoading(false);
      });
  }, [wid, registrationId]);

  const handleRun = async () => {
    if (!text.trim()) {
      toast({ title: "Contract text is required" });
      return;
    }
    if (!deployment?.endpoint_url) {
      toast({ title: "No endpoint available", variant: "destructive" });
      return;
    }
    setLoading(true);
    setResult(null);
    setInvokeError(null);
    try {
      const resp = await apiFetch(`/api${deployment.endpoint_url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), use_rag: true }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error ?? resp.statusText);
      }
      // Guard against empty body (Render cold-start)
      const rawText = await resp.text();
      if (!rawText || !rawText.trim()) {
        throw new Error("Service is warming up — please try again in a few seconds.");
      }
      let data: InvokeResult;
      try { data = JSON.parse(rawText); } catch {
        throw new Error("Service returned an invalid response. It may still be warming up — please retry.");
      }
      setResult(data);
    } catch (e: any) {
      setInvokeError(e.message);
      toast({ title: "Inference failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const CLAUSE_COLORS: Record<string, string> = {
    governing_law: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    termination: "bg-red-500/10 text-red-400 border-red-500/20",
    ip_assignment: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    limitation_of_liability: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    indemnification: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  };

  return (
    <div className="mt-3 border-t border-border pt-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
          Use Model — {registrationName}
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Deployment status */}
      {deployLoading ? (
        <div className="text-[10px] font-mono text-muted-foreground">Loading endpoint...</div>
      ) : deployError ? (
        <div className="text-[10px] font-mono text-red-400">Endpoint error: {deployError}</div>
      ) : deployment ? (
        <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
          <span className="text-emerald-400">● ACTIVE</span>
          <span>{deployment.endpoint_url}</span>
          <span>v{deployment.version}</span>
        </div>
      ) : null}

      {/* Input */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] font-mono text-muted-foreground">
            Contract clause excerpt
          </label>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-muted-foreground">Try:</span>
            {[
              { label: "Governing Law", text: "This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law provisions." },
              { label: "Termination", text: "Either party may terminate this Agreement upon thirty (30) days written notice. Upon termination, all licenses granted hereunder shall immediately cease." },
              { label: "IP Assignment", text: "Employee hereby irrevocably assigns to Company all right, title, and interest in any inventions, works of authorship, or other intellectual property created during employment." },
              { label: "Indemnification", text: "Each party shall indemnify, defend, and hold harmless the other party from any claims, damages, or expenses arising from its breach of this Agreement." },
            ].map((ex) => (
              <button
                key={ex.label}
                onClick={() => setText(ex.text)}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Paste a contract clause here, or click an example above..."
          className={textareaCls}
          disabled={loading || deployLoading || !!deployError}
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] font-mono text-muted-foreground">{text.length}/8000 chars</span>
          <button
            onClick={handleRun}
            disabled={loading || !text.trim() || deployLoading || !!deployError}
            className={btnPrimary}
          >
            {loading ? "Running..." : "Run"}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-secondary/20 border border-border rounded p-3 space-y-2">
          {/* Clause type + confidence */}
          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                CLAUSE_COLORS[result.clause_type] ?? "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
              }`}
            >
              {result.clause_type.replace(/_/g, " ").toUpperCase()}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {(result.confidence * 100).toFixed(0)}% confidence
            </span>
            <span className="text-[10px] font-mono text-muted-foreground ml-auto">
              {result.metadata.latency_ms}ms
            </span>
          </div>

          {/* Reasoning */}
          <p className="text-xs font-mono text-foreground">{result.reasoning}</p>

          {/* Lineage strip */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t border-border/50">
            <span className="text-[10px] font-mono text-muted-foreground">
              model: <span className="text-foreground">{result.metadata.model.split("/").pop()}</span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              asset: <span className="text-foreground">{result.metadata.asset_version}</span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              dataset: <span className="text-foreground">{result.metadata.dataset_version}</span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              eval: <span className="text-foreground">{(result.metadata.model_eval_accuracy * 100).toFixed(0)}% acc</span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              rag: <span className="text-foreground">{result.metadata.rag_used ? "on" : "off"}</span>
            </span>
            {result.metadata.fallback_count > 0 && (
              <span className="text-[10px] font-mono text-amber-400">
                fallback #{result.metadata.fallback_count}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {invokeError && (
        <div className="text-[10px] font-mono text-red-400">Error: {invokeError}</div>
      )}
    </div>
  );
}

function RegistryTab({ wid }: { wid: number }) {
  const { data: registry, isLoading, error } = useListModelRegistry(wid);
  const [openPanelId, setOpenPanelId] = useState<number | null>(null);
  const [, navigate] = useLocation();

  // 403 means this workspace belongs to a different user session (stale workspace ID).
  // Redirect to /onboarding so the user gets a fresh workspace tied to their account.
  if ((error as any)?.status === 403) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
        <p className="text-xs font-mono text-muted-foreground">This workspace is not accessible in your current session.</p>
        <button
          onClick={() => navigate("/onboarding")}
          className="text-xs font-mono text-primary underline"
        >
          Re-provision workspace
        </button>
      </div>
    );
  }

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
            const isApprovedAndDeployed = latestVersion?.status === "approved";
            const isPanelOpen = openPanelId === (reg?.id ?? idx);

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
                  {isApprovedAndDeployed ? (
                    <button
                      onClick={() =>
                        setOpenPanelId(isPanelOpen ? null : (reg?.id ?? idx))
                      }
                      className={`font-mono text-xs px-3 py-1.5 rounded border transition-colors ${
                        isPanelOpen
                          ? "border-primary text-primary bg-primary/10"
                          : "border-primary text-primary hover:bg-primary/10"
                      }`}
                    >
                      {isPanelOpen ? "Close" : "Use Model"}
                    </button>
                  ) : (
                    <button
                      disabled
                      title="Model must be approved before use"
                      className="font-mono text-xs px-3 py-1.5 rounded border border-border text-muted-foreground opacity-40 cursor-not-allowed"
                    >
                      {latestVersion?.status === "candidate" ? "Pending Approval" : "Not Ready"}
                    </button>
                  )}
                </div>

                {/* Inline Use Model panel */}
                {isPanelOpen && reg?.id != null && (
                  <UseModelPanel
                    wid={wid}
                    registrationId={reg.id}
                    registrationName={reg.name ?? "Model"}
                    onClose={() => setOpenPanelId(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Deployments Tab ──────────────────────────────────────────────────────────

const EXAMPLE_CLAUSE_DEP =
  "This Agreement shall be governed by the laws of the State of Delaware, without regard to its conflict of law provisions. Any disputes arising under this Agreement shall be subject to the exclusive jurisdiction of the courts located in Wilmington, Delaware.";

type TryItResult = {
  clause_type?: string;
  confidence?: number;
  reasoning?: string;
  governance?: {
    human_review_required: boolean;
    privilege_warning: string;
    escalation_flag: boolean;
  };
  trace?: {
    model_used: string;
    latency_ms: number;
    usage_event_id: string;
  };
  lineage?: {
    dataset_version: string;
    eval_run: string;
  };
  // fallback: raw JSON
  [key: string]: unknown;
};

function DeploymentTryItPanel({
  wid,
  dep,
  onClose,
}: {
  wid: number;
  dep: { id?: number; version_id?: number; endpoint_url?: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [input, setInput] = useState(EXAMPLE_CLAUSE_DEP);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TryItResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const endpointUrl = dep.endpoint_url ?? "/api/v1/legal/extract-clause";

  async function handleRun() {
    if (!input.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const url = endpointUrl.startsWith("/api") ? endpointUrl : `/api${endpointUrl}`;
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.trim(), use_rag: true }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error((err as { error?: string }).error ?? resp.statusText);
      }
      // Guard against empty body (Render cold-start returns 200 with empty body on first wake)
      const text = await resp.text();
      if (!text || !text.trim()) {
        throw new Error("Service is warming up — please try again in a few seconds.");
      }
      let data: TryItResult;
      try { data = JSON.parse(text); } catch {
        throw new Error("Service returned an invalid response. It may still be warming up — please retry.");
      }
      setResult(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Request failed";
      setError(msg);
      toast({ title: "Inference failed", description: msg, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  function handleCopy() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mt-4 border-t border-border pt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Try It</span>
          <span className="text-[10px] font-mono text-muted-foreground">{endpointUrl}</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className={`grid gap-4 ${result ? "grid-cols-2" : "grid-cols-1"}`}>
        {/* Input */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1.5">
            Contract clause
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            className={textareaCls}
            placeholder="Paste a contract clause..."
          />
          <button
            onClick={handleRun}
            disabled={!input.trim() || running}
            className={`mt-2 flex items-center gap-1.5 ${btnPrimary}`}
          >
            {running ? "Running..." : "Run"}
          </button>
          {error && (
            <p className="mt-2 text-[10px] font-mono text-red-400">{error}</p>
          )}
        </div>

        {/* Output */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Output</span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground"
              >
                {copied ? "Copied ✓" : "Copy JSON"}
              </button>
            </div>

            {/* Result fields */}
            {result.clause_type && (
              <div className="bg-background border border-border rounded p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-20">clause_type</span>
                  <span className="text-xs font-mono text-primary font-bold">{result.clause_type}</span>
                </div>
                {result.confidence != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-20">confidence</span>
                    <span className="text-xs font-mono text-foreground">{result.confidence}</span>
                  </div>
                )}
                {result.reasoning && (
                  <div className="flex items-start gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-20 mt-0.5">reasoning</span>
                    <span className="text-[10px] font-mono text-foreground leading-relaxed">{result.reasoning}</span>
                  </div>
                )}
              </div>
            )}

            {/* Governance envelope — always visible, never collapsed */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-3 h-3 text-amber-400" />
                <span className="text-[10px] font-mono font-bold text-amber-400 uppercase tracking-widest">Governance</span>
                <span className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20">
                  ALWAYS PRESENT
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground w-32">human_review_required</span>
                  <span className="text-[10px] font-mono text-amber-400 font-bold">true</span>
                </div>
                {result.governance?.privilege_warning && (
                  <div className="flex items-start gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-32 mt-0.5">privilege_warning</span>
                    <span className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                      {result.governance.privilege_warning}
                    </span>
                  </div>
                )}
                {result.governance?.escalation_flag != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-32">escalation_flag</span>
                    <span className={`text-[10px] font-mono ${result.governance.escalation_flag ? "text-red-400" : "text-zinc-400"}`}>
                      {String(result.governance.escalation_flag)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Trace + lineage */}
            {(result.trace || result.lineage) && (
              <div className="bg-background border border-border rounded p-3 space-y-1">
                <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1.5">Trace · Lineage</div>
                {result.trace?.model_used && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-28">model_used</span>
                    <span className="text-[10px] font-mono text-foreground">{result.trace.model_used}</span>
                  </div>
                )}
                {result.trace?.latency_ms != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-28">latency_ms</span>
                    <span className="text-[10px] font-mono text-foreground">{result.trace.latency_ms}</span>
                  </div>
                )}
                {result.lineage?.dataset_version && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-28">dataset_version</span>
                    <span className="text-[10px] font-mono text-foreground">{result.lineage.dataset_version}</span>
                  </div>
                )}
                {result.lineage?.eval_run && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-28">eval_run</span>
                    <span className="text-[10px] font-mono text-foreground">{result.lineage.eval_run}</span>
                  </div>
                )}
              </div>
            )}

            <p className="text-[10px] font-mono text-muted-foreground">
              This output requires human review before use in any legal workflow.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DeploymentsTab({ wid }: { wid: number }) {
  const { data: deployments, isLoading } = useListModelDeployments(wid);
  const [openTryItId, setOpenTryItId] = useState<number | null>(null);

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
        <div className="space-y-3">
          {deployments.map((dep, idx) => {
            const isActive = dep.status === "active";
            const depId = dep.id ?? idx;
            const isTryItOpen = openTryItId === depId;

            return (
              <div
                key={depId}
                className={`bg-card border rounded-lg p-4 transition-colors ${
                  isActive ? "border-emerald-500/20" : "border-border"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge
                          className={
                            isActive
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
                          }
                        >
                          {dep.status?.toUpperCase() ?? "—"}
                        </Badge>
                        <span className="text-xs font-mono text-foreground">
                          Version {dep.version_id ?? "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
                        <span>backend: {dep.compute_backend ?? "—"}</span>
                        {dep.deployed_at && (
                          <span>deployed: {new Date(dep.deployed_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {isActive ? (
                    <button
                      onClick={() => setOpenTryItId(isTryItOpen ? null : depId)}
                      className={`shrink-0 font-mono text-xs px-3 py-1.5 rounded border transition-colors ${
                        isTryItOpen
                          ? "border-primary text-primary bg-primary/10"
                          : "border-primary text-primary hover:bg-primary/10"
                      }`}
                    >
                      {isTryItOpen ? "Close" : "Try it →"}
                    </button>
                  ) : (
                    <span className="shrink-0 text-[10px] font-mono text-muted-foreground">
                      Not active
                    </span>
                  )}
                </div>

                {/* Inline Try It panel */}
                {isTryItOpen && isActive && (
                  <DeploymentTryItPanel
                    wid={wid}
                    dep={dep}
                    onClose={() => setOpenTryItId(null)}
                  />
                )}
              </div>
            );
          })}
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

// ─── Journey Tab ──────────────────────────────────────────────────────────────

function JourneyTab({ wid }: { wid: number }) {
  const [, navigate] = useLocation();

  const stages = [
    {
      num: "01",
      title: "Dataset",
      subtitle: "What this asset was built and evaluated on",
      color: "text-blue-400",
      border: "border-blue-500/20",
      bg: "bg-blue-500/5",
      facts: [
        "CUAD v1 (CC BY 4.0) — 510 contracts, 41 QA types",
        "50 examples extracted: 30 train / 10 val / 10 test",
        "5 clause types: governing_law, termination, ip_assignment, limitation_of_liability, indemnification",
        "Retrieval index: FAISS IndexFlatIP, 384-dim, all-MiniLM-L6-v2",
      ],
      cta: "View Datasets",
      tab: "datasets",
    },
    {
      num: "02",
      title: "Eval",
      subtitle: "How the asset was tested",
      color: "text-purple-400",
      border: "border-purple-500/20",
      bg: "bg-purple-500/5",
      facts: [
        "Method: RAG adaptation — not fine-tuning. FAISS + sentence-transformers.",
        "Zero-shot baseline: acc=0.925, macro_f1=0.800 (liquid/lfm-2.5-1.2b-instruct)",
        "RAG result: acc=1.0, macro_f1=1.0 on 10 test examples",
        "Internal regression only. Not validated on real contracts. Not production-ready.",
      ],
      cta: "View Jobs",
      tab: "jobs",
    },
    {
      num: "03",
      title: "Registry",
      subtitle: "What was registered and deployed",
      color: "text-emerald-400",
      border: "border-emerald-500/20",
      bg: "bg-emerald-500/5",
      facts: [
        "7 agents registered: Legal Clause Extractor, Intake Router, Contract, Litigation, IP, Employment, Corporate",
        "Each agent has a live endpoint at openclaw-api-k30t.onrender.com",
        "Lineage: dataset v2 → RAG job → eval → approved version → active deployment",
        "All agents share the same governance envelope and trace output",
      ],
      cta: "Open Registry",
      tab: "registry",
    },
    {
      num: "04",
      title: "Governance",
      subtitle: "How every output is governed",
      color: "text-amber-400",
      border: "border-amber-500/20",
      bg: "bg-amber-500/5",
      facts: [
        "human_review_required=true on all legal outputs",
        "privilege_warning on every response — AI interaction does NOT create attorney-client privilege",
        "escalation_flag=true when confidence is low or matter is complex",
        "Deployment requires approval. Allowed models: liquid/lfm-2.5-1.2b-instruct, gpt-oss-20b",
      ],
      cta: "View Policies",
      tab: "policies",
    },
    {
      num: "05",
      title: "Playbook",
      subtitle: "How the system was adversarially tested",
      color: "text-red-400",
      border: "border-red-500/20",
      bg: "bg-red-500/5",
      facts: [
        "v1 harness: 10 scenarios, 19 steps — presence_pass_rate=1.0 (infrastructure proof)",
        "v2 harness: correctness_pass_rate=0.75 — 3 confirmed gaps: intake calibration, employment escalation, privilege detection",
        "Confirmed strengths: injection resistance (S9), multi-clause parsing (S2), IP edge cases (S5)",
        "Confirmed gaps are deterministic fixes — no model retraining required",
      ],
      cta: "Try a Model",
      tab: "registry",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-xs font-mono font-bold text-foreground">Build Journey</span>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
            How the Legal AI Operating Layer was built, evaluated, and deployed.
            Infrastructure for legal workflows — not legal advice.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {stages.map((stage) => (
          <div
            key={stage.num}
            className={`rounded-lg border p-4 ${stage.border} ${stage.bg}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <span className={`text-xs font-mono font-bold shrink-0 ${stage.color}`}>
                  {stage.num}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono font-bold text-foreground">{stage.title}</p>
                  <p className="text-[10px] font-mono text-muted-foreground mb-2">{stage.subtitle}</p>
                  <ul className="space-y-1">
                    {stage.facts.map((fact, i) => (
                      <li key={i} className="text-[10px] font-mono text-muted-foreground flex items-start gap-1.5">
                        <span className="text-muted-foreground/40 shrink-0 mt-0.5">·</span>
                        <span>{fact}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <button
                onClick={() => navigate(`/forge/${wid}/${stage.tab}`)}
                className={`shrink-0 font-mono text-[10px] px-2 py-1 rounded border transition-colors ${stage.border} ${stage.color} hover:opacity-80`}
              >
                {stage.cta}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="pt-2 border-t border-border/50">
        <p className="text-[10px] font-mono text-muted-foreground">
          OpenClaw is governed AI infrastructure for legal workflows. All outputs require human review. This system is not a law firm and does not provide legal advice.
        </p>
      </div>
    </div>
  );
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────

const TABS = [
  { key: "datasets",    label: "Datasets" },
  { key: "jobs",        label: "Jobs" },
  { key: "registry",   label: "Registry" },
  { key: "deployments", label: "Deployments" },
  { key: "matter",     label: "Matter" },
  { key: "policies",   label: "Policies" },
  { key: "explorer",   label: "Explorer" },
  { key: "showcase",   label: "Showcase" },
  { key: "training",   label: "Training" },
  { key: "journey",    label: "Journey" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// ─── Workspace Page ───────────────────────────────────────────────────────────

export default function ForgeWorkspacePage() {
  const params = useParams<{ wid: string; tab?: string }>();
  const [, navigate] = useLocation();

  const wid = Number(params.wid);
  const tab: TabKey = (params.tab as TabKey) ?? "datasets";

  const { data: workspace, isLoading, error: workspaceError } = useGetForgeWorkspace(wid);

  // Auto-redirect to onboarding if this workspace is not accessible (403 = wrong user session)
  useEffect(() => {
    if ((workspaceError as any)?.status === 403) {
      navigate("/onboarding");
    }
  }, [workspaceError, navigate]);

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
          <OnboardingChecklist wid={wid} />
          {tab === "datasets"    && <DatasetsTab wid={wid} />}
          {tab === "jobs"        && <JobsTab wid={wid} />}
          {tab === "registry"    && <RegistryTab wid={wid} />}
          {tab === "deployments" && <DeploymentsTab wid={wid} />}
          {tab === "matter"      && <MatterTab wid={String(wid)} />}
          {tab === "policies"    && <PoliciesTab wid={wid} />}
          {tab === "journey"     && <JourneyTab wid={wid} />}
          {tab === "explorer"    && <DatasetExplorerTab />}
          {tab === "training"    && <TrainingTab />}
          {tab === "showcase"    && <SaaSShowcaseTab />}
        </div>
      </div>
    </Layout>
  );
}
