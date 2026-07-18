import { Link } from "wouter";
import type { EvidenceChip, EvidenceClaim } from "@/lib/evidenceApi";
import { ShieldCheck, AlertTriangle, FileSearch, LockKeyhole } from "lucide-react";

const chipStyle:Record<EvidenceChip,string>={
  VERIFIED_REGISTRY_FACT:"bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  LINKAGE_UNVERIFIED:"bg-amber-500/10 text-amber-300 border-amber-500/30",
  CONFLICT_REQUIRES_REVIEW:"bg-red-500/10 text-red-300 border-red-500/30",
  HUMAN_QC_VERIFIED:"bg-blue-500/10 text-blue-300 border-blue-500/30",
  QUARANTINED:"bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
};
export function EvidenceStatusChip({status}:{status:EvidenceChip}){
  return <span data-testid={`evidence-chip-${status}`} className={`inline-flex rounded border px-2 py-1 text-[10px] font-mono font-semibold ${chipStyle[status]}`}>{status}</span>;
}
export function BoundaryBanner(){return <div data-testid="evidence-boundary" className="border border-amber-500/30 bg-amber-500/5 rounded p-3 flex gap-3 text-xs font-mono text-amber-100"><LockKeyhole className="w-4 h-4 shrink-0"/><div><b>Internal research evidence only.</b> Registry facts, target association, and AACR abstract linkage are separate evidence states. External outreach, opportunity ranking, and clinical-decision use are disabled.</div></div>}
function fmt(v:unknown){return typeof v==="string"?v:JSON.stringify(v,null,2)}
export function EvidenceCard({claim,label}:{claim:EvidenceClaim;label?:string}){
  const verified=claim.claim_eligible;
  return <article data-testid={`claim-${claim.receipt_id??"unreceipted"}`} className="border border-border rounded bg-card p-4 space-y-3">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{label??claim.evidence_tier}</p><div className="text-sm text-foreground break-words whitespace-pre-wrap">{fmt(claim.value)}</div></div><EvidenceStatusChip status={verified?"VERIFIED_REGISTRY_FACT":claim.lifecycle_status==="QUARANTINED"?"QUARANTINED":"LINKAGE_UNVERIFIED"}/></div>
    {claim.source_excerpt&&<blockquote className="border-l-2 border-primary/30 pl-3 text-xs text-muted-foreground whitespace-pre-wrap">{claim.source_excerpt}</blockquote>}
    <dl className="grid sm:grid-cols-3 gap-2 text-[10px] font-mono text-muted-foreground"><div><dt>Source state</dt><dd className="text-foreground">{claim.source_state}</dd></div><div><dt>Evidence tier</dt><dd className="text-foreground">{claim.evidence_tier}</dd></div><div><dt>Permitted use</dt><dd className="text-foreground">{claim.permitted_use}</dd></div></dl>
    {claim.receipt_id?<Link className="inline-flex items-center gap-1 text-xs font-mono text-primary hover:underline" href={`/evidence/traces/${encodeURIComponent(claim.receipt_id)}`}><ShieldCheck className="w-3 h-3"/>Open receipt {claim.receipt_id}</Link>:<div className="inline-flex items-center gap-1 text-xs text-amber-300"><AlertTriangle className="w-3 h-3"/>No receipt; not eligible as fact</div>}
  </article>
}
export function EmptyEvidence({text}:{text:string}){return <div className="py-16 text-center text-muted-foreground font-mono text-sm"><FileSearch className="w-8 h-8 mx-auto mb-3 opacity-50"/>{text}</div>}
export function Metric({label,value,detail}:{label:string;value:React.ReactNode;detail?:string}){return <div className="border border-border rounded bg-card p-4"><p className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">{label}</p><p className="text-2xl font-mono font-bold text-foreground mt-1">{value}</p>{detail&&<p className="text-xs text-muted-foreground mt-1">{detail}</p>}</div>}
