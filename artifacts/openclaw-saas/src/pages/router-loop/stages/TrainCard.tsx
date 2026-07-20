/**
 * TrainCard (stage 6) — W3 track. Dispatch training + adapter history +
 * inline InferencePanel to test the served adapter.
 */
import { useEffect } from "react";
import { GraduationCap } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { useDispatchTraining } from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";
import { InferencePanel } from "./InferencePanel";

function trainStatus(data: DrilldownResponse["train"]): "green" | "amber" | "red" | "grey" {
  if (data.adapters.length > 0) return "green";
  if (data.ready_to_dispatch) return "amber";
  return "grey";
}

export function TrainCard({
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
  const t = data.train;
  const s = trainStatus(t);
  const mut = useDispatchTraining();

  useEffect(() => {
    onActionChange(mut.isPending);
  }, [mut.isPending, onActionChange]);

  return (
    <StageCard
      icon={GraduationCap}
      title="Train"
      subtitle={`${t.adapters.length} adapter${t.adapters.length === 1 ? "" : "s"} · eligible pairs ${t.eligible_pair_count}`}
      status={s}
      action={
        <Button
          size="sm"
          onClick={() => mut.mutate({ mcp_slug: mcpSlug, tool_name: toolName, min_pairs: 25 })}
          disabled={mut.isPending}
          data-testid="btn-dispatch-training"
        >
          {mut.isPending ? "dispatching…" : "Dispatch training"}
        </Button>
      }
    >
      {t.adapters.length > 0 ? (
        <div className="border border-border rounded max-h-40 overflow-y-auto">
          <table className="w-full text-[10px] font-mono">
            <thead className="bg-secondary/40">
              <tr>
                <th className="px-2 py-1 text-left">adapter</th>
                <th className="px-2 py-1 text-left">pairs</th>
                <th className="px-2 py-1 text-left">R2</th>
                <th className="px-2 py-1 text-left">at</th>
              </tr>
            </thead>
            <tbody>
              {t.adapters.slice(0, 8).map((a) => (
                <tr key={a.id} className="border-t border-border/40">
                  <td className="px-2 py-1 truncate max-w-[160px]" title={a.volume_path}>{a.id}</td>
                  <td className="px-2 py-1">{a.n_pairs ?? "—"}</td>
                  <td className="px-2 py-1 text-muted-foreground truncate max-w-[220px]" title={a.r2_key ?? ""}>
                    {a.r2_key ? a.r2_key.split("/").pop() : "—"}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[11px] font-mono text-muted-foreground">no adapters yet</p>
      )}
      {mut.data && (
        <div className="mt-2 text-[11px] font-mono text-emerald-400">
          dispatched {mut.data.dispatched.length} run{mut.data.dispatched.length === 1 ? "" : "s"}
        </div>
      )}
      {mut.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((mut.error as Error).message)}</div>}
      <InferencePanel mcpSlug={mcpSlug} toolName={toolName} defaultAdapter={t.adapters[0]?.id} />
      <AdvancedDrawer>
        <RawJson value={t} />
      </AdvancedDrawer>
    </StageCard>
  );
}
