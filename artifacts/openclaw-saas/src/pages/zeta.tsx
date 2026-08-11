/**
 * zeta.tsx — Zeta Clearance: the institutional KYB portal.
 *
 * Makes the 4-layer workflow VISIBLE end-to-end:
 *   L1 Dynamic Data Room  — drag-drop corporate docs into the vault
 *   L1 Agentic Interrogator — chat that synchronously requests missing docs
 *   L2 UBO Graph          — deterministic ownership hierarchy + >25% UBO flags
 *   L3 Attestation        — Canton minimal claim + W3C VC status
 *   L4 Verification       — a relying party's instant clearance check (no PII)
 *
 * Admin-token gated (same pattern as workflows/rigor-gate). All calls real.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Upload, ShieldCheck, Network, FileCheck, Landmark,
  CheckCircle2, XCircle, AlertTriangle, MessageSquare, RefreshCw,
  Building2, FileText, Lock, Fingerprint, ArrowRight, CircleDot,
} from "lucide-react";

const TOKEN_KEY = "openclaw-admin-token";
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-openclaw-admin-token", getToken());
  if (init?.body && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const base = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
  const url = base && path.startsWith("/api") ? `${base}${path}` : path;
  return fetch(url, { ...init, headers });
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Entity { id: number; legalName: string; jurisdiction: string | null; status: string; riskTier: string | null; legalEntityHash: string; }
interface Doc { id: number; recordType: string; evidenceHash: string; sourceFilename: string; chunkCount: number; }
interface Edge { id: number; ownerId: string; ownedEntityId: string; directPct: number; ownerType: string; page: number; confidence: number; }
interface UBO { person_id: string; aggregate_pct: number; }
interface UboResult { ubos: UBO[]; flags: string[]; review_required: boolean; }
interface Attestation { cantonContractId: string; decision: string; riskTier: string; uboVerified: boolean; expiresAt: string; revoked: boolean; }
interface Interrogation { action: string; missing?: Record<string, unknown>; message?: string; }

const STATUS_COLOR: Record<string, string> = {
  intake: "bg-slate-500", interrogating: "bg-blue-500", review: "bg-amber-500",
  approved: "bg-emerald-600", rejected: "bg-rose-600", review_required: "bg-amber-500",
};

export default function ZetaPage() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ entity: Entity; documents: Doc[]; edges: Edge[]; ubo: (UboResult & { id: number }) | null; attestation: Attestation | null } | null>(null);
  const [newName, setNewName] = useState("");
  const [newJuris, setNewJuris] = useState("");
  const [busy, setBusy] = useState(false);
  const [interrogation, setInterrogation] = useState<Interrogation | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ cleared: boolean } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const say = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40));

  const loadEntities = useCallback(async () => {
    const r = await api("/api/zeta/entities");
    if (r.ok) { const d = await r.json(); setEntities(d.entities || []); }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    const r = await api(`/api/zeta/entities/${id}`);
    if (r.ok) setDetail(await r.json());
  }, []);

  useEffect(() => { loadEntities(); }, [loadEntities]);
  useEffect(() => { if (selected != null) loadDetail(selected); }, [selected, loadDetail]);

  const createEntity = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    const r = await api("/api/zeta/entities", { method: "POST", body: JSON.stringify({ legalName: newName, jurisdiction: newJuris }) });
    if (r.ok) { const e = await r.json(); say(`Intake opened for ${e.legalName}`); setNewName(""); setNewJuris(""); setSelected(e.id); await loadEntities(); }
    else say(`Intake failed: ${r.status}`);
    setBusy(false);
  };

  const uploadDoc = async (file: File, recordType = "cap_table") => {
    if (selected == null) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("recordType", recordType);
    const r = await api(`/api/zeta/entities/${selected}/documents`, { method: "POST", body: fd });
    if (r.ok) { const d = await r.json(); say(`Vaulted ${file.name} (encrypted) — ${d.edgesExtracted} ownership edges extracted`); await loadDetail(selected); await runInterrogate(); }
    else say(`Upload failed: ${r.status}`);
    setBusy(false);
  };

  const runInterrogate = async () => {
    if (selected == null) return;
    const r = await api(`/api/zeta/entities/${selected}/interrogate`);
    if (r.ok) { const d = await r.json(); setInterrogation(d); if (d.message) say(`Agent: ${d.message}`); }
  };

  const runUbo = async () => {
    if (selected == null) return;
    setBusy(true);
    const r = await api(`/api/zeta/entities/${selected}/ubo`, { method: "POST", body: JSON.stringify({ thresholdPct: 25 }) });
    if (r.ok) { const d = await r.json(); say(`UBO determination: ${d.ubos.length} UBOs, flags=[${d.flags.join(", ")}]`); await loadDetail(selected); }
    else say(`UBO failed: ${r.status}`);
    setBusy(false);
  };

  const attest = async () => {
    if (selected == null) return;
    setBusy(true);
    const r = await api(`/api/zeta/entities/${selected}/attest`, { method: "POST", body: JSON.stringify({}) });
    if (r.ok) { const d = await r.json(); say(`Canton attestation written: ${d.attestation.cantonContractId.slice(0, 8)}… decision=${d.attestation.decision}`); await loadDetail(selected); }
    else say(`Attest failed: ${r.status}`);
    setBusy(false);
  };

  const verify = async () => {
    if (!detail) return;
    const r = await api("/api/zeta/verify", { method: "POST", body: JSON.stringify({ legalEntityHash: detail.entity.legalEntityHash }) });
    if (r.ok) { const d = await r.json(); setVerifyResult(d); say(`Relying-party verification: ${d.cleared ? "CLEARED" : "NOT CLEARED"}`); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadDoc(f);
  };

  return (
    <Layout>
      <PageHeader
        title="Zeta Clearance"
        subtitle="Institutional KYB in minutes — agentic ingestion, zero-knowledge vault, Canton attestation, permissioned DeFi liquidity."
      />

      <div className="grid grid-cols-12 gap-4 p-4">
        {/* ── Left rail: intakes ── */}
        <div className="col-span-3 space-y-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Building2 className="h-4 w-4" /> New intake</div>
            <Input placeholder="Legal name (e.g. Acme OpCo Ltd)" value={newName} onChange={(e) => setNewName(e.target.value)} className="mb-2" />
            <Input placeholder="Jurisdiction (e.g. KY)" value={newJuris} onChange={(e) => setNewJuris(e.target.value)} className="mb-2" />
            <Button onClick={createEntity} disabled={busy || !newName.trim()} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Open KYB intake"}
            </Button>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Applicants</span>
              <RefreshCw className="h-3.5 w-3.5 cursor-pointer text-muted-foreground" onClick={loadEntities} />
            </div>
            <div className="space-y-1">
              {entities.map((e) => (
                <button key={e.id} onClick={() => setSelected(e.id)}
                  className={`w-full rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent ${selected === e.id ? "border-primary bg-accent" : ""}`}>
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium">{e.legalName}</span>
                    <span className={`ml-2 h-2 w-2 rounded-full ${STATUS_COLOR[e.status] || "bg-slate-400"}`} />
                  </div>
                  <div className="text-xs text-muted-foreground">{e.status}{e.riskTier ? ` · ${e.riskTier}` : ""}</div>
                </button>
              ))}
              {!entities.length && <div className="text-xs text-muted-foreground">No intakes yet.</div>}
            </div>
          </div>
        </div>

        {/* ── Main workflow ── */}
        <div className="col-span-9 space-y-4">
          {!detail && <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">Open an intake or select an applicant to begin the KYB workflow.</div>}

          {detail && (
            <>
              {/* L1: Data Room (drag-drop vault) */}
              <section className="rounded-lg border bg-card p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Lock className="h-4 w-4" /> L1 · Dynamic Data Room <span className="text-xs font-normal text-muted-foreground">(zero-knowledge vault — only hashes leave)</span></div>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileRef.current?.click()}
                  className={`cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition ${dragOver ? "border-primary bg-accent" : "border-muted"}`}>
                  <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <div className="text-sm">Drag & drop corporate docs (Articles, Cap Tables, Trust Deeds)</div>
                  <div className="text-xs text-muted-foreground">Encrypted on arrival — the agent parses them into a corporate hierarchy</div>
                  <input ref={fileRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && uploadDoc(e.target.files[0])} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.documents.map((d) => (
                    <Badge key={d.id} variant="secondary" className="flex items-center gap-1">
                      <FileText className="h-3 w-3" /> {d.recordType} · {d.chunkCount} chunks · {d.evidenceHash.slice(0, 8)}…
                    </Badge>
                  ))}
                </div>
              </section>

              {/* L1: Agentic Interrogator */}
              <section className="rounded-lg border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4" /> L1 · Agentic Interrogator</div>
                  <Button size="sm" variant="outline" onClick={runInterrogate}><RefreshCw className="mr-1 h-3.5 w-3.5" />Assess gaps</Button>
                </div>
                {interrogation?.message ? (
                  <div className="flex items-start gap-2 rounded-md bg-blue-50 p-3 text-sm dark:bg-blue-950">
                    <CircleDot className="mt-0.5 h-4 w-4 text-blue-500" />
                    <div>
                      <div className="font-medium">{interrogation.message}</div>
                      <div className="text-xs text-muted-foreground">action: {interrogation.action} — resolved synchronously, not by a compliance officer weeks later</div>
                    </div>
                  </div>
                ) : <div className="text-xs text-muted-foreground">Run an assessment to surface the next missing document.</div>}
              </section>

              {/* L2: UBO graph */}
              <section className="rounded-lg border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold"><Network className="h-4 w-4" /> L2 · Ownership Hierarchy & UBOs <span className="text-xs font-normal text-muted-foreground">(deterministic, not LLM)</span></div>
                  <Button size="sm" variant="outline" onClick={runUbo} disabled={busy || !detail.edges.length}><Fingerprint className="mr-1 h-3.5 w-3.5" />Determine UBOs</Button>
                </div>
                {/* ownership edges */}
                <div className="mb-3 space-y-1">
                  {detail.edges.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
                      <span className="font-medium">{e.ownerId}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{e.ownedEntityId}</span>
                      <Badge variant="outline" className="ml-auto">{e.directPct}%</Badge>
                      <span className="text-muted-foreground">p{e.page} · {(e.confidence * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                  {!detail.edges.length && <div className="text-xs text-muted-foreground">No ownership edges yet — upload a cap table.</div>}
                </div>
                {/* UBO result */}
                {detail.ubo && (
                  <div className="rounded-md border p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      UBOs ≥ {25}%
                      {detail.ubo.review_required
                        ? <Badge className="bg-amber-500"><AlertTriangle className="mr-1 h-3 w-3" />Human review required</Badge>
                        : <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />Clear</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {detail.ubo.ubos.map((u) => (
                        <Badge key={u.person_id} variant="secondary" className="text-sm">{u.person_id.replace(/_/g, " ")} · {u.aggregate_pct}%</Badge>
                      ))}
                      {!detail.ubo.ubos.length && <span className="text-xs text-muted-foreground">No natural person ≥ threshold.</span>}
                    </div>
                    {detail.ubo.flags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {detail.ubo.flags.map((f) => <Badge key={f} variant="destructive" className="text-xs">{f}</Badge>)}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* L3 + L4 */}
              <div className="grid grid-cols-2 gap-4">
                <section className="rounded-lg border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold"><FileCheck className="h-4 w-4" /> L3 · Canton Attestation</div>
                    <Button size="sm" onClick={attest} disabled={busy || !detail.ubo}><ShieldCheck className="mr-1 h-3.5 w-3.5" />Attest + issue VC</Button>
                  </div>
                  {detail.attestation ? (
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between"><span className="text-muted-foreground">Contract</span><span className="font-mono">{detail.attestation.cantonContractId.slice(0, 12)}…</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Decision</span><Badge className={STATUS_COLOR[detail.attestation.decision]}>{detail.attestation.decision}</Badge></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Risk tier</span><span>{detail.attestation.riskTier}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">UBO verified</span><span>{detail.attestation.uboVerified ? "yes" : "no"}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Expires</span><span>{new Date(detail.attestation.expiresAt).toLocaleDateString()}</span></div>
                      <div className="mt-1 rounded bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">W3C Verifiable Credential issued to applicant wallet — portable across Web3.</div>
                    </div>
                  ) : <div className="text-xs text-muted-foreground">Determine UBOs, then write the minimal non-PII claim to Canton.</div>}
                </section>

                <section className="rounded-lg border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4" /> L4 · Instant Verification</div>
                    <Button size="sm" variant="outline" onClick={verify} disabled={!detail.attestation}>Verify clearance</Button>
                  </div>
                  {verifyResult ? (
                    <div className={`rounded-md p-3 text-sm font-medium ${verifyResult.cleared ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"}`}>
                      {verifyResult.cleared
                        ? <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> CLEARED — permissioned pool may accept the deposit. No raw PII touched.</span>
                        : <span className="flex items-center gap-2"><XCircle className="h-4 w-4" /> NOT CLEARED — deposit blocked.</span>}
                    </div>
                  ) : <div className="text-xs text-muted-foreground">A relying party (Aave-Arc-style pool / prime broker) verifies the Canton claim or VC via webhook — instantly, without touching passports or cap tables.</div>}
                </section>
              </div>

              {/* activity log */}
              <section className="rounded-lg border bg-card p-3">
                <div className="mb-1 text-xs font-semibold text-muted-foreground">Workflow activity</div>
                <div className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs">
                  {log.map((l, i) => <div key={i}>{l}</div>)}
                  {!log.length && <div className="text-muted-foreground">—</div>}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
