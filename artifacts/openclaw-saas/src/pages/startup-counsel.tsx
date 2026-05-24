/**
 * startup-counsel.tsx
 *
 * Startup Counsel — deterministic legal drafting chatbot.
 * Wired to POST /api/v1/legal/draft and POST /api/v1/legal/draft/revise.
 *
 * Flow: intake → draft → revise (in-session thread)
 * No model calls. No fake success states. All governance language preserved.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/apiFetch";
import {
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Scale,
  ShieldAlert,
  RotateCcw,
  Send,
  Info,
} from "lucide-react";

// ── Types mirroring the API response shape ────────────────────────────────────

type DocClass = "co_founder_agreement" | "contractor_ip_assignment" | "advisor_agreement";
type ReviewThreshold =
  | "self_review_ok"
  | "business_review_required"
  | "counsel_review_required"
  | "blocked";

interface DraftSection {
  section_id: string;
  title: string;
  body: string;
  variant_id?: string;
  rationale?: {
    selection_reason: string;
    condition_matched: string;
    jurisdiction_note_applied: string | null;
    review_threshold: ReviewThreshold;
    assumptions_applied: string[];
  };
}

interface MissingDecisionPrompt {
  field: string;
  question: string;
  why_it_matters: string;
  minimum_answer: string;
  risk_if_skipped: string;
  review_threshold: ReviewThreshold;
  priority: number;
}

interface VerifierFlag {
  failure_id?: string;
  conflict_id?: string;
  flag_id?: string;
  section: string;
  message: string;
  review_threshold?: ReviewThreshold;
}

interface DraftApiResponse {
  draft_id: string;
  draft_receipt_token: string;
  doc_class: DocClass;
  draft: {
    title: string;
    sections: DraftSection[];
    full_text: string;
  };
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  missing_decision_prompts: MissingDecisionPrompt[];
  verifier: {
    template_failures: VerifierFlag[];
    legal_conflicts: (VerifierFlag & { sections_involved: string[] })[];
    jurisdiction_escalations: VerifierFlag[];
    missing_data: VerifierFlag[];
    passed: boolean;
  };
  governance: {
    artifact_status: string;
    escalation_required: boolean;
    review_threshold: ReviewThreshold;
    human_review_required: true;
    not_legal_advice: true;
    privilege_warning: string;
  };
  trace: {
    latency_ms: number;
    template_version: string;
    clause_library_version: string;
  };
  // revise-only
  revision_number?: number;
  parent_receipt_id?: string;
}

// ── Chat turn types ───────────────────────────────────────────────────────────

type TurnKind =
  | "user_intake"
  | "draft_result"
  | "user_revision"
  | "revision_result"
  | "error";

interface Turn {
  id: string;
  kind: TurnKind;
  // user turns
  label?: string;
  // result turns
  data?: DraftApiResponse;
  // error turns
  errorMessage?: string;
  errorRetryFn?: () => void;
}

// ── Intake form state ─────────────────────────────────────────────────────────

interface IntakeFormState {
  doc_class: DocClass;
  jurisdiction: string;
  party1_name: string;
  party1_role: string;
  party2_name: string;
  party2_role: string;
  equity_split_p1: string;
  equity_split_p2: string;
  vesting_years: string;
  cliff_months: string;
  acceleration: string;
  ip_scope: string;
  prior_inventions: string;
  advisory_services: string;
  advisory_equity_pct: string;
  raw_json_override: string;
  use_raw_json: boolean;
}

const DEFAULT_INTAKE: IntakeFormState = {
  doc_class: "co_founder_agreement",
  jurisdiction: "DE",
  party1_name: "",
  party1_role: "co_founder",
  party2_name: "",
  party2_role: "co_founder",
  equity_split_p1: "50",
  equity_split_p2: "50",
  vesting_years: "4",
  cliff_months: "12",
  acceleration: "single",
  ip_scope: "broad",
  prior_inventions: "",
  advisory_services: "",
  advisory_equity_pct: "",
  raw_json_override: "",
  use_raw_json: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildIntakePayload(form: IntakeFormState): Record<string, unknown> {
  if (form.use_raw_json && form.raw_json_override.trim()) {
    try {
      return JSON.parse(form.raw_json_override);
    } catch {
      throw new Error("Raw JSON is not valid JSON");
    }
  }

  const parties: Array<{ name: string; role: string }> = [
    { name: form.party1_name.trim() || "Party A", role: form.party1_role },
    { name: form.party2_name.trim() || "Party B", role: form.party2_role },
  ];

  const payload: Record<string, unknown> = {
    doc_class: form.doc_class,
    jurisdiction: form.jurisdiction,
    parties,
  };

  if (form.doc_class === "co_founder_agreement") {
    const split: Record<string, number> = {};
    split[parties[0].name] = parseFloat(form.equity_split_p1) || 50;
    split[parties[1].name] = parseFloat(form.equity_split_p2) || 50;
    payload.equity = {
      split,
      vesting_years: parseInt(form.vesting_years) || 4,
      cliff_months: parseInt(form.cliff_months) || 12,
      ...(form.acceleration ? { acceleration: form.acceleration } : {}),
    };
    payload.ip = {
      scope: form.ip_scope || "broad",
      ...(form.prior_inventions.trim()
        ? { prior_inventions: form.prior_inventions.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
    };
  }

  if (form.doc_class === "contractor_ip_assignment") {
    payload.ip = {
      scope: form.ip_scope || "work_product_only",
      ...(form.prior_inventions.trim()
        ? { prior_inventions: form.prior_inventions.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
    };
  }

  if (form.doc_class === "advisor_agreement") {
    payload.equity = {
      vesting_years: parseInt(form.vesting_years) || 2,
      cliff_months: parseInt(form.cliff_months) || 6,
      ...(form.acceleration ? { acceleration: form.acceleration } : {}),
    };
    payload.advisory = {
      ...(form.advisory_services.trim() ? { services_description: form.advisory_services.trim() } : {}),
      ...(form.advisory_equity_pct.trim() ? { equity_pct: parseFloat(form.advisory_equity_pct) } : {}),
    };
  }

  return payload;
}

function thresholdLabel(t: ReviewThreshold): string {
  const map: Record<ReviewThreshold, string> = {
    self_review_ok: "Self-review OK",
    business_review_required: "Business review required",
    counsel_review_required: "Counsel review required",
    blocked: "Blocked",
  };
  return map[t] ?? t;
}

function thresholdColor(t: ReviewThreshold): string {
  const map: Record<ReviewThreshold, string> = {
    self_review_ok: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    business_review_required: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    counsel_review_required: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    blocked: "bg-red-500/10 text-red-400 border-red-500/30",
  };
  return map[t] ?? "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
}

function docClassLabel(dc: DocClass): string {
  const map: Record<DocClass, string> = {
    co_founder_agreement: "Co-Founder Agreement",
    contractor_ip_assignment: "Contractor IP Assignment",
    advisor_agreement: "Advisor Agreement",
  };
  return map[dc];
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DisclaimerBanner() {
  return (
    <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-500/5 border-b border-amber-500/20 text-[11px] font-mono text-amber-400/90">
      <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>
        <strong>Not legal advice.</strong> Startup Counsel generates draft documents for review
        purposes only. All output requires review by qualified counsel before execution. Do not
        rely on this output as legal advice.
      </span>
    </div>
  );
}

function ThresholdBadge({ threshold }: { threshold: ReviewThreshold }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-mono border px-1.5 py-0.5 rounded ${thresholdColor(threshold)}`}
    >
      {threshold === "blocked" && <AlertTriangle className="w-2.5 h-2.5" />}
      {thresholdLabel(threshold)}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
      {children}
    </p>
  );
}

// ── Intake Form ───────────────────────────────────────────────────────────────

function IntakeForm({
  form,
  onChange,
  onSubmit,
  loading,
}: {
  form: IntakeFormState;
  onChange: (patch: Partial<IntakeFormState>) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const inputCls =
    "bg-background border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary h-8 px-2";
  const selectCls =
    "bg-background border border-border text-xs font-mono text-foreground focus:ring-primary rounded h-8 px-2 w-full";

  const isCoFounder = form.doc_class === "co_founder_agreement";
  const isContractor = form.doc_class === "contractor_ip_assignment";
  const isAdvisor = form.doc_class === "advisor_agreement";

  return (
    <div className="space-y-4">
      {/* Toggle raw JSON */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-mono font-bold text-foreground">Draft Request</p>
        <button
          type="button"
          onClick={() => onChange({ use_raw_json: !form.use_raw_json })}
          className="text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors"
        >
          {form.use_raw_json ? "← Use form" : "Raw JSON →"}
        </button>
      </div>

      {form.use_raw_json ? (
        <div className="space-y-1">
          <SectionLabel>Intake JSON</SectionLabel>
          <Textarea
            className="bg-background border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary resize-none min-h-[160px]"
            value={form.raw_json_override}
            onChange={(e) => onChange({ raw_json_override: e.target.value })}
            placeholder={`{\n  "doc_class": "co_founder_agreement",\n  "jurisdiction": "DE",\n  "parties": [...]\n}`}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {/* Doc class + jurisdiction */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <SectionLabel>Document type</SectionLabel>
              <select
                className={selectCls}
                value={form.doc_class}
                onChange={(e) => onChange({ doc_class: e.target.value as DocClass })}
              >
                <option value="co_founder_agreement">Co-Founder Agreement</option>
                <option value="contractor_ip_assignment">Contractor IP Assignment</option>
                <option value="advisor_agreement">Advisor Agreement</option>
              </select>
            </div>
            <div>
              <SectionLabel>Jurisdiction</SectionLabel>
              <select
                className={selectCls}
                value={form.jurisdiction}
                onChange={(e) => onChange({ jurisdiction: e.target.value })}
              >
                <option value="DE">Delaware</option>
                <option value="CA">California</option>
                <option value="NY">New York</option>
                <option value="WA">Washington</option>
              </select>
            </div>
          </div>

          {/* Parties */}
          <div>
            <SectionLabel>Parties</SectionLabel>
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  className={`${inputCls} border rounded w-full`}
                  placeholder="Party 1 name"
                  value={form.party1_name}
                  onChange={(e) => onChange({ party1_name: e.target.value })}
                />
                <select
                  className="bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2"
                  value={form.party1_role}
                  onChange={(e) => onChange({ party1_role: e.target.value })}
                >
                  {isCoFounder && <option value="co_founder">Co-founder</option>}
                  {isContractor && <option value="contractor">Contractor</option>}
                  {isContractor && <option value="company">Company</option>}
                  {isAdvisor && <option value="advisor">Advisor</option>}
                  {isAdvisor && <option value="company">Company</option>}
                </select>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  className={`${inputCls} border rounded w-full`}
                  placeholder="Party 2 name"
                  value={form.party2_name}
                  onChange={(e) => onChange({ party2_name: e.target.value })}
                />
                <select
                  className="bg-background border border-border text-xs font-mono text-foreground rounded h-8 px-2"
                  value={form.party2_role}
                  onChange={(e) => onChange({ party2_role: e.target.value })}
                >
                  {isCoFounder && <option value="co_founder">Co-founder</option>}
                  {isContractor && <option value="contractor">Contractor</option>}
                  {isContractor && <option value="company">Company</option>}
                  {isAdvisor && <option value="advisor">Advisor</option>}
                  {isAdvisor && <option value="company">Company</option>}
                </select>
              </div>
            </div>
          </div>

          {/* Equity (co-founder + advisor) */}
          {(isCoFounder || isAdvisor) && (
            <div>
              <SectionLabel>Equity / Vesting</SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                {isCoFounder && (
                  <>
                    <div>
                      <SectionLabel>Split % — Party 1</SectionLabel>
                      <input
                        type="number"
                        className={`${inputCls} border rounded w-full`}
                        value={form.equity_split_p1}
                        onChange={(e) => onChange({ equity_split_p1: e.target.value })}
                        placeholder="50"
                      />
                    </div>
                    <div>
                      <SectionLabel>Split % — Party 2</SectionLabel>
                      <input
                        type="number"
                        className={`${inputCls} border rounded w-full`}
                        value={form.equity_split_p2}
                        onChange={(e) => onChange({ equity_split_p2: e.target.value })}
                        placeholder="50"
                      />
                    </div>
                  </>
                )}
                <div>
                  <SectionLabel>Vesting years</SectionLabel>
                  <input
                    type="number"
                    className={`${inputCls} border rounded w-full`}
                    value={form.vesting_years}
                    onChange={(e) => onChange({ vesting_years: e.target.value })}
                    placeholder="4"
                  />
                </div>
                <div>
                  <SectionLabel>Cliff months</SectionLabel>
                  <input
                    type="number"
                    className={`${inputCls} border rounded w-full`}
                    value={form.cliff_months}
                    onChange={(e) => onChange({ cliff_months: e.target.value })}
                    placeholder="12"
                  />
                </div>
                <div>
                  <SectionLabel>Acceleration</SectionLabel>
                  <select
                    className={selectCls}
                    value={form.acceleration}
                    onChange={(e) => onChange({ acceleration: e.target.value })}
                  >
                    <option value="">None</option>
                    <option value="single">Single trigger</option>
                    <option value="double">Double trigger</option>
                    <option value="full">Full acceleration</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* IP scope (co-founder + contractor) */}
          {(isCoFounder || isContractor) && (
            <div>
              <SectionLabel>IP scope</SectionLabel>
              <select
                className={selectCls}
                value={form.ip_scope}
                onChange={(e) => onChange({ ip_scope: e.target.value })}
              >
                <option value="broad">Broad (all inventions)</option>
                <option value="work_product_only">Work product only</option>
              </select>
            </div>
          )}

          {/* Prior inventions */}
          {(isCoFounder || isContractor) && (
            <div>
              <SectionLabel>Prior inventions (comma-separated, optional)</SectionLabel>
              <input
                className={`${inputCls} border rounded w-full`}
                placeholder="e.g. personal blog engine, open-source library"
                value={form.prior_inventions}
                onChange={(e) => onChange({ prior_inventions: e.target.value })}
              />
            </div>
          )}

          {/* Advisory fields */}
          {isAdvisor && (
            <div className="space-y-2">
              <div>
                <SectionLabel>Services description</SectionLabel>
                <input
                  className={`${inputCls} border rounded w-full`}
                  placeholder="e.g. strategic introductions and go-to-market advisory"
                  value={form.advisory_services}
                  onChange={(e) => onChange({ advisory_services: e.target.value })}
                />
              </div>
              <div>
                <SectionLabel>Equity % (optional)</SectionLabel>
                <input
                  type="number"
                  className={`${inputCls} border rounded w-full`}
                  placeholder="e.g. 0.25"
                  value={form.advisory_equity_pct}
                  onChange={(e) => onChange({ advisory_equity_pct: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <Button
        className="w-full text-xs font-mono"
        onClick={onSubmit}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            Drafting…
          </>
        ) : (
          <>
            <Send className="w-3.5 h-3.5 mr-2" />
            Generate Draft
          </>
        )}
      </Button>
    </div>
  );
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Collapsible({
  label,
  defaultOpen = false,
  children,
  badge,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-mono font-bold text-foreground hover:bg-secondary/30 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
          {label}
        </span>
        {badge}
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-border">{children}</div>}
    </div>
  );
}

// ── Draft result renderer ─────────────────────────────────────────────────────

function DraftResultCard({
  data,
  label,
}: {
  data: DraftApiResponse;
  label: string;
}) {
  const { draft, governance, missing_decision_prompts, assumptions, missing_info_flags, verifier } =
    data;

  const allFlags = [
    ...verifier.template_failures,
    ...verifier.legal_conflicts,
    ...verifier.jurisdiction_escalations,
    ...verifier.missing_data,
  ];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-0.5">
            {label}
          </p>
          <p className="text-sm font-mono font-bold text-foreground">{draft.title}</p>
        </div>
        <ThresholdBadge threshold={governance.review_threshold} />
      </div>

      {/* Governance block */}
      <div
        className={`flex items-start gap-2 p-2.5 rounded border text-[10px] font-mono ${
          governance.review_threshold === "blocked"
            ? "bg-red-500/5 border-red-500/20 text-red-400"
            : governance.review_threshold === "counsel_review_required"
            ? "bg-orange-500/5 border-orange-500/20 text-orange-400"
            : "bg-amber-500/5 border-amber-500/20 text-amber-400"
        }`}
      >
        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div className="space-y-0.5">
          <p className="font-bold">
            {governance.artifact_status === "draft_pending_approval"
              ? "Draft pending approval"
              : governance.artifact_status === "needs_revision"
              ? "Needs revision before use"
              : governance.artifact_status}
          </p>
          <p className="text-[9px] opacity-80">{governance.privilege_warning}</p>
        </div>
      </div>

      {/* Missing decision prompts */}
      {missing_decision_prompts.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel>Decisions needed ({missing_decision_prompts.length})</SectionLabel>
          {missing_decision_prompts.map((p) => (
            <div
              key={p.field}
              className="p-2.5 bg-amber-500/5 border border-amber-500/20 rounded space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-mono font-bold text-amber-400">{p.field}</p>
                <ThresholdBadge threshold={p.review_threshold} />
              </div>
              <p className="text-[10px] font-mono text-foreground">{p.question}</p>
              <p className="text-[9px] font-mono text-muted-foreground">{p.why_it_matters}</p>
              {p.risk_if_skipped && (
                <p className="text-[9px] font-mono text-amber-400/70">
                  Risk if skipped: {p.risk_if_skipped}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Verifier flags */}
      {allFlags.length > 0 && (
        <Collapsible
          label={`Verifier flags (${allFlags.length})`}
          badge={
            <span className="text-[9px] font-mono text-red-400 border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 rounded">
              {allFlags.length}
            </span>
          }
        >
          <div className="space-y-1.5 pt-1">
            {allFlags.map((f, i) => (
              <div
                key={i}
                className="flex items-start gap-2 p-2 bg-red-500/5 border border-red-500/15 rounded"
              >
                <AlertTriangle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-[10px] font-mono font-bold text-red-400">
                    {f.failure_id ?? f.conflict_id ?? f.flag_id ?? "FLAG"}
                  </p>
                  <p className="text-[10px] font-mono text-foreground">{f.message}</p>
                  {f.review_threshold && (
                    <ThresholdBadge threshold={f.review_threshold} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {/* Assumptions */}
      {assumptions.length > 0 && (
        <Collapsible label={`Assumptions applied (${assumptions.length})`}>
          <ul className="space-y-1 pt-1">
            {assumptions.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[10px] font-mono text-muted-foreground">
                <Info className="w-3 h-3 mt-0.5 shrink-0 text-primary/60" />
                {a}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* Missing info flags */}
      {missing_info_flags.length > 0 && (
        <Collapsible label={`Missing info flags (${missing_info_flags.length})`}>
          <ul className="space-y-1 pt-1">
            {missing_info_flags.map((f, i) => (
              <li key={i} className="text-[10px] font-mono text-amber-400">
                {f}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* Draft sections */}
      <Collapsible
        label={`Draft sections (${draft.sections.length})`}
        defaultOpen
        badge={
          <FileText className="w-3 h-3 text-muted-foreground" />
        }
      >
        <div className="space-y-2 pt-1">
          {draft.sections.map((section) => (
            <Collapsible
              key={section.section_id}
              label={section.title}
              badge={
                section.rationale ? (
                  <ThresholdBadge threshold={section.rationale.review_threshold} />
                ) : undefined
              }
            >
              <div className="space-y-2 pt-1">
                <p className="text-[11px] font-mono text-foreground leading-relaxed whitespace-pre-wrap">
                  {section.body}
                </p>
                {section.rationale && (
                  <div className="mt-2 p-2 bg-muted/30 border border-border/50 rounded space-y-1">
                    <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">
                      Rationale
                    </p>
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {section.rationale.selection_reason}
                    </p>
                    {section.rationale.jurisdiction_note_applied && (
                      <p className="text-[9px] font-mono text-primary/70">
                        Jurisdiction note: {section.rationale.jurisdiction_note_applied}
                      </p>
                    )}
                    {section.rationale.assumptions_applied.length > 0 && (
                      <p className="text-[9px] font-mono text-muted-foreground">
                        Assumptions: {section.rationale.assumptions_applied.join("; ")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </Collapsible>
          ))}
        </div>
      </Collapsible>

      {/* Full text */}
      <Collapsible label="Full document text">
        <pre className="text-[10px] font-mono text-foreground whitespace-pre-wrap leading-relaxed pt-1 max-h-96 overflow-y-auto">
          {draft.full_text}
        </pre>
      </Collapsible>

      {/* Trace */}
      <p className="text-[9px] font-mono text-zinc-600">
        draft_id: {data.draft_id.slice(0, 12)}… · {data.trace.latency_ms}ms ·{" "}
        template {data.trace.template_version} · clauses {data.trace.clause_library_version}
        {data.revision_number !== undefined && ` · revision #${data.revision_number}`}
      </p>
    </div>
  );
}

// ── Revision composer ─────────────────────────────────────────────────────────

function RevisionComposer({
  onSubmit,
  loading,
}: {
  onSubmit: (instruction: string) => void;
  loading: boolean;
}) {
  const [instruction, setInstruction] = useState("");

  const handleSubmit = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setInstruction("");
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div className="space-y-2">
      <SectionLabel>Revision instruction</SectionLabel>
      <Textarea
        className="bg-background border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary resize-none min-h-[72px]"
        placeholder="Describe what to change — e.g. 'Change vesting to 3 years with 6-month cliff' or 'Remove acceleration clause'"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={handleKey}
        disabled={loading}
      />
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-mono text-muted-foreground">⌘↵ to submit</p>
        <Button
          size="sm"
          className="text-xs font-mono"
          onClick={handleSubmit}
          disabled={loading || !instruction.trim()}
        >
          {loading ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Revising…
            </>
          ) : (
            <>
              <RotateCcw className="w-3 h-3 mr-1.5" />
              Apply Revision
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ── Error card ────────────────────────────────────────────────────────────────

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/20 rounded">
      <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1.5">
        <p className="text-[11px] font-mono text-red-400">{message}</p>
        {onRetry && (
          <Button
            size="sm"
            variant="outline"
            className="text-[10px] font-mono border-red-500/30 text-red-400 hover:bg-red-500/10 h-6 px-2"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
        <Scale className="w-6 h-6 text-primary" />
      </div>
      <h3 className="text-sm font-mono font-bold text-foreground mb-2">Startup Counsel</h3>
      <p className="text-xs font-mono text-muted-foreground max-w-sm mb-4 leading-relaxed">
        Generate deterministic legal drafts for co-founder agreements, contractor IP assignments,
        and advisor agreements. No model calls — clause selection is rule-based and auditable.
      </p>
      <div className="text-left space-y-1.5 max-w-xs w-full">
        {[
          "Co-Founder Agreement (DE / CA)",
          "Contractor IP Assignment",
          "Advisor Agreement",
        ].map((item) => (
          <div key={item} className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
            <span className="w-1 h-1 rounded-full bg-primary/60 shrink-0" />
            {item}
          </div>
        ))}
      </div>
      <p className="text-[9px] font-mono text-muted-foreground/60 mt-6 max-w-xs">
        Fill in the form on the right and click Generate Draft to begin.
      </p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StartupCounselPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [form, setForm] = useState<IntakeFormState>(DEFAULT_INTAKE);
  const [loading, setLoading] = useState(false);
  const [lastReceiptToken, setLastReceiptToken] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new turn
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const addTurn = useCallback((turn: Turn) => {
    setTurns((prev) => [...prev, turn]);
  }, []);

  const submitDraft = useCallback(async () => {
    let payload: Record<string, unknown>;
    try {
      payload = buildIntakePayload(form);
    } catch (err) {
      addTurn({
        id: nanoid(),
        kind: "error",
        errorMessage: err instanceof Error ? err.message : "Invalid intake",
      });
      return;
    }

    const userLabel = `${docClassLabel(form.doc_class)} — ${form.jurisdiction}${
      form.use_raw_json ? " (raw JSON)" : ""
    }`;

    addTurn({ id: nanoid(), kind: "user_intake", label: userLabel });
    setLoading(true);

    const doRequest = async () => {
      try {
        const res = await apiFetch("/api/v1/legal/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          const msg =
            body.message ?? body.error ?? `Server returned ${res.status}`;
          addTurn({
            id: nanoid(),
            kind: "error",
            errorMessage: `Draft failed: ${msg}`,
            errorRetryFn: doRequest,
          });
          return;
        }

        const data: DraftApiResponse = await res.json();
        setLastReceiptToken(data.draft_receipt_token);
        addTurn({ id: nanoid(), kind: "draft_result", data });
      } catch (err) {
        addTurn({
          id: nanoid(),
          kind: "error",
          errorMessage: `Network error: ${err instanceof Error ? err.message : String(err)}`,
          errorRetryFn: doRequest,
        });
      } finally {
        setLoading(false);
      }
    };

    await doRequest();
  }, [form, addTurn]);

  const submitRevision = useCallback(
    async (instruction: string) => {
      if (!lastReceiptToken) return;

      addTurn({ id: nanoid(), kind: "user_revision", label: instruction });
      setLoading(true);

      const doRequest = async () => {
        try {
          const res = await apiFetch("/api/v1/legal/draft/revise", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              draft_receipt_token: lastReceiptToken,
              revision_instruction: instruction,
            }),
          });

          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            const msg = body.message ?? body.error ?? `Server returned ${res.status}`;
            addTurn({
              id: nanoid(),
              kind: "error",
              errorMessage: `Revision failed: ${msg}`,
              errorRetryFn: doRequest,
            });
            return;
          }

          const data: DraftApiResponse = await res.json();
          setLastReceiptToken(data.draft_receipt_token);
          addTurn({ id: nanoid(), kind: "revision_result", data });
        } catch (err) {
          addTurn({
            id: nanoid(),
            kind: "error",
            errorMessage: `Network error: ${err instanceof Error ? err.message : String(err)}`,
            errorRetryFn: doRequest,
          });
        } finally {
          setLoading(false);
        }
      };

      await doRequest();
    },
    [lastReceiptToken, addTurn]
  );

  const handleFormChange = useCallback((patch: Partial<IntakeFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  return (
    <Layout>
      <PageHeader
        title="Startup Counsel"
        subtitle="Deterministic legal drafting — co-founder, contractor IP, advisor agreements"
      />

      {/* Disclaimer banner */}
      <DisclaimerBanner />

      {/* Two-column layout: thread left, composer right */}
      <div className="flex h-[calc(100vh-8.5rem)] overflow-hidden">
        {/* ── Thread (left) ── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
          {turns.length === 0 ? (
            <EmptyState />
          ) : (
            turns.map((turn) => (
              <div key={turn.id}>
                {/* User intake bubble */}
                {turn.kind === "user_intake" && (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                      <p className="text-[9px] font-mono text-primary/60 uppercase tracking-widest mb-0.5">
                        Draft request
                      </p>
                      <p className="text-xs font-mono text-foreground">{turn.label}</p>
                    </div>
                  </div>
                )}

                {/* User revision bubble */}
                {turn.kind === "user_revision" && (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] bg-secondary/50 border border-border rounded-lg px-3 py-2">
                      <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-0.5">
                        Revision instruction
                      </p>
                      <p className="text-xs font-mono text-foreground">{turn.label}</p>
                    </div>
                  </div>
                )}

                {/* Draft result */}
                {turn.kind === "draft_result" && turn.data && (
                  <div className="bg-card border border-border rounded-lg p-4">
                    <DraftResultCard data={turn.data} label="Draft" />
                  </div>
                )}

                {/* Revision result */}
                {turn.kind === "revision_result" && turn.data && (
                  <div className="bg-card border border-primary/20 rounded-lg p-4">
                    <DraftResultCard data={turn.data} label="Revised Draft" />
                  </div>
                )}

                {/* Error */}
                {turn.kind === "error" && (
                  <ErrorCard
                    message={turn.errorMessage ?? "Unknown error"}
                    onRetry={turn.errorRetryFn}
                  />
                )}
              </div>
            ))
          )}

          {/* Loading indicator in thread */}
          {loading && (
            <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded text-xs font-mono text-primary">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Processing…
            </div>
          )}

          <div ref={threadEndRef} />
        </div>

        {/* ── Composer (right) ── */}
        <div className="w-80 shrink-0 border-l border-border bg-card overflow-y-auto p-4 space-y-4">
          {/* Intake form — always visible for new drafts */}
          <IntakeForm
            form={form}
            onChange={handleFormChange}
            onSubmit={submitDraft}
            loading={loading}
          />

          {/* Revision composer — appears after first successful draft */}
          {lastReceiptToken && (
            <>
              <div className="border-t border-border pt-4">
                <RevisionComposer onSubmit={submitRevision} loading={loading} />
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
