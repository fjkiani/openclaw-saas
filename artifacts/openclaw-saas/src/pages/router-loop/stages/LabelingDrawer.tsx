/**
 * LabelingDrawer — W2 track. Right-side drawer with the last 20 unverified
 * pairs and safe/unsafe/defer controls. Optimistic UI on flip.
 */
import { useUnverifiedPairs, useLabelPair, useJudgeNextBatch } from "@/pages/intelligence/workflow-hooks";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckCircle2, XCircle, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

const LABELS = [
  { k: "safe", icon: CheckCircle2, cls: "text-emerald-400 border-emerald-500/30" },
  { k: "unsafe", icon: XCircle, cls: "text-rose-400 border-rose-500/30" },
  { k: "defer", icon: Circle, cls: "text-amber-400 border-amber-500/30" },
] as const;

export function LabelingDrawer({
  open,
  mcpSlug,
  toolName,
  onClose,
}: {
  open: boolean;
  mcpSlug: string;
  toolName: string;
  onClose: () => void;
}) {
  const { data, isLoading, refetch } = useUnverifiedPairs(open ? mcpSlug : undefined, open ? toolName : undefined, 20);
  const labelMut = useLabelPair();
  const judgeMut = useJudgeNextBatch();
  const pairs = data?.pairs ?? [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono">label pairs</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            last 20 unverified for {mcpSlug}::{toolName}. Click safe / unsafe / defer to label. Then judge them as a batch.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                judgeMut.mutate({ domain: "mcp", task_type: `${mcpSlug}::${toolName}`, limit: 20 }, { onSuccess: () => refetch() })
              }
              disabled={judgeMut.isPending || pairs.length === 0}
              data-testid="btn-judge-labeled"
            >
              {judgeMut.isPending ? "judging…" : `Judge these ${pairs.length}`}
            </Button>
            <span className="text-[10px] font-mono text-muted-foreground">
              {pairs.filter((p) => p.label).length}/{pairs.length} labeled
            </span>
          </div>
          {isLoading && <p className="text-xs font-mono text-muted-foreground">loading…</p>}
          {!isLoading && pairs.length === 0 && (
            <p className="text-xs font-mono text-muted-foreground">no unverified pairs</p>
          )}
          {pairs.map((p) => (
            <Card key={p.id} className="p-3 border-border space-y-2">
              <div className="text-[10px] font-mono text-muted-foreground">{p.id}</div>
              <div>
                <div className="text-[10px] font-mono uppercase text-emerald-400/70">chosen</div>
                <p className="text-[11px] font-mono line-clamp-3">{p.chosen_text}</p>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase text-rose-400/70">rejected</div>
                <p className="text-[11px] font-mono line-clamp-3">{p.rejected_text}</p>
              </div>
              <div className="flex gap-1.5">
                {LABELS.map(({ k, icon: Icon, cls }) => (
                  <button
                    key={k}
                    onClick={() => labelMut.mutate({ invocation_id: p.id, label: k })}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1 text-[10px] font-mono border rounded py-1 hover:bg-secondary/40",
                      p.label === k ? cls : "text-muted-foreground border-border",
                    )}
                    data-testid={`btn-label-${k}-${p.id}`}
                  >
                    <Icon className="w-3 h-3" /> {k}
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
