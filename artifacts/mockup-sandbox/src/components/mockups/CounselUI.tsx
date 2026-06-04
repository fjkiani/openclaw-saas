/**
 * CounselUI.tsx
 *
 * OpenClaw Semantic Law Counsel — three-tab product surface.
 *
 * Tabs:
 *   Analyze  — paste contract text → analyze clauses → risk cards
 *   Draft    — click "Draft Improved Clause" on any analyzed clause → improved text
 *   History  — past runs table + flywheel progress bar per task_type
 *
 * API base: VITE_API_BASE env var, defaults to https://openclaw-api-k30t.onrender.com
 * No mock data. Every tab hits live endpoints or shows an explicit error state.
 */

import { useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Progress } from "../ui/progress";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

// ── API base ──────────────────────────────────────────────────────────────────

const API_BASE =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ??
  "https://openclaw-api-k30t.onrender.com";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClauseResult {
  clause_id: string;
  clause_label: string;
  semantic_position: string;
  risk_level: "critical" | "high" | "medium" | "low" | "none";
  rationale_summary: string;
  recommended_action: string;
  target_redline?: string;
  confidence: number;
}

interface AnalyzeResponse {
  run_id?: string;
  matter_id?: string;
  doc_class?: string;
  clauses?: ClauseResult[];
  error?: string;
  details?: string;
}

interface DraftResponse {
  ok: boolean;
  clause_id: string;
  clause_label: string;
  improved_text: string;
  changes_summary: string;
  risk_reduction: "eliminated" | "reduced" | "flagged_for_counsel";
  confidence: number;
  model_used: string;
  error?: string;
  details?: string;
}

interface FlywheelDomain {
  domain: string;
  task_type: string;
  verified_pairs: number;
  total_pairs: number;
  sft_records: number;
  pct: number;
  training_status: "accumulating" | "threshold_met" | "training" | "deployed";
}

interface FlywheelStatus {
  threshold: number;
  domains: FlywheelDomain[];
  error?: string;
}

// ── Risk badge ────────────────────────────────────────────────────────────────

