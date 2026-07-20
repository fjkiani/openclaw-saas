/**
 * JudgeCard (stage 3) — W2 track.
 *  • "Judge next 25 pairs" CTA
 *  • Opens LabelingDrawer for last 20 unverified pairs
 */
import { useEffect } from "react";
import { Scale, Tag } from "lucide-react";
import { useLocation } from "wouter";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import { encodeUrlState } from "@/pages/intelligence/workflow-types";
import { useJudgeNextBatch } from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";
import { LabelingDrawer } from "./LabelingDrawer";

function judgeStatus(verified: number, min: number, margin: number | null): "green" | "amber" | "red" | "grey" {
  if (verified === 0) return "grey";
  if (verified < min) return "amber";
  if (margin !== null && margin < 0.1) return "amber";
  return "green";
}

export function JudgeCard({
  data,
  mcpSlug,
  toolName,
  labelingOpen,
  onActionChange,
}: {
  data: DrilldownResponse;
  mcpSlug: string;
  toolName: string;
  labelingOpen: boolean;
  onActionChange: (a: boolean) => void;
}) {
  const [, setLocation] = useLocation();
  const j = data.judge;
  const s = judgeStatus(j.verified, j.min_pairs_required, j.mean_margin);
  const judge = useJudgeNextBatch();

  useEffect(() => {
    onActionChange(judge.isPending);
  }, [judge.isPending, onActionChange]);

  return (
    <>
      <StageCard
        icon={Scale}
        title="Judge"
        subtitle={`${j.verified}/${j.min_pairs_required} pairs verified · margin ${j.mean_margin?.toFixed(3) ?? "—"}`}
        status={s}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setLocation(`/router-loop${encodeUrlState({ mcp: mcpSlug, tool: toolName, stage: "judge", labeling: true })}`)
              }
              data-testid="btn-open-labeling"
            >
              <Tag className="w-3 h-3 mr-1" /> label pairs
            </Button>
            <Button
              size="sm"
              onClick={() => judge.mutate({ domain: "mcp", task_type: `${mcpSlug}::${toolName}`, limit: 25 })}
              disabled={judge.isPending}
              data-testid="btn-judge-batch"
            >
              {judge.isPending ? "judging…" : "Judge next 25 pairs"}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-3 gap-2">
          <Metric k="verified" v={j.verified} />
          <Metric k="unverified" v={j.unverified} />
          <Metric k="mean margin" v={j.mean_margin?.toFixed(3) ?? "—"} />
        </div>
        {judge.data && (
          <div className="mt-2 text-[11px] font-mono text-emerald-400">
            scored {judge.data.scored_count} · skipped {judge.data.skipped}
          </div>
        )}
        {judge.error && <div className="mt-2 text-[11px] font-mono text-rose-400">{String((judge.error as Error).message)}</div>}
        <AdvancedDrawer>
          <RawJson value={j} />
        </AdvancedDrawer>
      </StageCard>
      <LabelingDrawer
        open={labelingOpen}
        mcpSlug={mcpSlug}
        toolName={toolName}
        onClose={() =>
          setLocation(`/router-loop${encodeUrlState({ mcp: mcpSlug, tool: toolName, stage: "judge" })}`)
        }
      />
    </>
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
