import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Tag,
  Hash,
  AlignLeft,
  ToggleLeft,
  List,
  Search,
} from "lucide-react";

// ─── Schema definitions ───────────────────────────────────────────────────────

type FieldType = "string" | "text" | "integer" | "float" | "boolean" | "enum" | "array" | "object";

interface SchemaField {
  name: string;
  type: FieldType;
  description: string;
  required?: boolean;
  example?: string;
  enumValues?: string[];
}

interface DatasetSchema {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  license: string;
  totalExamples: number;
  splits: { train: number; val: number; test: number };
  purpose: string;
  fields: SchemaField[];
  clauseTypes?: string[];
  agentUse: string[];
  status: "active" | "archived" | "draft";
  lastUpdated: string;
}

const DATASETS: DatasetSchema[] = [
  {
    id: "cuad-v2",
    name: "CUAD Legal Clause Dataset v2",
    version: "2.0.0",
    description:
      "Contract Understanding Atticus Dataset — 510 commercial contracts annotated for 41 legal clause types. Extracted 50 examples across 5 high-signal clause types for RAG training and evaluation.",
    source: "CUAD v1 (CC BY 4.0) — Atticus Project",
    license: "CC BY 4.0",
    totalExamples: 50,
    splits: { train: 30, val: 10, test: 10 },
    purpose: "RAG retrieval index + clause extraction fine-tuning",
    status: "active",
    lastUpdated: "2025-04-12",
    clauseTypes: [
      "governing_law",
      "termination",
      "ip_assignment",
      "limitation_of_liability",
      "indemnification",
    ],
    agentUse: [
      "Legal Clause Extractor (POST /v1/legal/extract-clause)",
      "Contract Analyst (POST /v1/legal/contract/analyze)",
    ],
    fields: [
      { name: "id", type: "string", description: "Unique example identifier", required: true, example: "cuad_v2_0042" },
      { name: "contract_text", type: "text", description: "Raw contract passage (up to 2048 tokens)", required: true, example: "This Agreement shall be governed by the laws of the State of Delaware..." },
      { name: "clause_type", type: "enum", description: "Clause category label", required: true, enumValues: ["governing_law","termination","ip_assignment","limitation_of_liability","indemnification"], example: "governing_law" },
      { name: "clause_text", type: "text", description: "Extracted clause span from contract_text", required: true, example: "governed by the laws of the State of Delaware" },
      { name: "confidence", type: "float", description: "Annotator confidence score [0.0–1.0]", required: false, example: "0.95" },
      { name: "split", type: "enum", description: "Dataset partition", required: true, enumValues: ["train","val","test"], example: "train" },
      { name: "source_contract", type: "string", description: "Original CUAD contract filename", required: false, example: "CUAD_v1/full_contract_pdf/Part_I/Affiliate_Agreements/..." },
      { name: "metadata", type: "object", description: "Supplementary annotation metadata", required: false, example: '{ "annotator": "atticus", "review_round": 2 }' },
    ],
  },
  {
    id: "contract-corpus-v1",
    name: "Contract Corpus v1",
    version: "1.0.0",
    description:
      "Internal corpus of anonymized commercial contracts used for intake routing calibration and multi-specialist triage. Covers NDA, SaaS, employment, IP licensing, and M&A agreement types.",
    source: "Internal — anonymized client contracts",
    license: "Proprietary — internal use only",
    totalExamples: 120,
    splits: { train: 80, val: 20, test: 20 },
    purpose: "Intake router training + specialist routing calibration",
    status: "active",
    lastUpdated: "2025-03-28",
    agentUse: [
      "Intake Router (POST /v1/legal/intake)",
      "Employment Analyst (POST /v1/legal/employment/analyze)",
      "Corporate Analyst (POST /v1/legal/corporate/analyze)",
    ],
    fields: [
      { name: "id", type: "string", description: "Unique document identifier", required: true, example: "cc_v1_0017" },
      { name: "matter_type", type: "enum", description: "Legal matter category for routing", required: true, enumValues: ["contract","employment","ip","litigation","corporate","general"], example: "employment" },
      { name: "document_text", type: "text", description: "Full anonymized document text", required: true, example: "EMPLOYMENT AGREEMENT dated as of January 1, 2024..." },
      { name: "routing_label", type: "string", description: "Target specialist agent for this matter", required: true, example: "employment_analyst" },
      { name: "complexity", type: "enum", description: "Estimated matter complexity", required: false, enumValues: ["low","medium","high","escalate"], example: "medium" },
      { name: "jurisdiction", type: "string", description: "Governing jurisdiction if determinable", required: false, example: "New York" },
      { name: "privilege_flag", type: "boolean", description: "Whether document contains attorney-client privileged content", required: false, example: "false" },
    ],
  },
  {
    id: "playbook-eval-v2",
    name: "Adversarial Playbook Eval v2",
    version: "2.0.0",
    description:
      "10 adversarial scenarios × 19 evaluation steps designed to stress-test the full workforce: intake calibration, multi-clause parsing, IP edge cases, injection resistance, privilege detection, and governance envelope compliance.",
    source: "Internal — OpenClaw red-team harness",
    license: "Proprietary — internal use only",
    totalExamples: 10,
    splits: { train: 0, val: 0, test: 10 },
    purpose: "End-to-end adversarial evaluation of all 7 agents",
    status: "active",
    lastUpdated: "2025-05-01",
    agentUse: [
      "All 7 agents (full workforce evaluation)",
      "Governance layer (envelope compliance)",
    ],
    fields: [
      { name: "scenario_id", type: "string", description: "Scenario identifier (S1–S10)", required: true, example: "S4" },
      { name: "scenario_name", type: "string", description: "Human-readable scenario name", required: true, example: "Intake Calibration — Ambiguous Matter" },
      { name: "input_payload", type: "object", description: "Request body sent to the target endpoint", required: true, example: '{ "matter_description": "I need help with a contract dispute..." }' },
      { name: "target_endpoint", type: "string", description: "API endpoint under test", required: true, example: "POST /v1/legal/intake" },
      { name: "expected_fields", type: "array", description: "Response fields that must be present (presence check)", required: true, example: '["matter_type", "confidence", "recommended_specialist"]' },
      { name: "correctness_checks", type: "array", description: "Semantic correctness assertions evaluated by judge LLM", required: false, example: '["matter_type should be contract or employment", "confidence < 0.8 for ambiguous input"]' },
      { name: "pass_v1", type: "boolean", description: "Whether scenario passed in playbook v1 (presence only)", required: false, example: "true" },
      { name: "pass_v2", type: "boolean", description: "Whether scenario passed in playbook v2 (correctness)", required: false, example: "false" },
      { name: "gap_notes", type: "text", description: "Confirmed gap description if failed in v2", required: false, example: "Intake returns high confidence on ambiguous input — needs uncertainty instruction" },
    ],
  },
];

