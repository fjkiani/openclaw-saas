/**
 * /krios — Krios Factory: the platform's autonomous production line, made
 * visible on the front-end in real time.
 *
 * Krios is a thin conductor above the platform's EXISTING engines (agent
 * executor + Forge/Modal training dispatch + the router-loop repair/promote
 * path). It discovers actionable work (non-green buckets, training-eligible
 * tools), launches real platform actions, and emits a live event feed. This
 * page renders that feed two ways, sharing ONE live source (the SSE stream):
 *
 *   • Factory Floor  — animated work-items flowing across stage lanes.
 *   • Control Room   — dense ops dashboard (in-flight runs, queue, KPIs, log).
 *
 * Nothing here is fabricated: tokens and KPIs are derived from real
 * zie_agent_runs / zie_krios_events rows produced by real executor runs.
 */
import { Factory } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KriosStatusBar } from "./KriosStatusBar";
import { FactoryFloor } from "./FactoryFloor";
import { ControlRoom } from "./ControlRoom";
import { useKriosState, useKriosStream } from "./useKrios";

export default function KriosPage() {
  // ONE shared live source for both tabs (the plan's "one shared live source").
  const stream = useKriosStream();
  const stateQuery = useKriosState(stream.status === "live");
  const state = stateQuery.data;

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6" data-testid="krios-page">
      {/* header */}
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/10 p-2">
          <Factory className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Krios Factory</h1>
          <p className="text-sm text-muted-foreground">
            The platform&apos;s engines — repair, judge, promote, train — unified into one
            autonomous production line, running live.
          </p>
        </div>
      </div>

      {/* control strip (enable / kick / live indicator / admin token) */}
      <KriosStatusBar state={state} streamStatus={stream.status} />

      {/* two views, one shared stream */}
      <Tabs defaultValue="floor" className="w-full">
        <TabsList data-testid="krios-tabs">
          <TabsTrigger value="floor" data-testid="krios-tab-floor">
            Factory Floor
          </TabsTrigger>
          <TabsTrigger value="controlroom" data-testid="krios-tab-controlroom">
            Control Room
          </TabsTrigger>
        </TabsList>

        <TabsContent value="floor" className="mt-4">
          <FactoryFloor state={state} stream={stream} />
        </TabsContent>

        <TabsContent value="controlroom" className="mt-4">
          <ControlRoom state={state} stream={stream} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
