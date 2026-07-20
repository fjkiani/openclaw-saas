/**
 * RegisterCard (stage 1) — L0-L4 gate scores from MCP registration.
 */
import { CircleCheck } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";

function scoreStatus(overall: number | null): "green" | "amber" | "red" | "grey" {
  if (overall === null) return "grey";
  if (overall >= 80) return "green";
  if (overall >= 60) return "amber";
  return "red";
}

export function RegisterCard({ data }: { data: DrilldownResponse }) {
  const r = data.register;
  const s = scoreStatus(r.overall);
  const levels = [
    ["L0", r.gate_l0],
    ["L1", r.gate_l1],
    ["L2", r.gate_l2],
    ["L3", r.gate_l3],
    ["L4", r.gate_l4],
  ] as const;
  return (
    <StageCard
      icon={CircleCheck}
      title="Register"
      subtitle={`overall gate ${r.overall ?? "—"} · moat ${r.moat_grade ?? "—"} (${r.moat_score ?? 0})`}
      status={s}
    >
      <div className="grid grid-cols-5 gap-2">
        {levels.map(([k, v]) => (
          <div key={k} className="rounded border border-border p-2 text-center">
            <div className="text-[10px] font-mono text-muted-foreground">{k}</div>
            <div className="text-sm font-mono font-semibold">{v ?? "—"}</div>
          </div>
        ))}
      </div>
      <AdvancedDrawer>
        <RawJson value={r} />
      </AdvancedDrawer>
    </StageCard>
  );
}
