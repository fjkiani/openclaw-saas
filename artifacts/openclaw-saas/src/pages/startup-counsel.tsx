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
  ScanText,
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


// ── Analyze feature types ─────────────────────────────────────────────────────

interface UncertainField {
  field: string;
  extracted_value: unknown;
  confidence: number;
  reason: string;
}

interface NormalizationNote {
  field: string;
  raw_value: unknown;
  normalized_value: unknown;
  reason: string;
}

interface MissingRequiredField {
  field: string;
  required_by: "schema" | "escalation_trigger";
  blocking: boolean;
  review_threshold: ReviewThreshold;
  risk_if_absent: string;
}

interface AnalyzeApiResponse {
  analysis_id: string;
  doc_class: DocClass;
  source: {
    length: number;
    hash: string;
    text: string;
  };
  // Extraction
  raw_extracted_intake: Record<string, unknown>;
  extraction_confidence: number;
  // Normalization
  normalized_intake: Record<string, unknown>;
  normalization_notes: NormalizationNote[];
  normalization_summary: { substitutions_made: number; warnings_present: boolean };
  not_applicable_fields: string[];
  missing_required_fields: MissingRequiredField[];
  uncertain_fields: UncertainField[];
  // Draft pipeline
  draft_ready_intake: Record<string, unknown>;
  sections: DraftSection[];
  assumptions: string[];
  missing_decision_prompts: MissingDecisionPrompt[];
  verifier: {
    passed: boolean;
    missing_data: Array<{ field: string; impact: string; review_threshold?: ReviewThreshold }>;
    legal_conflicts: Array<{ conflict_id: string; description: string; sections_involved: string[]; severity: string; review_threshold?: ReviewThreshold }>;
    template_failures: Array<{ failure_id: string; section: string; detail: string; severity: string; review_threshold?: ReviewThreshold }>;
    jurisdiction_escalations: Array<{ flag_id: string; jurisdiction: string; section: string; description: string; severity: string; recommended_action: string; review_threshold?: ReviewThreshold }>;
  };
  governance: {
    review_threshold: ReviewThreshold;
    artifact_status: string;
    not_legal_advice: boolean;
    privilege_warning: string;
  };
  redraft_available: boolean;
  trace: {
    latency_ms: number;
    model_used: string;
    fallback_used: boolean;
  };
}

type AnalyzeTurnKind = "user_analyze" | "analyze_result" | "analyze_error";

interface AnalyzeTurn {
  id: string;
  kind: AnalyzeTurnKind;
  label?: string;
  data?: AnalyzeApiResponse;
  errorMessage?: string;
  errorRetryFn?: () => void;
}

// ── AnalyzeComposer ───────────────────────────────────────────────────────────

const DOC_CLASS_OPTIONS: { value: DocClass; label: string }[] = [
  { value: "co_founder_agreement",     label: "Co-Founder Agreement" },
  { value: "contractor_ip_assignment", label: "Contractor IP Assignment" },
  { value: "advisor_agreement",        label: "Advisor Agreement" },
];

function AnalyzeComposer({
  onSubmit,
  loading,
}: {
  onSubmit: (text: string, docClass: DocClass) => void;
  loading: boolean;
}) {
  const [contractText, setContractText] = useState("");
  const [docClass, setDocClass] = useState<DocClass | "">("");

  const canSubmit = contractText.length >= 50 && docClass !== "" && !loading;

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest mb-1.5">
          Contract Text
        </label>
        <Textarea
          rows={12}
          placeholder="Paste contract text here…"
          value={contractText}
          onChange={(e) => setContractText(e.target.value)}
          className="text-xs font-mono resize-none"
        />
        <p className="text-[9px] font-mono text-muted-foreground mt-1">
          {contractText.length.toLocaleString()} chars
          {contractText.length > 0 && contractText.length < 50 && (
            <span className="text-amber-500 ml-1">(min 50)</span>
          )}
        </p>
      </div>

      <div>
        <label className="block text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest mb-1.5">
          Document Type
        </label>
        <div className="space-y-1.5">
          {DOC_CLASS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 cursor-pointer group"
            >
              <input
                type="radio"
                name="analyze-doc-class"
                value={opt.value}
                checked={docClass === opt.value}
                onChange={() => setDocClass(opt.value)}
                className="accent-primary"
              />
              <span className="text-xs font-mono text-foreground group-hover:text-primary transition-colors">
                {opt.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <Button
        className="w-full text-xs font-mono"
        onClick={() => canSubmit && onSubmit(contractText, docClass as DocClass)}
        disabled={!canSubmit}
      >
        {loading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            Analyzing…
          </>
        ) : (
          <>
            <ScanText className="w-3.5 h-3.5 mr-1.5" />
            Analyze Contract
          </>
        )}
      </Button>
    </div>
  );
}

