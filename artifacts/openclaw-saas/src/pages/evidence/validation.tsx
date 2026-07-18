import { useEffect, useState } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { BoundaryBanner, Metric, EmptyEvidence } from "@/components/evidence/EvidencePrimitives";
import { evidenceApi } from "@/lib/evidenceApi";

export default function EvidenceValidationPage() {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => { evidenceApi.validation().then(setData).catch((x) => setError(String(x))); }, []);
  return <Layout><PageHeader title="AACR Validation Board" subtitle="Denominators, linkage states, review backlog, and release controls"/>
    <div className="max-w-6xl mx-auto p-6 space-y-6"><BoundaryBanner/>
      {error && <div className="text-red-300">{error}</div>}
      {!data && !error && <EmptyEvidence text="Loading validation state…"/>}
      {data && <>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric label="Corpus denominator" value={data.corpus_denominator}/>
          <Metric label="Candidate registry responses" value={data.candidate_registry_responses}/>
          <Metric label="Found candidate studies" value={data.candidate_registry_studies_found}/>
          <Metric label="Registry 404 responses" value={data.candidate_registry_not_found}/>
          <Metric label="Target protocol fixtures" value={data.target_protocol_fixtures}/>
          <Metric label="All registry studies" value={data.registry_studies}/>
          <Metric label="Production human labels" value={data.human_labels}/>
          <Metric label="Test-only labels" value={data.test_only_labels}/>
          <Metric label="External status" value={<span className="text-sm">{data.external_status}</span>}/>
        </div>
        <Board title="Record disposition" rows={data.dispositions} keyName="disposition"/>
        <Board title="Deterministic linkage states" rows={data.linkage_states} keyName="linkage_state"/>
        <Board title="Conflict backlog" rows={data.conflict_backlog} keyName="status"/>
        <Board title="Review backlog" rows={data.review_backlog} keyName="state"/>
        <div className="grid md:grid-cols-2 gap-3">
          <Metric label="Model field performance" value={<span className="text-sm">{data.model_field_performance}</span>}/>
          <Metric label="Calibration" value={<span className="text-sm">{data.calibration_metrics}</span>}/>
        </div>
        <div data-testid="prohibited-claim-enforcement" className="border border-emerald-500/30 bg-emerald-500/5 rounded p-4 font-mono text-sm">Prohibited-claim enforcement: <b>{data.prohibited_claim_enforcement}</b></div>
      </>}
    </div>
  </Layout>;
}

function Board({ title, rows, keyName }: { title: string; rows: any[]; keyName: string }) {
  return <section><h2 className="font-mono font-bold mb-2">{title}</h2><div className="border border-border rounded overflow-hidden">
    {rows.map((row, index) => <div key={index} className="flex justify-between px-4 py-3 bg-card border-b last:border-b-0 border-border text-sm"><span className="font-mono">{row[keyName]}</span><b className="font-mono">{row.n}</b></div>)}
  </div></section>;
}
