/**
 * /intelligence/judge — LLM-Judge dashboard.
 *
 * Left column: summary cards (total pairs, verified count, mean margin).
 * Right column: per-domain table.
 * Bottom: recent 20 judgments with reasoning + model_used, plus a manual
 * batch-judge button.
 */
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Scale, RefreshCcw, Play } from "lucide-react";
import { Layout } from "@/components/Layout";
import { useJudgeSummary, useJudgeBatch } from "./hooks";

function pct(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

export default function JudgePage() {
  const summary = useJudgeSummary();
  const batch = useJudgeBatch();
  const [limit, setLimit] = useState(10);

  const overall = summary.data?.summary?.overall;
  const perDomain = summary.data?.summary?.per_domain ?? [];
  const recent = summary.data?.recent ?? [];

  return (
    <Layout>
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Scale className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">LLM Judge</h1>
          <p className="text-muted-foreground">
            Preference-pair evaluation loop (Groq Llama-3.3-70B + OpenRouter fallbacks).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Total pairs</CardDescription></CardHeader>
          <CardContent className="text-3xl font-semibold">
            {summary.isLoading ? <Skeleton className="h-9 w-16" /> : (overall?.total ?? "—")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Judge-verified</CardDescription></CardHeader>
          <CardContent className="text-3xl font-semibold">
            {summary.isLoading ? <Skeleton className="h-9 w-16" /> : (overall?.verified ?? "—")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Unverified</CardDescription></CardHeader>
          <CardContent className="text-3xl font-semibold">
            {summary.isLoading ? <Skeleton className="h-9 w-16" /> : (overall?.unverified ?? "—")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Mean margin</CardDescription></CardHeader>
          <CardContent className="text-3xl font-semibold">
            {summary.isLoading ? <Skeleton className="h-9 w-16" /> : fmt(overall?.mean_margin ?? null)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="w-4 h-4" /> Run judge batch
          </CardTitle>
          <CardDescription>
            Judge N unverified pairs with the live LLM chain. Skips pairs already judged.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Input
            type="number"
            min={1}
            max={50}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            className="w-24"
          />
          <Button
            onClick={() => batch.mutate({ limit })}
            disabled={batch.isPending}
          >
            {batch.isPending ? "Judging…" : `Judge ${limit} pairs`}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => summary.refetch()}
            disabled={summary.isFetching}
            title="Refresh"
          >
            <RefreshCcw className={`w-4 h-4 ${summary.isFetching ? "animate-spin" : ""}`} />
          </Button>
          {batch.data && (
            <span className="text-sm text-muted-foreground">
              scored {batch.data.scored_count} • skipped {batch.data.skipped}
            </span>
          )}
          {batch.error && (
            <span className="text-sm text-destructive">{(batch.error as Error).message}</span>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Per-domain performance</CardTitle>
            <CardDescription>Verified counts and mean chosen/rejected scores.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Verified/Total</TableHead>
                  <TableHead className="text-right">Mean chosen</TableHead>
                  <TableHead className="text-right">Mean rejected</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perDomain.map((d) => (
                  <TableRow key={d.domain}>
                    <TableCell><Badge variant="secondary">{d.domain}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{d.verified}/{d.n}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(d.mean_chosen)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(d.mean_rejected)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(d.mean_margin)}</TableCell>
                  </TableRow>
                ))}
                {!perDomain.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center">
                      No verified pairs yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent judgments</CardTitle>
            <CardDescription>Most recent 20 judged pairs.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead className="text-right">Chosen</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.slice(0, 20).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.id.slice(0, 8)}</TableCell>
                    <TableCell className="text-xs">{r.task_type}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.judge_score_chosen)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.judge_score_rejected)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-md truncate">
                      {r.judge_reasoning ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {!recent.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground text-center">
                      No judgments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
    </Layout>
  );
}
