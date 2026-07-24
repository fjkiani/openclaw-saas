/**
 * FactoryFloor.tsx — the animated production line.
 *
 * Seven horizontal stage lanes (Inspect → Loop → Judge → Regress → Promote →
 * Train → Deploy). Each in-flight Krios run renders as a TOKEN placed in the lane
 * of its current step; as the executor advances the run (live `step_done` events),
 * the token moves lane-to-lane. Terminal events (`promoted`/`completed`) flash a
 * token through Deploy. A lane PULSES briefly when a fresh event lands in it, so
 * the floor visibly "runs" even at a glance. A KPI strip sits on top.
 *
 * Data source: the shared `useKriosStream()` (SSE, poll fallback) for live motion
 * + `useKriosState()` for the authoritative in-flight/queue/KPI snapshot. Tokens
 * are derived from real runs — never fabricated.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Boxes, CheckCircle2, Factory, GaugeCircle, Layers, Rocket } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/Layout";
import {
  KRIOS_STAGES,
  STAGE_COLORS,
  STAGE_LABELS,
  eventSummary,
  type KriosEvent,
  type KriosInflight,
  type KriosStage,
  type KriosState,
  type UseKriosStreamResult,
} from "./useKrios";

// ── KPI strip ────────────────────────────────────────────────────────────────
function Kpi({
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
    <Card className="flex items-center gap-3 px-4 py-3" data-testid={`krios-kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <Icon className={`h-5 w-5 ${tone}`} aria-hidden="true" />
      <div className="leading-tight">
        <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

// ── A single work-item token ───────────────────────────────────────────────────
function Token({ run }: { run: KriosInflight }) {
  const bucket = run.mcp_slug ? `${run.mcp_slug}${run.tool_name ? `/${run.tool_name}` : ""}` : run.run_id.slice(0, 8);
  const short = bucket.length > 26 ? `…${bucket.slice(-25)}` : bucket;
  const gated = run.status === "awaiting_approval";
  return (
    <div
      className={`group relative flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono shadow-sm transition-all duration-500 ${
        gated
          ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
          : "border-border bg-background/80 text-foreground"
      }`}
      style={{ borderLeftColor: STAGE_COLORS[run.stage], borderLeftWidth: 3 }}
      data-testid="krios-token"
      data-run-id={run.run_id}
      data-stage={run.stage}
      title={`${bucket} — step ${run.current_step}/${run.total_steps} (${run.status})`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${gated ? "bg-amber-400 animate-pulse" : "animate-pulse"}`}
        style={{ background: gated ? undefined : STAGE_COLORS[run.stage] }}
        aria-hidden="true"
      />
      <span className="max-w-[150px] truncate">{short}</span>
      <span className="shrink-0 text-muted-foreground">
        {run.current_step}/{run.total_steps}
      </span>
    </div>
  );
}

// ── One stage lane ───────────────────────────────────────────────────────────
function Lane({
  stage,
  runs,
  count,
  pulsing,
}: {
  stage: KriosStage;
  runs: KriosInflight[];
  count: number;
  pulsing: boolean;
}) {
  const color = STAGE_COLORS[stage];
  return (
    <div className="flex flex-col" data-testid={`krios-lane-${stage}`}>
      {/* lane header */}
      <div
        className={`mb-2 flex items-center justify-between rounded-t-md border-b-2 px-2 py-1.5 transition-colors duration-300 ${
          pulsing ? "bg-primary/10" : "bg-muted/40"
        }`}
        style={{ borderColor: color }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>
          {STAGE_LABELS[stage]}
        </span>
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums transition-transform duration-300 ${
            pulsing ? "scale-125" : ""
          }`}
          style={{ background: `${color}22`, color }}
          data-testid={`krios-lane-count-${stage}`}
        >
          {count}
        </span>
      </div>
      {/* token drop zone */}
      <div
        className={`min-h-[120px] flex-1 space-y-1.5 rounded-b-md border border-t-0 border-dashed p-1.5 transition-colors duration-500 ${
          pulsing ? "border-primary/40 bg-primary/5" : "border-border/60"
        }`}
      >
        {runs.map((r) => (
          <Token key={r.run_id} run={r} />
        ))}
      </div>
    </div>
  );
}

export function FactoryFloor({
  state,
  stream,
}: {
  state?: KriosState;
  stream: UseKriosStreamResult;
}) {
  // Which lanes pulsed recently (from the tail of the live event stream).
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const lastSeenId = useRef(0);

  useEffect(() => {
    const fresh = stream.events.filter((e) => e.id > lastSeenId.current);
    if (fresh.length === 0) return;
    lastSeenId.current = stream.events[stream.events.length - 1]?.id ?? lastSeenId.current;
    const now = Date.now();
    const add: Record<string, number> = {};
    for (const e of fresh) {
      if (e.stage) add[e.stage] = now;
    }
    if (Object.keys(add).length) {
      setPulses((prev) => ({ ...prev, ...add }));
    }
  }, [stream.events]);

  // Expire pulses after ~1.2s so lanes flash rather than stay lit.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 600);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const isPulsing = (stage: KriosStage) => now - (pulses[stage] ?? 0) < 1200;

  // Group in-flight runs by their current stage lane.
  const byStage = useMemo(() => {
    const g: Record<KriosStage, KriosInflight[]> = {
      inspect: [],
      loop: [],
      judge: [],
      regress: [],
      promote: [],
      train: [],
      certify: [],
      deploy: [],
    };
    for (const r of state?.in_flight ?? []) {
      (g[r.stage] ??= []).push(r);
    }
    return g;
  }, [state?.in_flight]);

  const kpis = state?.kpis;
  const inFlightCount = state?.in_flight?.length ?? 0;

  // Recent terminal ships (for the "shipped" ticker at the bottom).
  const recentShips = useMemo(
    () =>
      stream.events
        .filter((e) => e.kind === "promoted" || e.kind === "completed" || e.kind === "trained" || e.kind === "certified")
        .slice(-6)
        .reverse(),
    [stream.events],
  );

  return (
    <div className="space-y-5" data-testid="krios-floor">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="In flight" value={kpis?.in_flight ?? inFlightCount} icon={Boxes} tone="text-sky-400" />
        <Kpi label="Queue depth" value={kpis?.queue_depth ?? state?.queue?.length ?? 0} icon={Layers} />
        <Kpi label="Runs / min" value={kpis ? kpis.runs_per_min.toFixed(2) : "—"} icon={Activity} />
        <Kpi label="Promotions" value={kpis?.promotions_today ?? 0} icon={Rocket} tone="text-emerald-400" />
        <Kpi label="Failures" value={kpis?.failures_today ?? 0} icon={GaugeCircle} tone={(kpis?.failures_today ?? 0) > 0 ? "text-red-400" : "text-foreground"} />
        <Kpi label="Pass rate" value={kpis ? `${Math.round(kpis.pass_rate * 100)}%` : "—"} icon={CheckCircle2} tone="text-emerald-400" />
      </div>

      {/* the production line */}
      {inFlightCount === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={Factory}
            title="Factory idle"
            description="No work items on the floor. Start the factory (or Kick a pass) to launch repair/train runs across non-green buckets."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto p-4">
          <div className="grid min-w-[960px] grid-cols-8 gap-2">
            {KRIOS_STAGES.map((stage) => (
              <Lane
                key={stage}
                stage={stage}
                runs={byStage[stage] ?? []}
                count={state?.stage_counts?.[stage] ?? (byStage[stage]?.length ?? 0)}
                pulsing={isPulsing(stage)}
              />
            ))}
          </div>
        </Card>
      )}

      {/* shipped ticker */}
      {recentShips.length > 0 && (
        <Card className="p-4" data-testid="krios-shipped">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Rocket className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            Recently shipped
          </div>
          <div className="space-y-1">
            {recentShips.map((e: KriosEvent) => (
              <div key={e.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="shrink-0 tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="truncate">{eventSummary(e)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export default FactoryFloor;