// ─── Field type icon ──────────────────────────────────────────────────────────

function FieldTypeIcon({ type }: { type: FieldType }) {
  const map: Record<FieldType, React.ReactNode> = {
    string:  <Tag className="w-3 h-3 text-blue-400" aria-hidden="true" />,
    text:    <AlignLeft className="w-3 h-3 text-purple-400" aria-hidden="true" />,
    integer: <Hash className="w-3 h-3 text-amber-400" aria-hidden="true" />,
    float:   <Hash className="w-3 h-3 text-amber-300" aria-hidden="true" />,
    boolean: <ToggleLeft className="w-3 h-3 text-emerald-400" aria-hidden="true" />,
    enum:    <List className="w-3 h-3 text-cyan-400" aria-hidden="true" />,
    array:   <List className="w-3 h-3 text-pink-400" aria-hidden="true" />,
    object:  <FileText className="w-3 h-3 text-zinc-400" aria-hidden="true" />,
  };
  return <>{map[type]}</>;
}

function FieldTypeBadge({ type }: { type: FieldType }) {
  const colors: Record<FieldType, string> = {
    string:  "bg-blue-500/10 text-blue-400 border-blue-500/20",
    text:    "bg-purple-500/10 text-purple-400 border-purple-500/20",
    integer: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    float:   "bg-amber-500/10 text-amber-300 border-amber-500/20",
    boolean: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    enum:    "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
    array:   "bg-pink-500/10 text-pink-400 border-pink-500/20",
    object:  "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${colors[type]}`}>
      {type}
    </span>
  );
}