// ── AnalysisResultCard ────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 70 ? "bg-green-500/10 text-green-600 border-green-500/20" :
    pct >= 40 ? "bg-amber-500/10 text-amber-600 border-amber-500/20" :
                "bg-red-500/10 text-red-500 border-red-500/20";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono border ${color}`}>
      {pct}% confidence
    </span>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {title}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-2">{children}</div>}
    </div>
  );
}

function AnalysisResultCard({
  data,
  onGenerateDraft,
  generatingDraft,
}: {
  data: AnalyzeApiResponse;
  onGenerateDraft: (intake: Record<string, unknown>) => void;
  generatingDraft: boolean;
}) {
  const docLabel = DOC_CLASS_OPTIONS.find((o) => o.value === data.doc_class)?.label ?? data.doc_class;

  const rawIntake  = data.raw_extracted_intake;
  const parties    = (rawIntake as any)?.parties as Array<{ name: string; role: string; entity_type?: string }> | undefined;
  const equity     = (rawIntake as any)?.equity as Record<string, unknown> | undefined;
  const ip         = (rawIntake as any)?.ip as Record<string, unknown> | undefined;
  const advisory   = (rawIntake as any)?.advisory as Record<string, unknown> | undefined;
  const jurisdiction = (rawIntake as any)?.jurisdiction as string | undefined;

  const normJurisdiction = (data.normalized_intake as any)?.jurisdiction as string | undefined;
  const hasIncompleteSplit = data.normalization_notes.some((n) => n.field === "equity.split");

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[9px] font-mono">{docLabel}</Badge>
          <ConfidenceBadge confidence={data.extraction_confidence} />
          {data.normalization_summary.substitutions_made > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-blue-500/10 text-blue-600 border border-blue-500/20">
              {data.normalization_summary.substitutions_made} normalized
            </span>
          )}
        </div>
        <span className="text-[9px] font-mono text-muted-foreground">
          {data.trace.model_used.split("/").pop()}
          {data.trace.fallback_used && " · fallback"}
          {" · "}{data.trace.latency_ms}ms
        </span>
      </div>

      {/* 1. Extracted Structure */}
      <CollapsibleSection title="Extracted Structure" defaultOpen>
        <div className="space-y-2 text-xs font-mono">
          {jurisdiction && (
            <div className="flex gap-2 items-start">
              <span className="text-muted-foreground w-20 shrink-0">Jurisdiction</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-foreground">{jurisdiction}</span>
                {normJurisdiction && normJurisdiction !== jurisdiction && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/10 text-amber-600 border border-amber-500/20">
                    → {normJurisdiction}
                  </span>
                )}
              </div>
            </div>
          )}

          {parties && parties.length > 0 && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">Parties</p>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-normal pb-0.5">Name</th>
                    <th className="text-left font-normal pb-0.5">Role</th>
                    <th className="text-left font-normal pb-0.5">Entity</th>
                  </tr>
                </thead>
                <tbody>
                  {parties.map((p, i) => (
                    <tr key={i}>
                      <td className="pr-2">{p.name}</td>
                      <td className="pr-2 text-muted-foreground">{p.role}</td>
                      <td className="text-muted-foreground">{p.entity_type ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {equity && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">Equity (raw)</p>
              <div className="space-y-0.5 text-[10px]">
                {equity.vesting_years != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Vesting</span>
                    <span>{String(equity.vesting_years)} years</span>
                  </div>
                )}
                {equity.cliff_months != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Cliff</span>
                    <span>{String(equity.cliff_months)} months</span>
                  </div>
                )}
                {equity.acceleration != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Acceleration</span>
                    <span>{String(equity.acceleration)}</span>
                  </div>
                )}
                {equity.split != null && (
                  <div className="flex gap-2 items-start">
                    <span className="text-muted-foreground w-20 shrink-0">Split</span>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(equity.split as Record<string, number>).map(([name, pct]) => (
                        <span key={name} className="text-foreground">{name}: {pct}%</span>
                      ))}
                      {hasIncompleteSplit && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/10 text-amber-600 border border-amber-500/20">
                          incomplete extraction
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {ip && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">IP (raw)</p>
              <div className="space-y-0.5 text-[10px]">
                {ip.scope != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Scope</span>
                    <span>{String(ip.scope)}</span>
                  </div>
                )}
                {Array.isArray(ip.prior_inventions) && (ip.prior_inventions as string[]).length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Prior inv.</span>
                    <span>{(ip.prior_inventions as string[]).join(", ")}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {advisory && (
            <div>
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">Advisory (raw)</p>
              <div className="space-y-0.5 text-[10px]">
                {advisory.equity_pct != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Equity</span>
                    <span>{String(advisory.equity_pct)}%</span>
                  </div>
                )}
                {advisory.services_description != null && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Services</span>
                    <span className="truncate">{String(advisory.services_description)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* 2. Normalized Intake */}
      <CollapsibleSection title="Normalized Intake" defaultOpen>
        <div className="space-y-2">
          {data.normalization_notes.length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Substitutions</p>
              <div className="space-y-1">
                {data.normalization_notes.map((n, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px] font-mono">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20 shrink-0">
                      {n.field}
                    </span>
                    <span className="text-muted-foreground">{n.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.missing_required_fields.filter((f) => f.required_by === "schema").length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
                Missing — schema required
              </p>
              <div className="flex flex-wrap gap-1">
                {data.missing_required_fields
                  .filter((f) => f.required_by === "schema")
                  .map((f) => (
                    <span
                      key={f.field}
                      title={f.risk_if_absent}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-red-500/10 text-red-500 border border-red-500/20 cursor-help"
                    >
                      {f.field} · blocks draft
                    </span>
                  ))}
              </div>
            </div>
          )}

          {data.missing_required_fields.filter((f) => f.required_by === "escalation_trigger").length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
                Missing — policy required
              </p>
              <div className="flex flex-wrap gap-1">
                {data.missing_required_fields
                  .filter((f) => f.required_by === "escalation_trigger")
                  .map((f) => (
                    <span
                      key={f.field}
                      title={f.risk_if_absent}
                      className={[
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono border cursor-help",
                        f.blocking
                          ? "bg-red-500/10 text-red-500 border-red-500/20"
                          : "bg-amber-500/10 text-amber-600 border-amber-500/20",
                      ].join(" ")}
                    >
                      {f.field} · {f.blocking ? "blocks draft" : f.review_threshold}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {data.uncertain_fields.length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">Uncertain</p>
              <div className="flex flex-wrap gap-1">
                {data.uncertain_fields.map((uf) => (
                  <span
                    key={uf.field}
                    title={uf.reason}
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/10 text-amber-600 border border-amber-500/20 cursor-help"
                  >
                    {uf.field} · {Math.round(uf.confidence * 100)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {data.not_applicable_fields.length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-1">
                Not applicable for {docLabel}
              </p>
              <div className="flex flex-wrap gap-1">
                {data.not_applicable_fields.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-muted text-muted-foreground border border-border"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {data.normalization_notes.length === 0 &&
           data.missing_required_fields.length === 0 &&
           data.uncertain_fields.length === 0 &&
           data.not_applicable_fields.length === 0 && (
            <p className="text-[10px] font-mono text-green-600">Extraction clean — no normalization needed</p>
          )}
        </div>
      </CollapsibleSection>

      {/* 3. Governance + Verification */}
      <CollapsibleSection title="Governance + Verification" defaultOpen>
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <ThresholdBadge threshold={data.governance.review_threshold} />
            <Badge variant="outline" className="text-[9px] font-mono">{data.governance.artifact_status}</Badge>
          </div>
          <div className="flex items-start gap-1.5 text-[10px] font-mono text-muted-foreground">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{data.governance.privilege_warning}</span>
          </div>

          {!data.verifier.passed && (
            <div className="space-y-1">
              {data.verifier.template_failures.map((f) => (
                <div key={f.failure_id} className="flex items-start gap-1.5 text-[10px] font-mono">
                  <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                  <span className="text-foreground">{f.section}: {f.detail}</span>
                </div>
              ))}
              {data.verifier.legal_conflicts.map((f) => (
                <div key={f.conflict_id} className="flex items-start gap-1.5 text-[10px] font-mono">
                  <AlertTriangle className="w-3 h-3 text-red-500 mt-0.5 shrink-0" />
                  <span className="text-foreground">
                    {f.conflict_id === "EQUITY_SPLIT_NOT_100" && hasIncompleteSplit
                      ? `Incomplete extraction — ${f.description}`
                      : f.description}
                  </span>
                </div>
              ))}
              {data.verifier.jurisdiction_escalations.map((f) => (
                <div key={f.flag_id} className="flex items-start gap-1.5 text-[10px] font-mono">
                  <ShieldAlert className="w-3 h-3 text-red-500 mt-0.5 shrink-0" />
                  <span className="text-foreground">{f.description}</span>
                </div>
              ))}
              {data.verifier.missing_data.map((f, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[10px] font-mono">
                  <Info className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{f.field}: {f.impact}</span>
                </div>
              ))}
            </div>
          )}
          {data.verifier.passed && (
            <p className="text-[10px] font-mono text-green-600">Verifier passed</p>
          )}

          {data.missing_decision_prompts.length > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-border">
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">
                Decisions needed
              </p>
              {data.missing_decision_prompts.map((p) => (
                <div key={p.field} className="p-2 bg-muted/30 rounded space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <ThresholdBadge threshold={p.review_threshold} />
                    <span className="text-[10px] font-mono font-semibold text-foreground">{p.question}</span>
                  </div>
                  <p className="text-[9px] font-mono text-muted-foreground">{p.why_it_matters}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* 4. Assumptions */}
      {data.assumptions.length > 0 && (
        <CollapsibleSection title="Assumptions">
          <ul className="space-y-0.5">
            {data.assumptions.map((a, i) => (
              <li key={i} className="text-[10px] font-mono text-muted-foreground flex gap-1.5">
                <span className="text-primary/60 shrink-0">·</span>
                {a}
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      {/* 5. Source Text */}
      <CollapsibleSection title="Source Text">
        <pre className="text-[9px] font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-72 overflow-y-auto leading-relaxed">
          {data.source.text}
        </pre>
        <p className="text-[9px] font-mono text-muted-foreground/60 mt-1">
          {data.source.length.toLocaleString()} chars · sha256:{data.source.hash}
        </p>
      </CollapsibleSection>

      {/* Generate Clean Draft */}
      {data.redraft_available && (
        <div className="pt-1 border-t border-border">
          <Button
            className="w-full text-xs font-mono"
            variant="outline"
            onClick={() => onGenerateDraft(data.draft_ready_intake)}
            disabled={generatingDraft}
          >
            {generatingDraft ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                Generate Clean Draft from Extracted Fields
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Analyze empty state ───────────────────────────────────────────────────────

function AnalyzeEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
        <ScanText className="w-6 h-6 text-primary" />
      </div>
      <h3 className="text-sm font-mono font-bold text-foreground mb-2">Analyze Contract</h3>
      <p className="text-xs font-mono text-muted-foreground max-w-sm mb-4 leading-relaxed">
        Paste an existing contract to extract structured fields, run governance checks,
        and optionally generate a clean library-backed redraft.
      </p>
      <p className="text-[9px] font-mono text-muted-foreground/60 max-w-xs">
        Paste contract text and select a document type on the right to begin.
      </p>
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
  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"draft" | "analyze">("draft");

  // ── Draft tab state ─────────────────────────────────────────────────────────
  const [turns, setTurns] = useState<Turn[]>([]);
  const [form, setForm] = useState<IntakeFormState>(DEFAULT_INTAKE);
  const [loading, setLoading] = useState(false);
  const [lastReceiptToken, setLastReceiptToken] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // ── Analyze tab state ───────────────────────────────────────────────────────
  const [analyzeTurns, setAnalyzeTurns] = useState<AnalyzeTurn[]>([]);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const analyzeThreadEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new turn
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  useEffect(() => {
    analyzeThreadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [analyzeTurns]);

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

  const addAnalyzeTurn = useCallback((turn: AnalyzeTurn) => {
    setAnalyzeTurns((prev) => [...prev, turn]);
  }, []);

  const submitAnalyze = useCallback(
    async (contractText: string, docClass: DocClass) => {
      addAnalyzeTurn({
        id: nanoid(),
        kind: "user_analyze",
        label: `${DOC_CLASS_OPTIONS.find((o) => o.value === docClass)?.label ?? docClass} · ${contractText.length.toLocaleString()} chars`,
      });
      setAnalyzeLoading(true);

      const doRequest = async () => {
        try {
          const res = await apiFetch("/api/v1/legal/draft/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contract_text: contractText, doc_class: docClass }),
          });

          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            const msg = body.message ?? body.error ?? `Server returned ${res.status}`;
            addAnalyzeTurn({
              id: nanoid(),
              kind: "analyze_error",
              errorMessage: `Analysis failed: ${msg}`,
              errorRetryFn: doRequest,
            });
            return;
          }

          const data: AnalyzeApiResponse = await res.json();
          addAnalyzeTurn({ id: nanoid(), kind: "analyze_result", data });
        } catch (err) {
          addAnalyzeTurn({
            id: nanoid(),
            kind: "analyze_error",
            errorMessage: `Network error: ${err instanceof Error ? err.message : String(err)}`,
            errorRetryFn: doRequest,
          });
        } finally {
          setAnalyzeLoading(false);
        }
      };

      await doRequest();
    },
    [addAnalyzeTurn]
  );

  const generateDraftFromAnalysis = useCallback(
    async (intake: Record<string, unknown>) => {
      setGeneratingDraft(true);
      try {
        const res = await apiFetch("/api/v1/legal/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intake),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          const msg = body.message ?? body.error ?? `Server returned ${res.status}`;
          addTurn({ id: nanoid(), kind: "error", errorMessage: `Draft failed: ${msg}` });
        } else {
          const data: DraftApiResponse = await res.json();
          setLastReceiptToken(data.draft_receipt_token);
          addTurn({ id: nanoid(), kind: "draft_result", data });
        }
      } catch (err) {
        addTurn({
          id: nanoid(),
          kind: "error",
          errorMessage: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setGeneratingDraft(false);
        setActiveTab("draft");
      }
    },
    [addTurn]
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

      {/* Tab bar */}
      <div className="flex border-b border-border px-4 bg-background">
        {(["draft", "analyze"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={[
              "px-4 py-2 text-[11px] font-mono font-semibold uppercase tracking-widest border-b-2 transition-colors",
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {tab === "draft" ? "Generate Draft" : "Analyze Contract"}
          </button>
        ))}
      </div>

      {/* Two-column layout: thread left, composer right */}
      <div className="flex h-[calc(100vh-10rem)] overflow-hidden">

        {/* ══ DRAFT TAB ══════════════════════════════════════════════════════ */}
        {activeTab === "draft" && (
          <>
            {/* Thread (left) */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
              {turns.length === 0 ? (
                <EmptyState />
              ) : (
                turns.map((turn) => (
                  <div key={turn.id}>
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
                    {turn.kind === "draft_result" && turn.data && (
                      <div className="bg-card border border-border rounded-lg p-4">
                        <DraftResultCard data={turn.data} label="Draft" />
                      </div>
                    )}
                    {turn.kind === "revision_result" && turn.data && (
                      <div className="bg-card border border-primary/20 rounded-lg p-4">
                        <DraftResultCard data={turn.data} label="Revised Draft" />
                      </div>
                    )}
                    {turn.kind === "error" && (
                      <ErrorCard
                        message={turn.errorMessage ?? "Unknown error"}
                        onRetry={turn.errorRetryFn}
                      />
                    )}
                  </div>
                ))
              )}
              {loading && (
                <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded text-xs font-mono text-primary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Processing…
                </div>
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Composer (right) */}
            <div className="w-80 shrink-0 border-l border-border bg-card overflow-y-auto p-4 space-y-4">
              <IntakeForm
                form={form}
                onChange={handleFormChange}
                onSubmit={submitDraft}
                loading={loading}
              />
              {lastReceiptToken && (
                <div className="border-t border-border pt-4">
                  <RevisionComposer onSubmit={submitRevision} loading={loading} />
                </div>
              )}
            </div>
          </>
        )}

        {/* ══ ANALYZE TAB ════════════════════════════════════════════════════ */}
        {activeTab === "analyze" && (
          <>
            {/* Thread (left) */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
              {analyzeTurns.length === 0 ? (
                <AnalyzeEmptyState />
              ) : (
                analyzeTurns.map((turn) => (
                  <div key={turn.id}>
                    {turn.kind === "user_analyze" && (
                      <div className="flex justify-end">
                        <div className="max-w-[80%] bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                          <p className="text-[9px] font-mono text-primary/60 uppercase tracking-widest mb-0.5">
                            Analyze request
                          </p>
                          <p className="text-xs font-mono text-foreground">{turn.label}</p>
                        </div>
                      </div>
                    )}
                    {turn.kind === "analyze_result" && turn.data && (
                      <div className="bg-card border border-border rounded-lg p-4">
                        <AnalysisResultCard
                          data={turn.data}
                          onGenerateDraft={generateDraftFromAnalysis}
                          generatingDraft={generatingDraft}
                        />
                      </div>
                    )}
                    {turn.kind === "analyze_error" && (
                      <ErrorCard
                        message={turn.errorMessage ?? "Unknown error"}
                        onRetry={turn.errorRetryFn}
                      />
                    )}
                  </div>
                ))
              )}
              {analyzeLoading && (
                <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded text-xs font-mono text-primary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Extracting…
                </div>
              )}
              <div ref={analyzeThreadEndRef} />
            </div>

            {/* Composer (right) */}
            <div className="w-80 shrink-0 border-l border-border bg-card overflow-y-auto p-4 space-y-4">
              <AnalyzeComposer onSubmit={submitAnalyze} loading={analyzeLoading} />
            </div>
          </>
        )}

      </div>
    </Layout>
  );
}
