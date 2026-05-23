/**
 * ActionPanel — Phase 2A: Action Generation UI
 *
 * Rendered inside MatterTab after a matter result is loaded.
 * Stores receipt_token from the matter response in component state.
 * Calls POST /api/v1/legal/action and renders the governed artifact.
 *
 * State machine reflected in UI:
 *   draft_pending_approval → green badge, "Copy for Review" enabled
 *   needs_revision         → amber badge, unresolved issues listed, "Copy for Review" disabled
 *   blocked                → red banner, human-only blockers listed, "Copy for Review" disabled
 */

import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionType = "draft_letter" | "generate_clause_pack";
type ArtifactStatus = "draft_pending_approval" | "needs_revision" | "blocked";

interface IssueResolution {
  issue_id: string;
  issue_source: "blocking_issue" | "risk_flag";
  status: "addressed" | "partially_addressed" | "unresolved" | "human_only_blocker";
  evidence: string;
}

interface DraftLetterArtifact {
  title: string;
  body: string;
  placeholders: string[];
}

interface ClausePackArtifact {
  clauses: Array<{
    clause_id: string;
    issue_id: string;
    title: string;
    body: string;
    source: "generated" | "template_only" | "human_only";
    note?: string;
  }>;
}

interface ActionGovernance {
  artifact_status: ArtifactStatus;
  impact_tier: "decision_support" | "action_triggering";
  approval_required: boolean;
  escalation_required: boolean;
  human_review_required: boolean;
  not_legal_advice: boolean;
  privilege_warning: string;
}

interface ActionResult {
  matter_id: string;
  action_type: ActionType;
  artifact_status: ArtifactStatus;
  draft_artifact: DraftLetterArtifact | ClausePackArtifact;
  issue_resolution_map: IssueResolution[];
  verification: {
    passed: boolean;
    unresolved_issues: string[];
    new_risks_detected: string[];
    human_only_blockers: string[];
  };
  governance: ActionGovernance;
  trace: {
    draft_model: string;
    verification_model: string;
    draft_latency_ms: number;
    verification_latency_ms: number;
    total_latency_ms: number;
    draft_hash: string;
    verification_hash: string;
    usage_event_id: string;
  };
}

// ── Status badge helpers ──────────────────────────────────────────────────────

const STATUS_BADGE: Record<ArtifactStatus, { label: string; className: string }> = {
  draft_pending_approval: {
    label: "Ready for review",
    className: "bg-green-100 text-green-800 border border-green-300",
  },
  needs_revision: {
    label: "Needs revision",
    className: "bg-amber-100 text-amber-800 border border-amber-300",
  },
  blocked: {
    label: "Blocked",
    className: "bg-red-100 text-red-800 border border-red-300",
  },
};

const ISSUE_STATUS_COLORS: Record<string, string> = {
  addressed: "text-green-700",
  partially_addressed: "text-amber-700",
  unresolved: "text-red-700 font-semibold",
  human_only_blocker: "text-purple-700 font-semibold",
};

// ── Component ─────────────────────────────────────────────────────────────────

interface ActionPanelProps {
  receiptToken: string;
  originalText: string;
  apiBase: string;
}