function FieldRow({ field }: { field: SchemaField }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/20 transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <FieldTypeIcon type={field.type} />
        <span className="text-xs font-mono text-foreground font-medium flex-1 min-w-0">
          {field.name}
          {field.required && <span className="ml-1 text-red-400 text-[10px]" aria-label="required">*</span>}
        </span>
        <FieldTypeBadge type={field.type} />
        {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-1 bg-secondary/10 space-y-2">
          <p className="text-[11px] font-mono text-muted-foreground">{field.description}</p>
          {field.enumValues && (
            <div>
              <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">Values</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {field.enumValues.map((v) => (
                  <span key={v} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border text-foreground">{v}</span>
                ))}
              </div>
            </div>
          )}
          {field.example && (
            <div>
              <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider">Example</span>
              <p className="text-[10px] font-mono text-primary mt-0.5 break-all">{field.example}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DatasetExplorerCard({ ds }: { ds: DatasetSchema }) {
  const [expanded, setExpanded] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const statusColors: Record<string, string> = {
    active:   "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    archived: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    draft:    "bg-amber-500/10 text-amber-400 border-amber-500/20",
  };
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/20 transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Database className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs font-mono font-bold text-foreground">{ds.name}</p>
            <p className="text-[10px] font-mono text-muted-foreground mt-0.5">v{ds.version} · {ds.totalExamples} examples · {ds.license}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${statusColors[ds.status]}`}>{ds.status.toUpperCase()}</span>
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden="true" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border">
          <div className="p-4 space-y-3">
            <p className="text-[11px] font-mono text-muted-foreground leading-relaxed">{ds.description}</p>
            <div className="grid grid-cols-3 gap-3">
              {[["Train", ds.splits.train], ["Val", ds.splits.val], ["Test", ds.splits.test]].map(([label, val]) => (
                <div key={label as string} className="bg-secondary/30 rounded p-2.5">
                  <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">{label}</p>
                  <p className="text-sm font-mono font-bold text-foreground">{val}</p>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {[["Purpose", ds.purpose], ["Source", ds.source], ["Updated", ds.lastUpdated]].map(([label, val]) => (
                <div key={label as string} className="flex gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider shrink-0 w-16">{label}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{val}</span>
                </div>
              ))}
            </div>
            {ds.clauseTypes && (
              <div>
                <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1.5">Clause Types</p>
                <div className="flex flex-wrap gap-1">
                  {ds.clauseTypes.map((c) => (
                    <span key={c} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{c}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1.5">Used By</p>
              <ul className="space-y-0.5">
                {ds.agentUse.map((a) => (
                  <li key={a} className="text-[10px] font-mono text-muted-foreground flex items-start gap-1.5">
                    <span className="text-muted-foreground/40 shrink-0 mt-0.5" aria-hidden="true">·</span>{a}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="border-t border-border">
            <button
              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-secondary/20 transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              onClick={() => setSchemaOpen((v) => !v)}
              aria-expanded={schemaOpen}
            >
              <span className="text-[10px] font-mono font-bold text-foreground uppercase tracking-wider">Schema — {ds.fields.length} fields</span>
              {schemaOpen ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />}
            </button>
            {schemaOpen && (
              <div className="border-t border-border/50">
                <div className="flex flex-wrap gap-3 px-4 py-2 bg-secondary/10 border-b border-border/40">
                  {(["string","text","integer","float","boolean","enum","array","object"] as FieldType[]).map((t) => (
                    <div key={t} className="flex items-center gap-1">
                      <FieldTypeIcon type={t} />
                      <span className="text-[10px] font-mono text-muted-foreground">{t}</span>
                    </div>
                  ))}
                </div>
                {ds.fields.map((field) => <FieldRow key={field.name} field={field} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function DatasetExplorerTab() {
  const [search, setSearch] = useState("");
  const filtered = DATASETS.filter(
    (ds) =>
      ds.name.toLowerCase().includes(search.toLowerCase()) ||
      ds.description.toLowerCase().includes(search.toLowerCase()) ||
      ds.agentUse.some((a) => a.toLowerCase().includes(search.toLowerCase()))
  );
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="text-xs font-mono font-bold text-foreground">Dataset Explorer</span>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">All datasets powering the Legal AI workforce — schemas, splits, and agent lineage.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-muted-foreground">{DATASETS.length} datasets</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{DATASETS.filter((d) => d.status === "active").length} ACTIVE</span>
        </div>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search datasets, agents, clause types..." aria-label="Search datasets" className="w-full bg-background border border-border rounded pl-9 pr-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground" />
      </div>
      <div className="space-y-3" role="list" aria-label="Datasets">
        {filtered.length === 0 ? (
          <p className="text-xs font-mono text-muted-foreground py-8 text-center">No datasets match your search.</p>
        ) : (
          filtered.map((ds) => <div key={ds.id} role="listitem"><DatasetExplorerCard ds={ds} /></div>)
        )}
      </div>
      <div className="pt-2 border-t border-border/50">
        <p className="text-[10px] font-mono text-muted-foreground">All datasets are versioned and linked to training jobs, model registry entries, and active deployments. Schema definitions are authoritative for agent training and evaluation.</p>
      </div>
    </div>
  );
}
