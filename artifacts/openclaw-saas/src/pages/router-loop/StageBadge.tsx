/**
 * StageBadge — one lifecycle-stage badge in the fleet grid.
 *
 * status → color; label → short text; badge → optional chip.
 */
import { cn } from "@/lib/utils";
import type { StageBadge as StageBadgeData } from "@/pages/intelligence/workflow-types";

const COLORS: Record<StageBadgeData["status"], string> = {
  green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  red: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  grey: "bg-muted/40 text-muted-foreground border-border",
};

export function StageBadge({ data }: { data: StageBadgeData }) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-0.5 rounded border px-2 py-1 text-[10px] font-mono min-w-[92px]",
        COLORS[data.status],
      )}
      title={data.hint ?? data.label}
    >
      <span className="truncate w-full">{data.label}</span>
      {data.badge && <span className="text-[9px] opacity-80">{data.badge}</span>}
    </div>
  );
}
