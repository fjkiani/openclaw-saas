/**
 * DrilldownView — per-bucket lifecycle timeline.
 *
 * Left rail: 7 vertical stage anchors with click-to-scroll.
 * Main content: one card per stage. Cards come from stage-specific modules:
 *   RegisterCard, TrafficCard  (W1, cheap)
 *   JudgeCard, BenchmarkCard   (W2)
 *   PromoteCard, RouteCard     (W4)
 *   TrainCard, ServingCard     (W3)
 *
 * All stage cards receive the same `data` prop (DrilldownResponse) plus a
 * mutating action set. Progressive disclosure is enforced by a shared
 * <AdvancedDrawer /> in each card.
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useDrilldown } from "@/pages/intelligence/workflow-hooks";
import { STAGES, STAGE_LABELS, type Stage, encodeUrlState } from "@/pages/intelligence/workflow-types";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { RegisterCard } from "./stages/RegisterCard";
import { TrafficCard } from "./stages/TrafficCard";
import { JudgeCard } from "./stages/JudgeCard";
import { CorrectionCard } from "./stages/CorrectionCard";
import { BenchmarkCard } from "./stages/BenchmarkCard";
import { PromoteCard } from "./stages/PromoteCard";
import { TrainCard } from "./stages/TrainCard";
import { RouteCard } from "./stages/RouteCard";

export function DrilldownView({
  mcpSlug,
  toolName,
  stage,
  labelingOpen,
}: {
  mcpSlug: string;
  toolName: string;
  stage?: Stage;
  labelingOpen?: boolean;
}) {
  const [, setLocation] = useLocation();
  const [activeAction, setActiveAction] = useState(false);
  const { data, isLoading, error } = useDrilldown(mcpSlug, toolName, activeAction);

  useEffect(() => {
    if (stage) {
      const el = document.getElementById(`stage-${stage}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [stage, data]);

  const goBack = () => setLocation("/router-loop");

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <CircleAlert className="w-4 h-4" />
          <AlertTitle>failed to load bucket</AlertTitle>
          <AlertDescription className="font-mono text-xs">{String((error as Error).message)}</AlertDescription>
        </Alert>
        <button onClick={goBack} className="mt-3 text-xs font-mono underline">← back to fleet</button>
      </div>
    );
  }

  return (
    <div className="p-6 grid gap-4" style={{ gridTemplateColumns: "160px 1fr" }}>
      {/* Left rail */}
      <aside className="sticky top-0 self-start pt-1">
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground mb-3"
          data-testid="drilldown-back"
        >
          <ArrowLeft className="w-3 h-3" /> fleet
        </button>
        <div className="text-xs font-mono font-semibold mb-2 truncate" title={`${mcpSlug}::${toolName}`}>
          {mcpSlug}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mb-3 truncate">{toolName}</div>
        <nav className="space-y-1">
          {STAGES.map((s) => (
            <button
              key={s}
              onClick={() => setLocation(`/router-loop${encodeUrlState({ mcp: mcpSlug, tool: toolName, stage: s })}`)}
              className={`w-full text-left text-[11px] font-mono px-2 py-1 rounded hover:bg-secondary/60 ${
                stage === s ? "bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
              data-testid={`stage-rail-${s}`}
            >
              {STAGE_LABELS[s]}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main column */}
      <div className="space-y-4 min-w-0">
        {isLoading && !data && (
          <>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </>
        )}
        {data && (
          <>
            <Card className="p-4 border-border">
              <div className="flex items-baseline gap-3">
                <h1 className="text-xl font-mono font-bold">{data.display_name}</h1>
                <span className="text-xs font-mono text-muted-foreground">
                  {data.provider} · {mcpSlug}::{toolName}
                </span>
              </div>
              <p className="text-[10px] font-mono text-muted-foreground mt-1">
                Snapshot as of {new Date(data.generated_at).toLocaleTimeString()}. Auto-refreshes every {activeAction ? "3" : "15"}s.
              </p>
            </Card>
            <div id="stage-register"><RegisterCard data={data} /></div>
            <div id="stage-traffic"><TrafficCard data={data} /></div>
            <div id="stage-judge">
              <JudgeCard data={data} mcpSlug={mcpSlug} toolName={toolName} labelingOpen={labelingOpen ?? false} onActionChange={setActiveAction} />
            </div>
            <div id="stage-correction">
              <CorrectionCard data={data} mcpSlug={mcpSlug} toolName={toolName} />
            </div>
            <div id="stage-benchmark">
              <BenchmarkCard data={data} mcpSlug={mcpSlug} toolName={toolName} onActionChange={setActiveAction} />
            </div>
            <div id="stage-promote">
              <PromoteCard data={data} mcpSlug={mcpSlug} toolName={toolName} onActionChange={setActiveAction} />
            </div>
            <div id="stage-train">
              <TrainCard data={data} mcpSlug={mcpSlug} toolName={toolName} onActionChange={setActiveAction} />
            </div>
            <div id="stage-route">
              <RouteCard data={data} onActionChange={setActiveAction} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
