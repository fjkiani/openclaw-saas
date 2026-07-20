/**
 * TrafficCard (stage 2) — invocation count + latency from CF Worker /metrics.
 */
import { Activity } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";

function trafficStatus(n: number, errors: number): "green" | "amber" | "red" | "grey" {
  if (n === 0) return "grey";
  const errRate = errors / n;
  if (errRate < 0.02) return "green";
  if (errRate < 0.1) return "amber";
  return "red";
}

export function TrafficCard({ data }: { data: DrilldownResponse }) {
  const t = data.traffic;
  const s = trafficStatus(t.n_invocations, t.errors_24h);
  return (
    <StageCard
      icon={Activity}
      title="Traffic"
      subtitle={`last seen ${t.last_seen ? new Date(t.last_seen).toLocaleString() : "—"}`}
      status={s}
    >
      <div className="grid grid-cols-4 gap-2">
        <Metric k="invocations" v={t.n_invocations} />
        <Metric k="p95 ms" v={t.p95_latency_ms ?? "—"} />
        <Metric k="mean ms" v={t.mean_latency_ms ?? "—"} />
        <Metric k="errors 24h" v={t.errors_24h} />
      </div>
      <AdvancedDrawer>
        <RawJson value={t} />
      </AdvancedDrawer>
    </StageCard>
  );
}

function Metric({ k, v }: { k: string; v: number | string }) {
  return (
    <div className="rounded border border-border p-2">
      <div className="text-[10px] font-mono text-muted-foreground">{k}</div>
      <div className="text-sm font-mono font-semibold">{v}</div>
    </div>
  );
}
