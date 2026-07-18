import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  evidenceEnvelope, forbiddenDistributionRoute, requireEvidenceIdentity,
  requireEvidenceRole, suppressIneligible,
} from "../lib/aacrEvidencePolicy.js";

const router = Router();
const BASE = "/intelligence/evidence";
router.use(BASE, requireEvidenceIdentity);

function paging(req: Request) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  return { limit, offset };
}

async function claims(entityType: string, entityIds: string[]) {
  if (!entityIds.length) return new Map<string, any[]>();
  const result = await pool.query(
    `SELECT * FROM aacr_claim_receipts WHERE entity_type=$1 AND entity_id=ANY($2::text[]) ORDER BY field_name`,
    [entityType, entityIds],
  );
  const grouped = new Map<string, any[]>();
  for (const row of result.rows) grouped.set(row.entity_id, [...(grouped.get(row.entity_id) ?? []), evidenceEnvelope(row)]);
  return grouped;
}

router.get(`${BASE}/search`, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) { res.status(400).json({ error: "QUERY_TOO_SHORT" }); return; }
  const { limit, offset } = paging(req);
  const entityType = String(req.query.entity_type ?? "all");
  const params = [q, limit, offset];
  const abstractSql = `
    SELECT record_id AS entity_id, 'abstract' AS entity_type, title AS label,
           ts_rank(search_document, websearch_to_tsquery('english',$1)) AS rank
    FROM aacr_abstracts
    WHERE search_document @@ websearch_to_tsquery('english',$1)
       OR record_id ILIKE '%'||$1||'%' OR doi ILIKE '%'||$1||'%'
    ORDER BY rank DESC, record_id LIMIT $2 OFFSET $3`;
  const registrySql = `
    SELECT nct_id AS entity_id, 'trial' AS entity_type, brief_title AS label,
           ts_rank(search_document, websearch_to_tsquery('english',$1)) AS rank
    FROM aacr_registry_studies
    WHERE search_document @@ websearch_to_tsquery('english',$1) OR nct_id ILIKE '%'||$1||'%'
    ORDER BY rank DESC, nct_id LIMIT $2 OFFSET $3`;
  const targetSql = `
    SELECT DISTINCT upper(target_query) AS entity_id, 'target' AS entity_type,
           upper(target_query) AS label, 1.0 AS rank
    FROM aacr_target_search_results WHERE target_query ILIKE '%'||$1||'%'
    ORDER BY label LIMIT $2 OFFSET $3`;
  const tasks: Array<Promise<any>> = [];
  if (["all", "abstract"].includes(entityType)) tasks.push(pool.query(abstractSql, params));
  if (["all", "trial", "drug", "disease", "sponsor"].includes(entityType)) tasks.push(pool.query(registrySql, params));
  if (["all", "target", "gene"].includes(entityType)) tasks.push(pool.query(targetSql, params));
  const results = (await Promise.all(tasks)).flatMap((r) => r.rows).sort((a,b) => Number(b.rank)-Number(a.rank)).slice(0,limit);
  const abstractIds = results.filter((x) => x.entity_type === "abstract").map((x) => x.entity_id);
  const trialIds = results.filter((x) => x.entity_type === "trial").map((x) => x.entity_id);
  const [abstractClaims, trialClaims] = await Promise.all([claims("abstract", abstractIds), claims("registry_study", trialIds)]);
  res.json({
    query: q, limit, offset,
    results: results.map((x) => ({ ...x, claims: x.entity_type === "abstract" ? abstractClaims.get(x.entity_id) ?? [] : x.entity_type === "trial" ? trialClaims.get(x.entity_id) ?? [] : [] })),
    governance: { scope: "INTERNAL_RESEARCH_ONLY", external_status: "EXTERNAL_NOT_AUTHORIZED", opportunity_scoring: "DISABLED" },
  });
});

router.get(`${BASE}/targets/:target`, async (req: Request, res: Response) => {
  const target = String(req.params.target).toUpperCase();
  const result = await pool.query(`
    SELECT t.*, s.brief_title, s.conditions, s.interventions, s.lead_sponsor, s.phases, s.overall_status,
           c.source_hash AS registry_source_hash
    FROM aacr_target_search_results t
    JOIN aacr_registry_studies s ON s.nct_id=t.nct_id
    JOIN aacr_claim_receipts c ON c.receipt_id=t.registry_fact_receipt_id
    WHERE upper(t.target_query)=upper($1) ORDER BY s.nct_id`, [target]);
  const byTrial = await claims("registry_study", result.rows.map((r) => r.nct_id));
  res.json({
    target,
    target_association_state: "QUERY_RETRIEVAL_ONLY_LINKAGE_UNVERIFIED",
    aacr_abstract_linkage_state: "LINKAGE_UNVERIFIED",
    studies: result.rows.map((r) => ({
      nct_id: r.nct_id,
      status_chip: "LINKAGE_UNVERIFIED",
      registry_facts: suppressIneligible(byTrial.get(r.nct_id) ?? []),
      target_association: { value: target, source_state: r.target_association_state, evidence_tier: "SEARCH_PROTOCOL_RETRIEVAL", lifecycle_status: "PENDING_REVIEW", receipt_id: null, registry_fact_receipt_id: r.registry_fact_receipt_id, retrieval_protocol: r.query_protocol, source_excerpt: null, source_hash: r.registry_source_hash, permitted_use: r.permitted_use, claim_eligible: false },
      aacr_abstract_linkage_state: r.aacr_abstract_linkage_state,
    })),
    interpretation_boundary: "Registry facts are verified independently. Retrieval by a target query does not itself verify molecular target association or AACR abstract linkage.",
  });
});

