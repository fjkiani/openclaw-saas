#!/usr/bin/env node
/** Idempotent importer for build_evidence_bundle.py output. */
import fs from "node:fs";
import readline from "node:readline";
import crypto from "node:crypto";
import pg from "pg";
const { Pool } = pg;
const bundle = process.argv[2];
if (!bundle || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=... node scripts/import-aacr-evidence.mjs <bundle-dir>"); process.exit(2);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const hash = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const receipt = (prefix, entity, field, value, sourceHash) => `${prefix}_${hash(JSON.stringify([entity,field,value,sourceHash])).slice(0,24)}`;
async function* jsonl(name) {
  const input = fs.createReadStream(`${bundle}/${name}`, "utf8");
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}
async function insertClaim(c, entityType, entityId, field, value, sourceState, tier, lifecycle, excerpt, sourceHash, use, eligible) {
  const id = receipt("clm", entityId, field, value, sourceHash);
  await c.query(`INSERT INTO aacr_claim_receipts
    (receipt_id,entity_type,entity_id,field_name,value_json,source_state,evidence_tier,lifecycle_status,source_excerpt,source_hash,permitted_use,claim_eligible)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(receipt_id) DO UPDATE SET value_json=excluded.value_json,lifecycle_status=excluded.lifecycle_status,claim_eligible=excluded.claim_eligible`,
    [id,entityType,entityId,field,JSON.stringify(value),sourceState,tier,lifecycle,excerpt,sourceHash,use,eligible]);
  return id;
}
const c = await pool.connect();
try {
  await c.query("BEGIN");
  const disposition = new Map();
  for await (const row of jsonl("record_dispositions.jsonl")) disposition.set(row.record_id,row);
  let abstracts=0;
  for await (const row of jsonl("abstracts.jsonl")) {
    const d=disposition.get(row.id)??{}; const sourceHash=hash(JSON.stringify(row));
    await c.query(`INSERT INTO aacr_abstracts(record_id,doi,title,abstract_text,source_label,source_sha256,enrichment_json,disposition,permitted_use,human_qc_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(record_id) DO UPDATE SET doi=excluded.doi,title=excluded.title,abstract_text=excluded.abstract_text,source_sha256=excluded.source_sha256,enrichment_json=excluded.enrichment_json,disposition=excluded.disposition,updated_at=now()`,
      [row.id,row.doi,row.title??"",row.abstract??"",row.source_label,sourceHash,JSON.stringify(row.enrichment??{}),d.disposition??"SOURCE_INGESTED_UNREVIEWED",d.permitted_use??"INTERNAL_FORENSIC_ONLY",d.human_qc_status??"NOT_STARTED"]);
    for (const [field,value] of [["title",row.title],["doi",row.doi],["abstract_text",row.abstract]]) {
      if (value != null) await insertClaim(c,"abstract",row.id,field,value,"AACR_SOURCE_DOCUMENT","SOURCE_PRIMARY","SOURCE_INGESTED",String(value).slice(0,500),sourceHash,"INTERNAL_VALIDATED_SUBSET",true);
    }
    abstracts++;
  }
  let studies=0;
  for await (const row of jsonl("registry_studies.jsonl")) {
    const s=row.registry, meta=row.receipt, raw=row.raw_response;
    await c.query(`INSERT INTO aacr_registry_studies(nct_id,brief_title,official_title,conditions,interventions,lead_sponsor,collaborators,phases,overall_status,start_date,primary_completion_date,current_response_sha256,verified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(nct_id) DO UPDATE SET brief_title=excluded.brief_title,official_title=excluded.official_title,conditions=excluded.conditions,interventions=excluded.interventions,lead_sponsor=excluded.lead_sponsor,collaborators=excluded.collaborators,phases=excluded.phases,overall_status=excluded.overall_status,start_date=excluded.start_date,primary_completion_date=excluded.primary_completion_date,current_response_sha256=excluded.current_response_sha256,verified_at=excluded.verified_at`,
      [s.nct_id,s.brief_title,s.official_title,JSON.stringify(s.conditions),JSON.stringify(s.interventions),s.lead_sponsor,JSON.stringify(s.collaborators),JSON.stringify(s.phases),s.overall_status,s.start_date,s.primary_completion_date,meta.response_sha256,meta.fetched_at_utc]);
    await c.query(`INSERT INTO aacr_registry_response_versions(nct_id,request_url,http_status,fetched_at,response_sha256,raw_response) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(nct_id,response_sha256) DO NOTHING`,[s.nct_id,meta.url,meta.http_status,meta.fetched_at_utc,meta.response_sha256,JSON.stringify(raw)]);
    for (const field of ["nct_id","brief_title","official_title","conditions","interventions","lead_sponsor","collaborators","phases","overall_status","start_date","primary_completion_date"]) {
      if (s[field] != null && !(Array.isArray(s[field])&&s[field].length===0)) await insertClaim(c,"registry_study",s.nct_id,field,s[field],"CLINICALTRIALS_GOV_API_V2","REGISTRY_PRIMARY","REGISTRY_VERIFIED",null,meta.response_sha256,"INTERNAL_VALIDATED_SUBSET",true);
    }
    studies++;
  }
  let linkages=0;
  for await (const row of jsonl("trial_linkages.jsonl")) {
    const nct=row.candidate.normalized_candidate.toUpperCase();
    for (const ev of row.source_linkages??[]) {
      const recordId=ev.source_records?.[0]?.record_id; if(!recordId) continue;
      await c.query(`INSERT INTO aacr_trial_linkages(source_record_id,nct_id,linkage_state,rule_version,evidence_json,receipt_id,permitted_use,human_qc_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(source_record_id,nct_id,rule_version) DO UPDATE SET linkage_state=excluded.linkage_state,evidence_json=excluded.evidence_json,receipt_id=excluded.receipt_id,permitted_use=excluded.permitted_use`,
        [recordId,nct,ev.decision,ev.rule_version,JSON.stringify(ev),ev.receipt_id,ev.permitted_use,ev.human_qc_status]); linkages++;
    }
  }
  for await (const row of jsonl("target_search_results.jsonl")) {
    await c.query(`INSERT INTO aacr_target_search_results(target_query,nct_id,registry_fact_receipt_id,registry_fact_state,target_association_state,aacr_abstract_linkage_state,query_protocol,search_timestamp,permitted_use)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(target_query,nct_id,query_protocol) DO UPDATE SET registry_fact_state=excluded.registry_fact_state,target_association_state=excluded.target_association_state,aacr_abstract_linkage_state=excluded.aacr_abstract_linkage_state`,
      [row.target_query,row.registry_facts.nct_id,row.registry_fact_receipt_id,row.registry_fact_state,row.target_association_state,row.aacr_abstract_linkage_state,row.query_protocol,row.search_timestamp_utc,row.permitted_use]);
  }
  for await (const row of jsonl("conflicts.jsonl")) {
    const values={cancer_type:row.cancer_type_values,fit_score:row.fit_score_values,crispro_axes:row.crispro_axes_values,trial_id:row.trial_id_values};
    await c.query(`INSERT INTO aacr_conflicts(record_id,field_name,values_json,models_json,routing,status,source_hash)
      SELECT $1,$2,$3,$4,$5,'OPEN',$6 WHERE NOT EXISTS(SELECT 1 FROM aacr_conflicts WHERE record_id=$1 AND field_name=$2 AND source_hash=$6)`,
      [row.record_id,"MULTI_MODEL",JSON.stringify(values),JSON.stringify(String(row.models??"").split("|")),row.routing,hash(JSON.stringify(row))]);
  }
  const seedTags=new Map();
  for await (const row of jsonl("review_seed.jsonl")) {
    const tags=seedTags.get(row.record_id)??new Set(); tags.add(row.stratum); seedTags.set(row.record_id,tags);
  }
  const conflictIds=await c.query(`SELECT DISTINCT record_id FROM aacr_conflicts WHERE routing='HUMAN_QC_REQUIRED'`);
  for(const row of conflictIds.rows){const tags=seedTags.get(row.record_id)??new Set();tags.add("multi_model_conflict");seedTags.set(row.record_id,tags);}
  for(const [recordId,tags] of seedTags){
    await c.query(`INSERT INTO aacr_review_items(record_id,source_set_tags,state,test_only,priority) VALUES($1,$2,'UNASSIGNED',false,$3)
      ON CONFLICT(record_id,test_only) DO UPDATE SET source_set_tags=excluded.source_set_tags,priority=excluded.priority`,[recordId,JSON.stringify([...tags]),tags.has("multi_model_conflict")?10:0]);
  }
  await c.query("COMMIT");
  console.log(JSON.stringify({abstracts,studies,linkages,review_items:seedTags.size},null,2));
} catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); await pool.end(); }
