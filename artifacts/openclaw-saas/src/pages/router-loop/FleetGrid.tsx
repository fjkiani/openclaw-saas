/**
 * FleetGrid — landing view of /router-loop.
 *
 * 30 rows × 7 stage columns. Row click → drill-down deep-link.
 * Data source: GET /api/v1/workflow/fleet (30s server cache, 15s FE refetch).
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useFleet, useAutopilotSettings } from "@/pages/intelligence/workflow-hooks";
import { STAGES, STAGE_LABELS, encodeUrlState } from "@/pages/intelligence/workflow-types";
import { StageBadge } from "./StageBadge";
import { AutopilotCell } from "./AutopilotCell";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleCheck, CircleAlert, RotateCcw } from "lucide-react";

function SummaryChip({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "good" | "warn" | "bad" }) {
  const toneCls = {
    default: "text-foreground border-border",
    good: "text-emerald-400 border-emerald-500/30",
    warn: "text-amber-400 border-amber-500/30",
    bad: "text-rose-400 border-rose-500/30",
  }[tone];
  return (
    <div className={`rounded border px-3 py-1.5 text-xs font-mono ${toneCls}`}>
      <span className="opacity-70 mr-1.5">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

export function FleetGrid() {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const { data, isLoading, error, refetch, isFetching } = useFleet();
  const autopilot = useAutopilotSettings();

  const autopilotOn = useMemo(() => {
    const s = new Set<string>();
    for (const a of autopilot.data?.settings ?? []) {
      if (a.enabled) s.add(`${a.mcp_slug}::${a.tool_name}`);
    }
    return s;
  }, [autopilot.data]);

  const rows = useMemo(() => {
    const r = data?.rows ?? [];
    if (!q) return r;
    const ql = q.toLowerCase();
    return r.filter((row) => `${row.mcp_slug} ${row.tool_name} ${row.display_name ?? ""}`.toLowerCase().includes(ql));
  }, [data, q]);

  return (
    <div className="p-6 space-y-4" data-testid="router-loop-fleet">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-mono font-bold tracking-tight">Router Loop</h1>
          <p className="text-sm text-muted-foreground font-mono">
            End-to-end A-Z lifecycle for every MCP tool: register → traffic → judge → benchmark → promote → train → route.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data?.summary && (
            <>
              <SummaryChip label="buckets" value={data.summary.total_buckets} />
              <SummaryChip label="promoted 7d" value={data.summary.promoted_this_week} tone="good" />
              <SummaryChip label="pending judge" value={data.summary.pending_judge} tone="warn" />
              <SummaryChip label="failed" value={data.summary.failed_dispatches} tone={data.summary.failed_dispatches > 0 ? "bad" : "default"} />
            </>
          )}
          <button
            onClick={() => refetch()}
            className="rounded border border-border px-2.5 py-1.5 text-xs font-mono hover:bg-secondary/50 flex items-center gap-1.5"
            data-testid="router-loop-refresh"
          >
            <RotateCcw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} /> refresh
          </button>
        </div>
      </header>

      <Input
        placeholder="filter by mcp slug or tool name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-md font-mono text-xs"
        data-testid="router-loop-filter"
      />

      {error && (
        <Alert variant="destructive">
          <CircleAlert className="w-4 h-4" />
          <AlertTitle>failed to load fleet</AlertTitle>
          <AlertDescription className="font-mono text-xs">{String((error as Error).message)}</AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead className="bg-secondary/40 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-secondary/60 z-10">MCP · Tool</th>
                {STAGES.map((s) => (
                  <th key={s} className="text-left px-2 py-2 font-semibold">
                    {STAGE_LABELS[s]}
                  </th>
                ))}
                <th className="text-left px-2 py-2 font-semibold whitespace-nowrap">Autopilot</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-3 py-2"><Skeleton className="h-4 w-40" /></td>
                    {STAGES.map((s) => (
                      <td key={s} className="px-2 py-2"><Skeleton className="h-6 w-20" /></td>
                    ))}
                    <td className="px-2 py-2"><Skeleton className="h-6 w-16" /></td>
                  </tr>
                ))}
              {!isLoading &&
                rows.map((row) => (
                  <tr
                    key={`${row.mcp_slug}::${row.tool_name}`}
                    className="border-b border-border/60 hover:bg-secondary/30 cursor-pointer"
                    onClick={() => setLocation(`/router-loop${encodeUrlState({ mcp: row.mcp_slug, tool: row.tool_name })}`)}
                    data-testid={`fleet-row-${row.mcp_slug}-${row.tool_name}`}
                  >
                    <td className="px-3 py-2 sticky left-0 bg-background/95 backdrop-blur">
                      <div className="flex items-center gap-2">
                        <CircleCheck className="w-3 h-3 text-emerald-400/70 shrink-0" />
                        <div className="min-w-0">
                          <div className="font-semibold truncate">{row.mcp_slug}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{row.tool_name}{row.provider ? ` · ${row.provider}` : ""}</div>
                        </div>
                      </div>
                    </td>
                    {STAGES.map((s) => (
                      <td key={s} className="px-2 py-2">
                        <StageBadge data={row.stages[s]} />
                      </td>
                    ))}
                    <td className="px-2 py-2">
                      <AutopilotCell
                        mcpSlug={row.mcp_slug}
                        toolName={row.tool_name}
                        enabled={autopilotOn.has(`${row.mcp_slug}::${row.tool_name}`)}
                      />
                    </td>
                  </tr>
                ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={STAGES.length + 2} className="px-3 py-8 text-center text-muted-foreground">
                    {q ? "no matches" : "no MCP buckets yet"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-[10px] text-muted-foreground font-mono">
        Row click → drill-down. Cadence: server cache 30s, FE refetch 15s idle / 3s while an action is in flight.
      </p>
    </div>
  );
}