router.get(`${BASE}/diseases/:disease`, async (req: Request, res: Response) => {
  const disease = req.params.disease;
  const { limit, offset } = paging(req);
  const result = await pool.query(`SELECT nct_id FROM aacr_registry_studies WHERE conditions::text ILIKE '%'||$1||'%' ORDER BY nct_id LIMIT $2 OFFSET $3`, [disease,limit,offset]);
  const byTrial = await claims("registry_study", result.rows.map((r) => r.nct_id));
  res.json({ disease, studies: result.rows.map((r) => ({ nct_id:r.nct_id, registry_facts:suppressIneligible(byTrial.get(r.nct_id) ?? []) })), limit, offset });
});

router.get(`${BASE}/trials/:nctId`, async (req: Request, res: Response) => {
  const nctId = String(req.params.nctId).toUpperCase();
  const study = await pool.query(`SELECT * FROM aacr_registry_studies WHERE nct_id=$1`, [nctId]);
  if (!study.rowCount) { res.status(404).json({ error:"TRIAL_NOT_FOUND", linkage_state:"NOT_FOUND" }); return; }
  const receiptRows = await pool.query(`SELECT * FROM aacr_claim_receipts WHERE entity_type='registry_study' AND entity_id=$1 ORDER BY field_name`, [nctId]);
  const linkages = await pool.query(`SELECT source_record_id,linkage_state,receipt_id,evidence_json,permitted_use,human_qc_status FROM aacr_trial_linkages WHERE nct_id=$1 ORDER BY source_record_id`, [nctId]);
  res.json({
    nct_id:nctId, status_chip:"VERIFIED_REGISTRY_FACT", registry_facts:suppressIneligible(receiptRows.rows),
    abstract_linkages:linkages.rows.map((x) => ({...x,status_chip:x.human_qc_status==="VERIFIED"?"HUMAN_QC_VERIFIED":"LINKAGE_UNVERIFIED"})),
    boundary:"Registry fact verification and abstract linkage are separate states.",
  });
});

router.get(`${BASE}/abstracts/:recordId`, async (req: Request, res: Response) => {
  const recordId = req.params.recordId;
  const abstract = await pool.query(`SELECT record_id,doi,title,abstract_text,source_sha256,disposition,permitted_use,human_qc_status,enrichment_json FROM aacr_abstracts WHERE record_id=$1`,[recordId]);
  if (!abstract.rowCount) { res.status(404).json({error:"ABSTRACT_NOT_FOUND"}); return; }
  const receiptRows = await pool.query(`SELECT * FROM aacr_claim_receipts WHERE entity_type='abstract' AND entity_id=$1 ORDER BY field_name`,[recordId]);
  const conflictRows = await pool.query(`SELECT * FROM aacr_conflicts WHERE record_id=$1 ORDER BY created_at`,[recordId]);
  const linkageRows = await pool.query(`SELECT nct_id,linkage_state,receipt_id,evidence_json,permitted_use,human_qc_status FROM aacr_trial_linkages WHERE source_record_id=$1`,[recordId]);
  res.json({
    abstract:{...abstract.rows[0],enrichment_json:undefined},
    source_claims:receiptRows.rows.map(evidenceEnvelope),
    forensic_model_extraction:{ value:abstract.rows[0].enrichment_json, source_state:"MODEL_EXTRACTION", evidence_tier:"UNVALIDATED_EXTRACTION", lifecycle_status:"PENDING_QC", receipt_id:null, source_excerpt:null, source_hash:abstract.rows[0].source_sha256, permitted_use:"INTERNAL_FORENSIC_ONLY", claim_eligible:false },
    conflicts:conflictRows.rows.map((x)=>({...x,status_chip:"CONFLICT_REQUIRES_REVIEW"})),
    trial_linkages:linkageRows.rows,
  });
});

