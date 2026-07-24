/**
 * ControlRoom.tsx — the dense ops dashboard for the Krios factory.
 *
 * Four panels, all fed by the SAME shared live source as the Factory Floor:
 *   • KPI tiles          — in-flight, queue depth, runs/min, promotions, failures, pass rate.
 *   • In-flight runs      — table of live Krios runs (goal, bucket, stage/step, status).
 *                          Selecting a row opens the real run transcript with per-step
 *                          Approve / Reject (for awaiting_approval) and Cancel — reusing the
 *                          platform's OWN agent hooks (useAgentRunDetail / useApproveAgentStep /
 *                          useCancelAgentRun), so every action is a real endpoint round-trip.
 *   • Queue               — actionable work-items the conductor will launch next.
 *   • Live event log      — auto-scrolling feed straight off the SSE stream.
 *
 * Read-only panels work without a token; Approve/Reject/Cancel need the admin token
 * (localStorage "openclaw-admin-token", shared with the status bar + Agent Console).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Boxes,
  CheckCircle2,
  Clock,
  GaugeCircle,
  Layers,
  ListChecks,
  Loader2,
  PauseCircle,
  Rocket,
  ScrollText,
  ShieldAlert,
  SkipForward,
  Terminal,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useAgentRunDetail,
  useApproveAgentStep,
  useCancelAgentRun,
  type AgentRunStatus,
  type AgentStepStatus,
} from "@/pages/intelligence/workflow-hooks";
import {
  EVENT_KIND_LABELS,
  STAGE_COLORS,
  STAGE_LABELS,
  eventSummary,
  type KriosEvent,
  type KriosEventKind,
  type KriosInflight,
  type KriosState,
  type UseKriosStreamResult,
} from "./useKrios";

const ADMIN_TOKEN_KEY = "openclaw-admin-token";

// ── status colours (aligned with agent-console) ───────────────────────────────
function statusColor(s: AgentRunStatus | AgentStepStatus | string): string {
  switch (s) {
    case "completed":
    case "done":
      return "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
    case "failed":
      return "text-red-400 border-red-500/40 bg-red-500/10";
    case "awaiting_approval":
      return "text-amber-400 border-amber-500/40 bg-amber-500/10";
    case "running":
    case "planning":
      return "text-sky-400 border-sky-500/40 bg-sky-500/10";
    default:
      return "text-zinc-400 border-zinc-500/40 bg-zinc-500/10";
  }
}
function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusColor(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
function StepIcon({ status }: { status: AgentStepStatus }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-sky-400" />;
    case "awaiting_approval":
      return <PauseCircle className="h-4 w-4 text-amber-400" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-zinc-400" />;
    default:
      return <Clock className="h-4 w-4 text-zinc-400" />;
  }
}

// ── KPI tile ───────────────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  icon: Icon,
  tone = "text-foreground",
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-background/60 px-3 py-2" data-testid={`krios-kpitile-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <Icon className={`h-4 w-4 ${tone}`} aria-hidden="true" />
      <div className="leading-tight">
        <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

// ── live event log (auto-scrolls to newest) ────────────────────────────────────
const KIND_TONE: Record<KriosEventKind, string> = {
  tick: "text-zinc-500",
  queued: "text-sky-400",
  launched: "text-sky-300",
  step_done: "text-foreground/80",
  awaiting_approval: "text-amber-400",
  promoted: "text-emerald-400",
  trained: "text-orange-400",
  certified: "text-violet-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  skipped: "text-zinc-500",
};

function EventLog({ events }: { events: KriosEvent[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (stick) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events, stick]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStick(atBottom);
  }

  const shown = events.slice(-200);
  return (
    <Card className="flex h-[420px] flex-col p-0" data-testid="krios-event-log">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <ScrollText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">Live event log</span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{events.length} events</span>
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {shown.length === 0 && (
          <p className="px-1 py-4 text-center text-muted-foreground">
            Waiting for factory events… start the factory or Kick a pass.
          </p>
        )}
        {shown.map((e) => (
          <div key={e.id} className="flex gap-2 border-b border-border/40 py-1" data-testid="krios-event-row">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {new Date(e.ts).toLocaleTimeString()}
            </span>
            <span className={`shrink-0 font-semibold ${KIND_TONE[e.kind] ?? "text-foreground"}`}>
              {EVENT_KIND_LABELS[e.kind] ?? e.kind}
            </span>
            {e.stage && (
              <span className="shrink-0" style={{ color: STAGE_COLORS[e.stage] }}>
                [{STAGE_LABELS[e.stage]}]
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-foreground/80">{eventSummary(e)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {!stick && (
        <button
          type="button"
          onClick={() => {
            setStick(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          className="border-t border-border py-1 text-[11px] text-sky-400 hover:bg-sky-500/5"
        >
          ↓ Jump to newest
        </button>
      )}
    </Card>
  );
}

// ── in-flight run transcript (reuses the platform's OWN agent hooks) ───────────
function RunTranscript({ runId, adminToken }: { runId: string; adminToken?: string }) {
  const detail = useAgentRunDetail(runId);
  const approve = useApproveAgentStep(adminToken);
  const cancel = useCancelAgentRun(adminToken);
  const run = detail.data?.run;

  if (!run) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
      </div>
    );
  }
  const steps = run.steps ?? [];
  return (
    <div className="space-y-3 p-4" data-testid="krios-run-transcript">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{run.id.slice(0, 8)}</code>
          <StatusBadge status={run.status} />
        </div>
        {(run.status === "running" || run.status === "awaiting_approval" || run.status === "planning") && (
          <Button variant="outline" size="sm" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending} data-testid="krios-run-cancel">
            Cancel
          </Button>
        )}
      </div>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <li
            key={s.idx}
            className={`rounded-md border p-2.5 ${s.status === "awaiting_approval" ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}
            data-testid={`krios-run-step-${s.idx}`}
          >
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5">
                <StepIcon status={s.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">#{s.idx}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{s.action_type}</code>
                  <StatusBadge status={s.status} />
                  {s.requires_approval && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                      <ShieldAlert className="h-3 w-3" /> gated
                    </span>
                  )}
                </div>
                {s.result?.summary && <p className="mt-1 text-xs text-foreground/90">{s.result.summary}</p>}
                {s.error && <p className="mt-1 text-xs text-red-400">{s.error}</p>}
                {s.status === "awaiting_approval" && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => approve.mutate({ runId: run.id, step_idx: s.idx, decision: "approve" })}
                      disabled={approve.isPending}
                      className="h-7 gap-1 bg-emerald-600 hover:bg-emerald-700"
                      data-testid={`krios-approve-${s.idx}`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => approve.mutate({ runId: run.id, step_idx: s.idx, decision: "reject" })}
                      disabled={approve.isPending}
                      className="h-7 gap-1"
                      data-testid={`krios-reject-${s.idx}`}
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── in-flight runs table ───────────────────────────────────────────────────────
function InflightTable({
  runs,
  selected,
  onSelect,
}: {
  runs: KriosInflight[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto" data-testid="krios-inflight-table">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Bucket</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Step</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                No runs in flight.
              </td>
            </tr>
          )}
          {runs.map((r) => (
            <tr
              key={r.run_id}
              onClick={() => onSelect(r.run_id)}
              className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-secondary/40 ${r.run_id === selected ? "bg-sky-500/5" : ""}`}
              data-testid="krios-inflight-row"
              data-run-id={r.run_id}
            >
              <td className="px-3 py-2">
                <div className="font-mono text-xs">
                  {r.mcp_slug ?? "—"}
                  {r.tool_name ? <span className="text-muted-foreground">/{r.tool_name}</span> : ""}
                </div>
              </td>
              <td className="px-3 py-2">
                <span className="text-[11px] font-medium" style={{ color: STAGE_COLORS[r.stage] }}>
                  {STAGE_LABELS[r.stage]}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums text-muted-foreground">
                {r.current_step}/{r.total_steps}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ControlRoom({
  state,
  stream,
}: {
  state?: KriosState;
  stream: UseKriosStreamResult;
}) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const adminToken = typeof window !== "undefined" ? localStorage.getItem(ADMIN_TOKEN_KEY) || undefined : undefined;

  const runs = state?.in_flight ?? [];
  const kpis = state?.kpis;
  const queue = state?.queue ?? [];

  // Auto-select the first awaiting_approval run (the one needing a human), else
  // the first in-flight run, so the transcript panel is useful without a click.
  useEffect(() => {
    if (selected && runs.some((r) => r.run_id === selected)) return;
    const gated = runs.find((r) => r.status === "awaiting_approval");
    setSelected((gated ?? runs[0])?.run_id);
  }, [runs, selected]);

  const selectedRun = useMemo(() => runs.find((r) => r.run_id === selected), [runs, selected]);

  return (
    <div className="space-y-4" data-testid="krios-controlroom">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="In flight" value={kpis?.in_flight ?? runs.length} icon={Boxes} tone="text-sky-400" />
        <KpiTile label="Queue" value={kpis?.queue_depth ?? queue.length} icon={Layers} />
        <KpiTile label="Runs / min" value={kpis ? kpis.runs_per_min.toFixed(2) : "—"} icon={Activity} />
        <KpiTile label="Promotions" value={kpis?.promotions_today ?? 0} icon={Rocket} tone="text-emerald-400" />
        <KpiTile label="Failures" value={kpis?.failures_today ?? 0} icon={GaugeCircle} tone={(kpis?.failures_today ?? 0) > 0 ? "text-red-400" : "text-foreground"} />
        <KpiTile label="Pass rate" value={kpis ? `${Math.round(kpis.pass_rate * 100)}%` : "—"} icon={CheckCircle2} tone="text-emerald-400" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* left column: in-flight runs + transcript */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium">In-flight runs</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{runs.length}</span>
            </div>
            <InflightTable runs={runs} selected={selected} onSelect={setSelected} />
          </Card>

          {selectedRun && (
            <Card className="p-0">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium">Run transcript</span>
                <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                  {selectedRun.goal}
                </span>
              </div>
              <RunTranscript runId={selectedRun.run_id} adminToken={adminToken} />
            </Card>
          )}
        </div>

        {/* right column: queue + live log */}
        <div className="space-y-4">
          <Card className="p-0" data-testid="krios-queue">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium">Queue</span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{queue.length}</span>
            </div>
            <div className="max-h-[160px] overflow-y-auto p-2">
              {queue.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">Queue empty.</p>
              )}
              {queue.map((q, i) => (
                <div
                  key={`${q.mcp_slug}/${q.tool_name}/${i}`}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 text-xs"
                  data-testid="krios-queue-row"
                >
                  <span
                    className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      q.kind === "train" ? "bg-orange-500/10 text-orange-400" : "bg-sky-500/10 text-sky-400"
                    }`}
                  >
                    {q.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {q.mcp_slug}
                    {q.tool_name ? `/${q.tool_name}` : ""}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{q.reason}</span>
                </div>
              ))}
            </div>
          </Card>

          <EventLog events={stream.events} />
        </div>
      </div>
    </div>
  );
}

export default ControlRoom;
