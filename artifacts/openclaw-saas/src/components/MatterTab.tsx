/**
 * MatterTab — Live matter pipeline UI
 *
 * Calls POST /api/v1/legal/matter and renders the full governed pipeline result:
 *   Intake → Specialist → Governance → Trace
 *
 * Supports all matter types including the co-founder specialist.
 */

import { useState } from "react";

interface RiskFlag {
  clause_type?: string;
  severity?: string;
  issue?: string;
  clause_text?: string;
  recommendation?: string;
  // contract specialist fields
  risk_level?: string;
  recommended_action?: string;
}

interface DraftClause {
  clause_type: string;
  title: string;
  draft_text: string;
  notes: string;
}

interface MatterResult {
  matter_id: string;
  intake: {
    matter_type: string;
    confidence: number;
    routing_target: string;
    reasoning: string;
    model_used: string;
    latency_ms: number;
  };
  specialist_output: {
    // cofounder
    risk_flags?: RiskFlag[];
    missing_clauses?: string[];
    blocking_issues?: string[];
    overall_risk?: string;
    next_steps?: string[];
    draft_clauses?: DraftClause[];
    rag_entries_used?: number;
    // contract
    // litigation
    key_claims?: string[];
    jurisdiction?: string;
    estimated_complexity?: string;
    recommended_next_steps?: string[];
    statute_of_limitations_risk?: boolean;
    // ip
    ip_type?: string;
    ownership_risk?: boolean;
    transfer_required?: boolean;
    key_restrictions?: Array<{ restriction: string; clause_text: string }>;
    recommended_actions?: string[];
    // employment
    compliance_flags?: Array<{ rule: string; jurisdiction: string; severity: string; detected_text: string; recommended_action: string }>;
    ca_noncompete_void?: boolean;
    escalation_required?: boolean;
    // corporate
    governance_clauses?: Array<{ clause: string; clause_text: string }>;
    board_approval_required?: boolean;
    key_obligations?: string[];
    compliance_gaps?: Array<{ gap: string; obligation: string }>;
  };
  governance_decision: {
    action: string;
    escalation_required: boolean;
    escalation_reasons: string[];
    impact_tier: string;
    human_review_required: boolean;
    not_legal_advice: boolean;
  };
  trace: {
    matter_id: string;
    specialist: string;
    intake_latency_ms: number;
    specialist_latency_ms: number;
    total_latency_ms: number;
    intake_model: string;
    specialist_model: string;
    fallback_used: boolean;
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  high:     "bg-orange-100 text-orange-800 border-orange-300",
  medium:   "bg-yellow-100 text-yellow-800 border-yellow-300",
  low:      "bg-green-100 text-green-800 border-green-300",
};

const RISK_COLORS: Record<string, string> = {
  critical: "text-red-700 font-bold",
  high:     "text-orange-700 font-semibold",
  medium:   "text-yellow-700",
  low:      "text-green-700",
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${color}`}>
      {label.toUpperCase()}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function ExpandableClause({ clause }: { clause: DraftClause }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-200 rounded mb-2">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
        onClick={() => setOpen(!open)}
      >
        <span className="text-sm font-medium text-gray-800">{clause.title}</span>
        <span className="text-gray-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-gray-100">
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-mono bg-gray-50 p-2 rounded mt-2 max-h-64 overflow-y-auto">
            {clause.draft_text}
          </pre>
          {clause.notes && (
            <p className="text-xs text-gray-500 mt-2 italic">Attorney notes: {clause.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}

const SAMPLE_COFOUNDER = `Co-Founder Agreement — CMO and CEO/CTO

This agreement is between [CMO NAME] (Chief Medical Officer) and [CEO/CTO NAME] (Chief Executive Officer and Chief Technology Officer) for the formation of a company to develop VetOnco, Longevity, and DeepCrispr.ai platforms.

CMO Founder shall receive 30% equity upon signing. The remaining equity vests over 4 years with a 1-year cliff. CMO Founder shall assign all inventions made during the term to the Company.

CMO Founder's deliverables include providing medical expertise, advising on clinical matters, and supporting regulatory strategy.

The entity type has not been determined — the parties are considering both an S-Corp and a non-profit structure.`;

export default function MatterTab({ wid }: { wid: string }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MatterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const apiBase = (import.meta as any).env?.VITE_API_URL ?? "";

  async function runMatter() {
    if (!text.trim() || text.trim().length < 20) {
      setError("Please enter at least 20 characters of agreement text.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const raw = await fetch(`${apiBase}/api/v1/legal/matter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, tenant_id: wid }),
      });
      const body = await raw.text();
      if (!body || body.trim() === "") {
        setError("Empty response from server. The API may be cold-starting — please try again in 30 seconds.");
        return;
      }
      let data: any;
      try { data = JSON.parse(body); } catch {
        setError(`Invalid JSON response: ${body.slice(0, 200)}`);
        return;
      }
      if (!raw.ok) {
        setError(data?.error ?? data?.details ?? `Server error ${raw.status}`);
        return;
      }
      setResult(data as MatterResult);
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }

  function copyJson() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const so = result?.specialist_output;
  const gov = result?.governance_decision;
  const intake = result?.intake;
  const trace = result?.trace;

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full min-h-0">
      {/* ── Left panel: input ── */}
      <div className="lg:w-2/5 flex flex-col gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">
            Agreement Text
          </label>
          <textarea
            className="w-full h-64 p-3 text-sm border border-gray-300 rounded-lg font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Paste agreement text or describe what you need drafted..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <button
          className="text-xs text-gray-400 hover:text-gray-600 text-left underline"
          onClick={() => setText(SAMPLE_COFOUNDER)}
        >
          Load sample co-founder agreement
        </button>

        <button
          onClick={runMatter}
          disabled={loading}
          className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {loading ? "Running matter pipeline..." : "Run Matter"}
        </button>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="text-xs text-gray-400 leading-relaxed">
          Calls <code className="bg-gray-100 px-1 rounded">/api/v1/legal/matter</code> — full governed pipeline: intake → specialist → governance → trace.
          Not legal advice. Human review required.
        </div>
      </div>

      {/* ── Right panel: result ── */}
      <div className="lg:w-3/5 overflow-y-auto">
        {!result && !loading && (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
            Results will appear here after running the matter pipeline.
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
            <div className="text-center">
              <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2" />
              Running intake → specialist → governance...
            </div>
          </div>
        )}

        {result && (
          <div>
            {/* Copy JSON button */}
            <div className="flex justify-end mb-2">
              <button
                onClick={copyJson}
                className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1"
              >
                {copied ? "Copied!" : "Copy JSON"}
              </button>
            </div>

            {/* Intake */}
            {intake && (
              <Section title="Intake">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span><span className="text-gray-500">matter_type:</span> <strong>{intake.matter_type}</strong></span>
                  <span><span className="text-gray-500">confidence:</span> <strong>{(intake.confidence * 100).toFixed(0)}%</strong></span>
                  <span><span className="text-gray-500">model:</span> <code className="bg-gray-100 px-1 rounded">{intake.model_used}</code></span>
                  <span><span className="text-gray-500">latency:</span> {intake.latency_ms}ms</span>
                </div>
                {intake.reasoning && (
                  <p className="text-xs text-gray-500 mt-1 italic">{intake.reasoning}</p>
                )}
              </Section>
            )}

            {/* Risk Flags */}
            {so?.risk_flags && so.risk_flags.length > 0 && (
              <Section title={`Risk Flags (${so.risk_flags.length})`}>
                <div className="space-y-2">
                  {so.risk_flags.map((flag, i) => {
                    const sev = flag.severity ?? flag.risk_level ?? "medium";
                    return (
                      <div key={i} className={`p-2 rounded border text-xs ${SEVERITY_COLORS[sev] ?? SEVERITY_COLORS.medium}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <Badge label={sev} color={SEVERITY_COLORS[sev] ?? ""} />
                          <span className="font-medium">{flag.clause_type}</span>
                        </div>
                        <p>{flag.issue}</p>
                        {flag.clause_text && flag.clause_text !== "[MISSING]" && (
                          <p className="mt-1 text-gray-600 italic">"{flag.clause_text.slice(0, 120)}{flag.clause_text.length > 120 ? "..." : ""}"</p>
                        )}
                        {flag.clause_text === "[MISSING]" && (
                          <p className="mt-1 font-semibold">[MISSING FROM AGREEMENT]</p>
                        )}
                        {(flag.recommendation ?? flag.recommended_action) && (
                          <p className="mt-1 text-gray-700">→ {flag.recommendation ?? flag.recommended_action}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* Missing Clauses */}
            {so?.missing_clauses && so.missing_clauses.length > 0 && (
              <Section title="Missing Clauses">
                <div className="flex flex-wrap gap-1">
                  {so.missing_clauses.map((c, i) => (
                    <span key={i} className="bg-red-50 text-red-700 border border-red-200 rounded px-2 py-0.5 text-xs font-mono">
                      {c}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Blocking Issues */}
            {so?.blocking_issues && so.blocking_issues.length > 0 && (
              <Section title="Blocking Issues">
                <ul className="space-y-1">
                  {so.blocking_issues.map((issue, i) => (
                    <li key={i} className="text-xs text-red-700 flex gap-2">
                      <span className="text-red-400 mt-0.5">■</span>
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Overall Risk */}
            {so?.overall_risk && (
              <Section title="Overall Risk">
                <span className={`text-sm ${RISK_COLORS[so.overall_risk] ?? ""}`}>
                  {so.overall_risk.toUpperCase()}
                </span>
              </Section>
            )}

            {/* Next Steps */}
            {so?.next_steps && so.next_steps.length > 0 && (
              <Section title="Next Steps">
                <ol className="space-y-1 list-decimal list-inside">
                  {so.next_steps.map((step, i) => (
                    <li key={i} className="text-xs text-gray-700">{step}</li>
                  ))}
                </ol>
              </Section>
            )}

            {/* Draft Clauses */}
            {so?.draft_clauses && so.draft_clauses.length > 0 && (
              <Section title={`Draft Clauses (${so.draft_clauses.length})`}>
                {so.draft_clauses.map((clause, i) => (
                  <ExpandableClause key={i} clause={clause} />
                ))}
              </Section>
            )}

            {/* Litigation-specific */}
            {so?.key_claims && so.key_claims.length > 0 && (
              <Section title="Key Claims">
                <ul className="space-y-1">
                  {so.key_claims.map((c, i) => <li key={i} className="text-xs text-gray-700">• {c}</li>)}
                </ul>
              </Section>
            )}

            {/* IP-specific */}
            {so?.ip_type && (
              <Section title="IP Analysis">
                <div className="text-xs space-y-1">
                  <div><span className="text-gray-500">ip_type:</span> {so.ip_type}</div>
                  <div><span className="text-gray-500">ownership_risk:</span> {String(so.ownership_risk)}</div>
                  <div><span className="text-gray-500">transfer_required:</span> {String(so.transfer_required)}</div>
                </div>
              </Section>
            )}

            {/* Employment-specific */}
            {so?.compliance_flags && so.compliance_flags.length > 0 && (
              <Section title="Compliance Flags">
                <div className="space-y-2">
                  {so.compliance_flags.map((f, i) => (
                    <div key={i} className={`p-2 rounded border text-xs ${SEVERITY_COLORS[f.severity] ?? SEVERITY_COLORS.medium}`}>
                      <div className="font-medium">{f.rule}</div>
                      <div className="text-gray-600 mt-0.5">{f.recommended_action}</div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Governance */}
            {gov && (
              <Section title="Governance">
                <div className="space-y-1 text-xs">
                  <div className="flex gap-2">
                    <span className="text-gray-500">action:</span>
                    <span className={gov.action === "escalate" ? "text-red-700 font-semibold" : "text-green-700 font-semibold"}>
                      {gov.action}
                    </span>
                    <span className="text-gray-500">impact_tier:</span>
                    <span className="font-medium">{gov.impact_tier}</span>
                  </div>
                  {gov.escalation_reasons.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {gov.escalation_reasons.map((r, i) => (
                        <li key={i} className="text-red-700 flex gap-1">
                          <span>⚠</span><span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="text-gray-400 mt-1 italic">
                    {gov.not_legal_advice && "Not legal advice. "}
                    {gov.human_review_required && "Human review required."}
                  </div>
                </div>
              </Section>
            )}

            {/* Trace */}
            {trace && (
              <Section title="Trace">
                <div className="text-xs text-gray-500 space-y-0.5 font-mono">
                  <div>matter_id: {trace.matter_id}</div>
                  <div>specialist: {trace.specialist}</div>
                  <div>intake_model: {trace.intake_model}</div>
                  <div>specialist_model: {trace.specialist_model}</div>
                  <div>total_latency: {trace.total_latency_ms}ms</div>
                  <div>fallback_used: {String(trace.fallback_used)}</div>
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