router.get(`${BASE}/traces/:receiptId`, async (req: Request,res: Response) => {
  const id=req.params.receiptId;
  const claim=await pool.query(`SELECT * FROM aacr_claim_receipts WHERE receipt_id=$1`,[id]);
  if (claim.rowCount) { res.json({trace_type:"CLAIM",claim:evidenceEnvelope(claim.rows[0]),raw:claim.rows[0]}); return; }
  const linkage=await pool.query(`SELECT * FROM aacr_trial_linkages WHERE receipt_id=$1`,[id]);
  if (linkage.rowCount) { res.json({trace_type:"LINKAGE",linkage:linkage.rows[0]}); return; }
  res.status(404).json({error:"RECEIPT_NOT_FOUND"});
});

router.get(`${BASE}/conflicts`, async (req:Request,res:Response)=>{
  const {limit,offset}=paging(req); const result=await pool.query(`SELECT * FROM aacr_conflicts WHERE status=coalesce($1,status) ORDER BY created_at LIMIT $2 OFFSET $3`,[req.query.status??null,limit,offset]);
  res.json({conflicts:result.rows.map((x)=>({...x,status_chip:"CONFLICT_REQUIRES_REVIEW"})),limit,offset});
});
router.get(`${BASE}/claims/:receiptId`, async (req:Request,res:Response)=>{
  const result=await pool.query(`SELECT * FROM aacr_claim_receipts WHERE receipt_id=$1`,[req.params.receiptId]);
  if(!result.rowCount){res.status(404).json({error:"CLAIM_NOT_FOUND"});return;} res.json({claim:evidenceEnvelope(result.rows[0])});
});

router.get(`${BASE}/validation-board`, async (_req:Request,res:Response)=>{
  const [abstracts, dispositions, linkages, registry, registryVersions, targetProtocols, conflicts, reviews, labels] = await Promise.all([
    pool.query(`SELECT count(*)::int n FROM aacr_abstracts`),
    pool.query(`SELECT disposition,count(*)::int n FROM aacr_abstracts GROUP BY disposition ORDER BY disposition`),
    pool.query(`SELECT linkage_state,count(*)::int n FROM aacr_trial_linkages GROUP BY linkage_state ORDER BY linkage_state`),
    pool.query(`SELECT count(*)::int n FROM aacr_registry_studies`),
    pool.query(`SELECT count(*)::int n,count(*) FILTER (WHERE http_status=200)::int found,count(*) FILTER (WHERE http_status=404)::int not_found FROM aacr_registry_response_versions`),
    pool.query(`SELECT count(DISTINCT nct_id)::int n FROM aacr_target_search_results`),
    pool.query(`SELECT status,count(*)::int n FROM aacr_conflicts GROUP BY status ORDER BY status`),
    pool.query(`SELECT state,count(*)::int n,min(created_at) oldest FROM aacr_review_items GROUP BY state ORDER BY state`),
    pool.query(`SELECT count(*) FILTER (WHERE i.test_only=false)::int n,count(*) FILTER (WHERE i.test_only=true)::int test_n FROM aacr_review_labels l JOIN aacr_review_items i USING(review_item_id)`),
  ]);
  res.json({
    corpus_denominator:abstracts.rows[0]?.n??0, dispositions:dispositions.rows, linkage_states:linkages.rows,
    registry_studies:registry.rows[0]?.n??0,
    candidate_registry_responses:registryVersions.rows[0]?.n??0,
    candidate_registry_studies_found:registryVersions.rows[0]?.found??0,
    candidate_registry_not_found:registryVersions.rows[0]?.not_found??0,
    target_protocol_fixtures:targetProtocols.rows[0]?.n??0,
    conflict_backlog:conflicts.rows, review_backlog:reviews.rows,
    human_labels:labels.rows[0]?.n??0, test_only_labels:labels.rows[0]?.test_n??0,
    model_field_performance: labels.rows[0]?.n ? "PENDING_COMPUTATION" : "NOT_AVAILABLE_UNTIL_GOLD_LABELS",
    calibration_metrics: labels.rows[0]?.n ? "PENDING_COMPUTATION" : "NOT_AVAILABLE_UNTIL_GOLD_LABELS",
    external_status:"EXTERNAL_NOT_AUTHORIZED", prohibited_claim_enforcement:"ENABLED",
  });
});

for (const channel of ["share","pdf","email","bulk-download","stale-export"]) {
  router.all(`${BASE}/${channel}`, requireEvidenceRole("ADMIN"), forbiddenDistributionRoute(channel));
}

router.get(`${BASE}/audit-export`, requireEvidenceRole("ADMIN"), async (_req:Request,res:Response)=>{
  const events=await pool.query(`SELECT event_id,review_item_id,actor_id,event_type,from_state,to_state,test_only,created_at FROM aacr_review_events ORDER BY created_at`);
  res.setHeader("Content-Type","application/json");
  res.setHeader("Content-Disposition",'attachment; filename="aacr-review-audit.json"');
  res.json({events:events.rows,claim_payloads_included:false,external_status:"EXTERNAL_NOT_AUTHORIZED"});
});

export default router;
