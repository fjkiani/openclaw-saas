/**
 * PromoteCard (stage 5) — W4 track. Run promotion gate; candidate preselected
 * from most-recent-trained adapter.
 */
import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { usePromoteGate } from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function promoteStatus(latest: DrilldownResponse["promote"]["latest"]): "green" | "amber" | "red" | "grey" {
  if (!latest) return "grey";
  if (latest.promoted) return "green";
  return "amber";
}

export function PromoteCard({
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
  const p = data.promote;
  const s = promoteStatus(p.latest);
  const latestAdapter = data.train.adapters[0]?.id ?? null;
  const [candidate, setCandidate] = useState<string>(latestAdapter ?? p.latest?.candidate_model_id ?? "");
  const mut = usePromoteGate();

  useEffect(() => {
    onActionChange(mut.isPending);
  }, [mut.isPending, onActionChange]);

  return (
    <StageCard
      icon={Rocket}
      title="Promote"
      subtitle={
        p.latest
          ? `latest: ${p.latest.promoted ? "PROMOTED" : "REJECTED"} — ${p.latest.reason ?? "n/a"} · win ${p.latest.win_rate ?? "—"} · safety ${p.latest.safety_pct ?? "—"}%`
          : "no gate runs yet"
      }
      status={s}
      action={
        <Button
          size="sm"
          onClick={() => mut.mutate({ mcp_slug: mcpSlug, tool_name: toolName, candidate_model_id: candidate })}
          disabled={mut.isPending || !candidate}
          data-testid="btn-run-gate"
        >
          {mut.isPending ? "running…" : "Run gate"}
        </Button>
      }
    >
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
        <label className="text-[10px] font-mono text-muted-foreground shrink-0">candidate</label>
        <Input
          value={candidate}
          onChange={(e) => setCandidate(e.target.value)}
          placeholder="adapter id or model slug"
          className="font-mono text-xs"
          data-testid="input-candidate-model"
        />
      </div>
      {p.history.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-[10px] font-mono text-muted-foreground">history</div>
          <div className="max-h-32 overflow-y-auto border border-border rounded">
            <table className="w-full text-[10px] font-mono">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="px-2 py-1 text-left">gate</th>
                  <th className="px-2 py-1 text-left">verdict</th>
                  <th className="px-2 py-1 text-left">win</th>
                  <th className="px-2 py-1 text-left">safety</th>
                  <th className="px-2 py-1 text-left">at</th>
                </tr>
              </thead>
              <tbody>
                {p.history.slice(0, 8).map((g) => (
                  <tr key={g.id} className="border-t border-border/40">
                    <td className="px-2 py-1">#{g.id}</td>
                    <td className={`px-2 py-1 ${g.promoted ? "text-emerald-400" : "text-rose-400"}`}>
                      {g.is_rollback ? "rollback" : g.promoted ? "PROMOTED" : "rejected"}
                    </td>
                    <td className="px-2 py-1">{g.win_rate?.toFixed(2) ?? "—"}</td>
                    <td className="px-2 py-1">{g.safety_pct ?? "—"}</td>
                    <td className="px-2 py-1 text-muted-foreground">{new Date(g.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {mut.data && (
        <div className="mt-2 text-[11px] font-mono text-emerald-400">
          gate #{mut.data.gate_id} · {mut.data.promoted ? "PROMOTED" : `rejected — ${mut.data.reason}`}
        </div>
      )}
      {mut.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((mut.error as Error).message)}</div>}
      <AdvancedDrawer>
        <RawJson value={p} />
      </AdvancedDrawer>
    </StageCard>
  );
}
