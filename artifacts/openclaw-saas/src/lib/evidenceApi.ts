import { apiFetch } from "@/lib/apiFetch";

export type EvidenceChip = "VERIFIED_REGISTRY_FACT" | "LINKAGE_UNVERIFIED" | "CONFLICT_REQUIRES_REVIEW" | "HUMAN_QC_VERIFIED" | "QUARANTINED";
export interface EvidenceClaim<T=unknown> {
  value:T; source_state:string; evidence_tier:string; lifecycle_status:string;
  receipt_id:string|null; source_excerpt:string|null; source_hash:string;
  permitted_use:string; claim_eligible:boolean;
}
async function get<T>(path:string):Promise<T>{
  const r=await apiFetch(path); if(!r.ok) throw new Error(`${r.status}: ${(await r.json().catch(()=>({error:r.statusText}))).error}`); return r.json();
}
async function send<T>(path:string,method:string,body?:unknown):Promise<T>{
  const r=await apiFetch(path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok) throw new Error(`${r.status}: ${(await r.json().catch(()=>({error:r.statusText}))).error}`); return r.json();
}
const base="/api/intelligence/evidence";
export const evidenceApi={
  search:(q:string,type="all",offset=0)=>get<any>(`${base}/search?q=${encodeURIComponent(q)}&entity_type=${encodeURIComponent(type)}&offset=${offset}`),
  target:(target:string)=>get<any>(`${base}/targets/${encodeURIComponent(target)}`),
  disease:(disease:string)=>get<any>(`${base}/diseases/${encodeURIComponent(disease)}`),
  trial:(nctId:string)=>get<any>(`${base}/trials/${encodeURIComponent(nctId)}`),
  abstract:(recordId:string)=>get<any>(`${base}/abstracts/${encodeURIComponent(recordId)}`),
  trace:(receiptId:string)=>get<any>(`${base}/traces/${encodeURIComponent(receiptId)}`),
  conflicts:()=>get<any>(`${base}/conflicts`), validation:()=>get<any>(`${base}/validation-board`),
  reviewQueue:()=>get<any>(`${base}/reviews/queue`),
  claimReview:(id:string)=>send<any>(`${base}/reviews/${id}/claim`,"POST"),
  submitLabel:(id:string,label:unknown)=>send<any>(`${base}/reviews/${id}/labels`,"POST",label),
  adjudicate:(id:string,label:unknown)=>send<any>(`${base}/reviews/${id}/adjudicate`,"POST",label),
  promote:(id:string)=>send<any>(`${base}/reviews/${id}/promote`,"POST"),
  reject:(id:string)=>send<any>(`${base}/reviews/${id}/reject`,"POST"),
};