function RiskBadge({ level }: { level: string }) {
  const variants: Record<string, string> = {
    critical: "bg-red-600 text-white",
    high: "bg-orange-500 text-white",
    medium: "bg-yellow-500 text-black",
    low: "bg-green-600 text-white",
    none: "bg-gray-400 text-white",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${variants[level] ?? variants.none}`}
    >
      {level.toUpperCase()}
    </span>
  );
}

// ── Training status badge ─────────────────────────────────────────────────────

function TrainingBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    accumulating: "bg-gray-200 text-gray-700",
    threshold_met: "bg-yellow-400 text-black",
    training: "bg-blue-500 text-white",
    deployed: "bg-green-600 text-white",
  };
  const labels: Record<string, string> = {
    accumulating: "Accumulating",
    threshold_met: "Ready to Train",
    training: "Training",
    deployed: "Deployed",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${variants[status] ?? variants.accumulating}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ── Analyze Tab ───────────────────────────────────────────────────────────────

function AnalyzeTab({
  onAnalyzed,
}: {
  onAnalyzed: (runId: string | undefined, clauses: ClauseResult[], docClass: string) => void;
}) {
  const [text, setText] = useState("");
  const [specialist, setSpecialist] = useState("cofounder");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clauses, setClauses] = useState<ClauseResult[]>([]);
  const [runId, setRunId] = useState<string | undefined>();
  const [docClass, setDocClass] = useState("");

  const analyze = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setClauses([]);

    try {
      const resp = await fetch(`${API_BASE}/api/v1/legal/matter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({
          matter_type: specialist,
          text: text.trim(),
          tenant_id: "tenant-demo-openclaw",
        }),
      });

      const data: AnalyzeResponse = await resp.json();

      if (!resp.ok || data.error) {
        setError(data.details ?? data.error ?? `HTTP ${resp.status}`);
        return;
      }

      // The semantic shadow run populates semantic_clause_analyses async.
      // For the UI, we surface whatever clause data comes back in the response.
      // If the response doesn't include clauses directly, show the run receipt.
      const clauseList = data.clauses ?? [];
      setClauses(clauseList);
      setRunId(data.run_id ?? data.matter_id);
      setDocClass(data.doc_class ?? specialist);
      onAnalyzed(data.run_id ?? data.matter_id, clauseList, data.doc_class ?? specialist);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — is the API server running?");
    } finally {
      setLoading(false);
    }
  }, [text, specialist, onAnalyzed]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="text-sm font-medium text-gray-700 mb-1 block">
            Contract Text
          </label>
          <Textarea
            placeholder="Paste your co-founder agreement, contractor agreement, or other contract text here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[200px] font-mono text-sm"
          />
        </div>
        <div className="w-48 space-y-2">
          <label className="text-sm font-medium text-gray-700 block">Specialist</label>
          <Select value={specialist} onValueChange={setSpecialist}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cofounder">Co-Founder</SelectItem>
              <SelectItem value="contract">Contractor / IP</SelectItem>
              <SelectItem value="ip">IP Assignment</SelectItem>
              <SelectItem value="employment">Employment / Advisor</SelectItem>
              <SelectItem value="corporate">Corporate</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={analyze}
            disabled={loading || !text.trim()}
            className="w-full"
          >
            {loading ? "Analyzing..." : "Analyze"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {!loading && clauses.length === 0 && !error && runId && (
        <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          <strong>Run submitted:</strong> {runId}
          <br />
          Semantic shadow analysis runs asynchronously. Clause results will appear in History once complete.
        </div>
      )}

      {clauses.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-600">
              {clauses.length} clause{clauses.length !== 1 ? "s" : ""} analyzed
            </span>
            {docClass && (
              <Badge variant="outline" className="text-xs">
                {docClass.replace(/_/g, " ")}
              </Badge>
            )}
          </div>
          {clauses.map((clause) => (
            <Card key={clause.clause_id} className="border-l-4"
              style={{
                borderLeftColor:
                  clause.risk_level === "critical" ? "#dc2626" :
                  clause.risk_level === "high" ? "#f97316" :
                  clause.risk_level === "medium" ? "#eab308" :
                  "#16a34a",
              }}
            >
              <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">{clause.clause_label}</CardTitle>
                  <div className="flex items-center gap-2">
                    <RiskBadge level={clause.risk_level} />
                    <span className="text-xs text-gray-400">
                      {Math.round(clause.confidence * 100)}% confidence
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-3 space-y-2">
                <p className="text-xs text-gray-600">{clause.rationale_summary}</p>
                <div className="rounded bg-gray-50 p-2 text-xs text-gray-700">
                  <strong>Action:</strong> {clause.recommended_action}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Draft Tab ─────────────────────────────────────────────────────────────────

function DraftTab({
  runId,
  clauses,
  docClass,
}: {
  runId: string | undefined;
  clauses: ClauseResult[];
  docClass: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftResponse>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [originalTexts, setOriginalTexts] = useState<Record<string, string>>({});

  const draftClause = useCallback(
    async (clause: ClauseResult) => {
      setLoading((prev) => ({ ...prev, [clause.clause_id]: true }));
      setErrors((prev) => ({ ...prev, [clause.clause_id]: "" }));

      try {
        const body = runId
          ? {
              mode: "from_run",
              run_id: runId,
              clause_id: clause.clause_id,
              original_text: originalTexts[clause.clause_id] || undefined,
            }
          : {
              mode: "inline",
              clause_id: clause.clause_id,
              clause_label: clause.clause_label,
              doc_class: docClass,
              original_text: originalTexts[clause.clause_id] || `[${clause.clause_label} clause — paste original text above for best results]`,
              semantic_position: clause.semantic_position,
              risk_level: clause.risk_level,
              target_redline: clause.target_redline,
              recommended_action: clause.recommended_action,
              rationale: clause.rationale_summary,
            };

        const resp = await fetch(`${API_BASE}/api/v1/legal/clause/draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
          body: JSON.stringify(body),
        });

        const data: DraftResponse = await resp.json();

        if (!resp.ok || data.error) {
          setErrors((prev) => ({
            ...prev,
            [clause.clause_id]: data.details ?? data.error ?? `HTTP ${resp.status}`,
          }));
          return;
        }

        setDrafts((prev) => ({ ...prev, [clause.clause_id]: data }));
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          [clause.clause_id]: err instanceof Error ? err.message : "Network error",
        }));
      } finally {
        setLoading((prev) => ({ ...prev, [clause.clause_id]: false }));
      }
    },
    [runId, docClass, originalTexts],
  );

  if (clauses.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-gray-400">
        Run an analysis first — analyzed clauses will appear here for drafting.
      </div>
    );
  }

  const draftableClauses = clauses.filter(
    (c) => c.risk_level === "critical" || c.risk_level === "high" || c.risk_level === "medium",
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        {draftableClauses.length} clause{draftableClauses.length !== 1 ? "s" : ""} with medium+ risk.
        Each draft call writes a preference pair to the flywheel.
      </p>
      {draftableClauses.map((clause) => (
        <Card key={clause.clause_id}>
          <CardHeader className="pb-2 pt-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-semibold">{clause.clause_label}</CardTitle>
                <RiskBadge level={clause.risk_level} />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => draftClause(clause)}
                disabled={loading[clause.clause_id]}
              >
                {loading[clause.clause_id] ? "Drafting..." : "Draft Improved Clause"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-3">
            {/* Optional: original text input for better drafting */}
            <div>
              <label className="text-xs text-gray-500 mb-1 block">
                Original clause text (optional — improves draft quality)
              </label>
              <Textarea
                placeholder={`Paste the original ${clause.clause_label} text from the contract...`}
                value={originalTexts[clause.clause_id] ?? ""}
                onChange={(e) =>
                  setOriginalTexts((prev) => ({ ...prev, [clause.clause_id]: e.target.value }))
                }
                className="min-h-[80px] text-xs font-mono"
              />
            </div>

            {errors[clause.clause_id] && (
              <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                {errors[clause.clause_id]}
              </div>
            )}

            {drafts[clause.clause_id] && (
              <div className="space-y-2">
                <Separator />
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-700">Improved Clause</span>
                  <TrainingBadge
                    status={
                      drafts[clause.clause_id].risk_reduction === "eliminated"
                        ? "deployed"
                        : drafts[clause.clause_id].risk_reduction === "reduced"
                        ? "threshold_met"
                        : "accumulating"
                    }
                  />
                  <span className="text-xs text-gray-400">
                    {Math.round(drafts[clause.clause_id].confidence * 100)}% confidence ·{" "}
                    {drafts[clause.clause_id].model_used}
                  </span>
                </div>
                <div className="rounded bg-green-50 border border-green-200 p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap">
                  {drafts[clause.clause_id].improved_text}
                </div>
                <div className="rounded bg-gray-50 p-2 text-xs text-gray-600">
                  <strong>Changes:</strong> {drafts[clause.clause_id].changes_summary}
                </div>
                <p className="text-xs text-gray-400">
                  Preference pair written to flywheel (chosen=improved, rejected=original).
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────

function HistoryTab() {
  const [status, setStatus] = useState<FlywheelStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/v1/legal/flywheel/status`, {
        headers: { Authorization: "Bearer test" },
      });
      const data: FlywheelStatus = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error ?? `HTTP ${resp.status}`);
        return;
      }
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Flywheel Training Progress</h3>
        <Button size="sm" variant="outline" onClick={loadStatus} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {!status && !loading && !error && (
        <div className="flex items-center justify-center h-32 text-sm text-gray-400">
          Click Refresh to load flywheel status from the live API.
        </div>
      )}

      {status && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">
            Training fires at {status.threshold} judge-verified pairs per task type.
          </p>

          {status.domains.length === 0 && (
            <div className="text-sm text-gray-400">No preference pairs recorded yet.</div>
          )}

          {/* Per-task_type progress bars */}
          <div className="space-y-3">
            {status.domains.map((d) => (
              <Card key={`${d.domain}:${d.task_type}`}>
                <CardContent className="px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium capitalize">{d.domain}</span>
                      <Badge variant="outline" className="text-xs font-mono">
                        {d.task_type}
                      </Badge>
                    </div>
                    <TrainingBadge status={d.training_status} />
                  </div>
                  <Progress value={d.pct} className="h-2" />
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>
                      {d.verified_pairs} verified / {d.total_pairs} total pairs
                    </span>
                    <span>
                      {d.verified_pairs}/{status.threshold} ({d.pct}%)
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {d.sft_records} SFT record{d.sft_records !== 1 ? "s" : ""}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Summary table */}
          <Separator />
          <div>
            <h4 className="text-xs font-semibold text-gray-600 mb-2">Summary Table</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1 pr-3 font-medium text-gray-600">Domain</th>
                    <th className="text-left py-1 pr-3 font-medium text-gray-600">Task Type</th>
                    <th className="text-right py-1 pr-3 font-medium text-gray-600">Verified</th>
                    <th className="text-right py-1 pr-3 font-medium text-gray-600">Total</th>
                    <th className="text-right py-1 pr-3 font-medium text-gray-600">SFT</th>
                    <th className="text-left py-1 font-medium text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {status.domains.map((d) => (
                    <tr key={`${d.domain}:${d.task_type}`} className="border-b border-gray-100">
                      <td className="py-1 pr-3 capitalize">{d.domain}</td>
                      <td className="py-1 pr-3 font-mono text-gray-500">{d.task_type}</td>
                      <td className="py-1 pr-3 text-right">{d.verified_pairs}</td>
                      <td className="py-1 pr-3 text-right">{d.total_pairs}</td>
                      <td className="py-1 pr-3 text-right">{d.sft_records}</td>
                      <td className="py-1">
                        <TrainingBadge status={d.training_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function CounselUI() {
  const [analyzedRunId, setAnalyzedRunId] = useState<string | undefined>();
  const [analyzedClauses, setAnalyzedClauses] = useState<ClauseResult[]>([]);
  const [analyzedDocClass, setAnalyzedDocClass] = useState("");
  const [activeTab, setActiveTab] = useState("analyze");

  const handleAnalyzed = useCallback(
    (runId: string | undefined, clauses: ClauseResult[], docClass: string) => {
      setAnalyzedRunId(runId);
      setAnalyzedClauses(clauses);
      setAnalyzedDocClass(docClass);
      // Auto-switch to Draft tab if clauses came back
      if (clauses.length > 0) setActiveTab("draft");
    },
    [],
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-gray-900">Semantic Law Counsel</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Analyze contracts · Draft improved clauses · Track training progress
          </p>
          <p className="text-xs text-gray-400 mt-1 font-mono">
            API: {API_BASE}
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="analyze">Analyze</TabsTrigger>
            <TabsTrigger value="draft">
              Draft
              {analyzedClauses.length > 0 && (
                <span className="ml-1.5 rounded-full bg-orange-500 text-white text-xs px-1.5 py-0.5 leading-none">
                  {analyzedClauses.filter(
                    (c) => c.risk_level === "critical" || c.risk_level === "high" || c.risk_level === "medium",
                  ).length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="analyze" className="mt-4">
            <ScrollArea className="h-[600px] pr-2">
              <AnalyzeTab onAnalyzed={handleAnalyzed} />
            </ScrollArea>
          </TabsContent>

          <TabsContent value="draft" className="mt-4">
            <ScrollArea className="h-[600px] pr-2">
              <DraftTab
                runId={analyzedRunId}
                clauses={analyzedClauses}
                docClass={analyzedDocClass}
              />
            </ScrollArea>
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <ScrollArea className="h-[600px] pr-2">
              <HistoryTab />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
