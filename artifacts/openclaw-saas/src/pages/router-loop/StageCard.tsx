/**
 * StageCard — shared frame for all 7 stage cards. Icon + title + status pill +
 * body slot + advanced drawer slot.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { StageStatus } from "@/pages/intelligence/workflow-types";

const PILL: Record<StageStatus, string> = {
  green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  red: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  grey: "bg-muted/40 text-muted-foreground border-border",
};

export function StageCard({
  icon: Icon,
  title,
  subtitle,
  status,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  status: StageStatus;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-4 border-border" data-testid={`stage-card-${title.toLowerCase()}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Icon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-mono font-semibold">{title}</h3>
              <span className={cn("text-[10px] font-mono rounded border px-1.5 py-0.5", PILL[status])}>{status}</span>
            </div>
            {subtitle && <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}