export default function ActionPanel({ receiptToken, originalText, apiBase }: ActionPanelProps) {
  const [actionType, setActionType] = useState<ActionType>("draft_letter");
  const [userInstruction, setUserInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function runAction() {
    if (userInstruction.length > 500) {
      setError("User instruction must be 500 characters or fewer.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const body: Record<string, string> = {
        receipt_token: receiptToken,
        original_text: originalText,
        action_type: actionType,
      };
      if (userInstruction.trim()) {
        body.user_instruction = userInstruction.trim();
      }

      const raw = await fetch(`${apiBase}/api/v1/legal/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const responseText = await raw.text();
      if (!responseText || responseText.trim() === "") {
        setError("Empty response from server.");
        return;
      }
      let data: any;
      try { data = JSON.parse(responseText); } catch {
        setError(`Invalid JSON response: ${responseText.slice(0, 200)}`);
        return;
      }
      if (!raw.ok) {
        setError(data?.error ?? data?.details ?? `Server error ${raw.status}`);
        return;
      }
      setResult(data as ActionResult);
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }

  function getArtifactText(r: ActionResult): string {
    if (r.action_type === "draft_letter") {
      const a = r.draft_artifact as DraftLetterArtifact;
      return `${a.title}\n\n${a.body}`;
    } else {
      const a = r.draft_artifact as ClausePackArtifact;
      return a.clauses
        .map((c) => `[${c.clause_id}] ${c.title}\n${c.body}${c.note ? `\nNote: ${c.note}` : ""}`)
        .join("\n\n---\n\n");
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(getArtifactText(result));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const badge = result ? STATUS_BADGE[result.artifact_status] : null;
  const canApprove = result?.artifact_status === "draft_pending_approval";

  return (
    <div className="mt-4 border-t border-gray-200 pt-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 uppercase tracking-wide">
        Generate Action Artifact
      </h3>

      {/* Controls */}
      <div className="flex flex-col gap-2 mb-3">
        <div className="flex gap-2">
          <button
            onClick={() => setActionType("draft_letter")}
            className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${
              actionType === "draft_letter"
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
            }`}
          >
            Draft Letter
          </button>
          <button
            onClick={() => setActionType("generate_clause_pack")}
            className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${
              actionType === "generate_clause_pack"
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
            }`}
          >
            Clause Pack
          </button>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Additional instruction{" "}
            <span className={userInstruction.length > 500 ? "text-red-600 font-semibold" : "text-gray-400"}>
              ({userInstruction.length}/500)
            </span>
          </label>
          <input
            type="text"
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Optional — e.g. 'Focus on IP assignment clause'"
            value={userInstruction}
            onChange={(e) => setUserInstruction(e.target.value)}
            maxLength={600}
          />
        </div>

        <button
          onClick={runAction}
          disabled={loading || userInstruction.length > 500}
          className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-xs font-semibold rounded transition-colors"
        >
          {loading
            ? `Generating ${actionType === "draft_letter" ? "letter" : "clause pack"}...`
            : `Generate ${actionType === "draft_letter" ? "Draft Letter" : "Clause Pack"}`}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-3">
          {/* Status banner */}
          {result.artifact_status === "blocked" && (
            <div className="bg-red-50 border border-red-300 rounded p-3">
              <div className="text-xs font-bold text-red-800 mb-1">BLOCKED — Do not use without attorney review</div>
              {result.verification.human_only_blockers.length > 0 && (
                <ul className="text-xs text-red-700 list-disc list-inside space-y-0.5">
                  {result.verification.human_only_blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Status badge + approve button */}
          <div className="flex items-center justify-between">
            {badge && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${badge.className}`}>
                {badge.label}
              </span>
            )}
            <button
              onClick={handleCopy}
              disabled={!canApprove}
              title={canApprove ? "Copy draft to clipboard for attorney review" : "Artifact must be in 'Ready for review' state before copying"}
              className={`text-xs px-3 py-1 rounded font-semibold transition-colors ${
                canApprove
                  ? "bg-green-600 hover:bg-green-700 text-white"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {copied ? "Copied!" : "Copy for Review"}
            </button>
          </div>

          {/* Governance notice */}
          <div className="text-xs text-gray-500 italic border-l-2 border-gray-200 pl-2">
            {result.governance.privilege_warning}
          </div>

          {/* Draft artifact */}
          {result.action_type === "draft_letter" && (
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1">
                {(result.draft_artifact as DraftLetterArtifact).title}
              </div>
              <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                {(result.draft_artifact as DraftLetterArtifact).body}
              </pre>
              {(result.draft_artifact as DraftLetterArtifact).placeholders.length > 0 && (
                <div className="mt-1 text-xs text-amber-700">
                  Placeholders: {(result.draft_artifact as DraftLetterArtifact).placeholders.join(", ")}
                </div>
              )}
            </div>
          )}

          {result.action_type === "generate_clause_pack" && (
            <div className="space-y-2">
              {(result.draft_artifact as ClausePackArtifact).clauses.map((c) => (
                <div key={c.clause_id} className="border border-gray-200 rounded p-2">
                  <div className="text-xs font-semibold text-gray-700 mb-0.5">
                    [{c.clause_id}] {c.title}
                    {c.source === "template_only" && (
                      <span className="ml-2 text-amber-600 font-normal">(template only)</span>
                    )}
                    {c.source === "human_only" && (
                      <span className="ml-2 text-purple-600 font-normal">(human-only blocker)</span>
                    )}
                  </div>
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono">{c.body}</pre>
                  {c.note && <div className="text-xs text-gray-400 italic mt-0.5">Note: {c.note}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Issue resolution map */}
          {result.issue_resolution_map.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">
                Issue Resolution Map
              </div>
              <div className="space-y-1">
                {result.issue_resolution_map.map((r) => (
                  <div key={r.issue_id} className="text-xs flex gap-2">
                    <span className={`shrink-0 ${ISSUE_STATUS_COLORS[r.status] ?? "text-gray-600"}`}>
                      {r.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-gray-500">{r.issue_id}</span>
                    {r.evidence && (
                      <span className="text-gray-400 truncate" title={r.evidence}>
                        — {r.evidence}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Verification flags */}
          {(result.verification.new_risks_detected.length > 0 ||
            result.verification.unresolved_issues.length > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded p-2">
              <div className="text-xs font-semibold text-amber-800 mb-1">Verification flags</div>
              {result.verification.unresolved_issues.map((u) => (
                <div key={u} className="text-xs text-red-700">Unresolved: {u}</div>
              ))}
              {result.verification.new_risks_detected.map((r, i) => (
                <div key={i} className="text-xs text-amber-700">{r}</div>
              ))}
            </div>
          )}

          {/* Trace */}
          <div className="text-xs text-gray-400 font-mono space-y-0.5 border-t border-gray-100 pt-2">
            <div>impact_tier: {result.governance.impact_tier}</div>
            <div>draft_model: {result.trace.draft_model}</div>
            <div>verify_model: {result.trace.verification_model}</div>
            <div>total_latency: {result.trace.total_latency_ms}ms</div>
            <div>draft_hash: {result.trace.draft_hash}</div>
            <div>verify_hash: {result.trace.verification_hash}</div>
          </div>
        </div>
      )}
    </div>
  );
}
