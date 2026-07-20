/**
 * BenchmarkCard (stage 4) — W2 track. Re-run MCP benchmark live.
 */
import { useEffect } from "react";
import { FlaskConical } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { useRebenchmark } from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";

function benchStatus(safety: number | null): "green" | "amber" | "red" | "grey" {
  if (safety === null) return "grey";
  if (safety >= 80) return "green";
  if (safety >= 60) return "amber";
  return "red";
}

export function BenchmarkCard({
  data,
  mcpSlug,
  toolName,
  onActionChange,
}: {
  data: DrilldownResponse;
  mcpSlug: string;
  toolName: string;
  onActionChange: (a: boolean) => void;
}) {
  const b = data.benchmark;
  const s = benchStatus(b.safety_pct);
  const mut = useRebenchmark();

  useEffect(() => {
    onActionChange(mut.isPending);
  }, [mut.isPending, onActionChange]);

  return (
    <StageCard
      icon={FlaskConical}
      title="Benchmark"
      subtitle={`safety ${b.safety_pct ?? "—"}% · completion ${b.completion_pct ?? "—"}% · leaks ${b.n_leaks ?? "—"}/${b.n_tasks ?? "—"}`}
      status={s}
      action={
        <Button
          size="sm"
          onClick={() => mut.mutate({ mcp_slug: mcpSlug, tool_name: toolName, live: true })}
          disabled={mut.isPending}
          data-testid="btn-rebenchmark"
        >
          {mut.isPending ? "running…" : "Re-benchmark"}
        </Button>
      }
    >
      <div className="grid grid-cols-4 gap-2">
        <Metric k="safety" v={b.safety_pct !== null ? `${b.safety_pct}%` : "—"} />
        <Metric k="completion" v={b.completion_pct !== null ? `${b.completion_pct}%` : "—"} />
        <Metric k="leaks" v={b.n_leaks ?? "—"} />
        <Metric k="run" v={b.latest_run_id ?? "—"} />
      </div>
      {mut.data && (
        <div className="mt-2 text-[11px] font-mono text-emerald-400">
          new run #{mut.data.run_id} · safety {mut.data.safety_pct}% · leaks {mut.data.n_leaks}
        </div>
      )}
      {mut.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((mut.error as Error).message)}</div>}
      <AdvancedDrawer>
        <RawJson value={b} />
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
