/**
 * /intelligence/benchmark — MCP benchmark dashboard.
 *
 * Trigger a benchmark against a registered MCP; results write a row to
 * evaluation_runs (domain='mcp_benchmark') and 5 rows to evaluation_metrics.
 * The task list below shows the last run's per-task detail so you can see
 * exactly why safety_pct landed where it did (refused vs unexpected_pass vs
 * auth_refused vs leaked).
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { FlaskConical, Play, ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { Layout } from "@/components/Layout";
import { useBenchmarkMcp, type BenchmarkResult } from "./hooks";
import { useMcpsList } from "../mcps/hooks";

function pct(n: number) {
  return `${n.toFixed(0)}%`;
}

export default function BenchmarkPage() {
  const mcps = useMcpsList();
  const bench = useBenchmarkMcp();
  const rows = mcps.data?.rows ?? [];
  const [slug, setSlug] = useState<string>("");
  const [url, setUrl] = useState<string>("");
  const [tools, setTools] = useState<string>("");
  const [result, setResult] = useState<BenchmarkResult | null>(null);

  const selected = useMemo(() => rows.find((r) => r.slug === slug), [rows, slug]);

  const handlePick = (nextSlug: string) => {
    setSlug(nextSlug);
    const row = rows.find((r) => r.slug === nextSlug);
    if (row) {
      setTools((row.declaredTools ?? []).map((t) => t.name).join(","));
      // stdio MCPs get a stdio:// URL so the harness runs in dry mode
      // (writing real evaluation_runs rows) instead of trying HTTP.
      setUrl(`stdio://${nextSlug}`);
    }
  };

  const run = () => {
    if (!slug || !url) return;
    const declaredTools = tools.split(",").map((s) => s.trim()).filter(Boolean);
    bench.mutate(
      { mcpSlug: slug, mcpUrl: url, declaredTools },
      { onSuccess: (r) => setResult(r.result) },
    );
  };

  return (
    <Layout>
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">MCP Benchmark</h1>
          <p className="text-muted-foreground">
            Live JSON-RPC probes: handshake → tools/list → per-tool call → 3 safety probes.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="w-4 h-4" /> Run benchmark
          </CardTitle>
          <CardDescription>
            Pick a registered MCP or paste a custom URL. Every run writes an evaluation_run + 5 metrics rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select
              className="border rounded-md px-3 py-2 bg-background"
              value={slug}
              onChange={(e) => handlePick(e.target.value)}
            >
              <option value="">— Pick registered MCP —</option>
              {rows.map((r) => (
                <option key={r.slug} value={r.slug}>{r.slug}</option>
              ))}
            </select>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="mcpUrl (https:// or stdio://…)" />
            <Input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="comma,separated,tool,names" />
          </div>
          <Button onClick={run} disabled={bench.isPending || !slug || !url}>
            {bench.isPending ? "Benchmarking…" : "Benchmark"}
          </Button>
          {bench.error && <p className="text-sm text-destructive">{(bench.error as Error).message}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge variant={result.dry ? "secondary" : "default"}>
                {result.dry ? "dry" : "live"}
              </Badge>
              {result.mcp_slug}
              <span className="text-xs text-muted-foreground font-mono">
                evaluation_run_id={result.eval_run_id}
              </span>
            </CardTitle>
            <CardDescription>{result.mcp_url}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <MetricTile label="Tool correctness" value={pct(result.tool_correctness_pct)} progress={result.tool_correctness_pct} />
              <MetricTile label="Task completion" value={pct(result.task_completion_pct)} progress={result.task_completion_pct} />
              <MetricTile label="Safety" value={pct(result.safety_pct)} progress={result.safety_pct} highlight={result.n_safety_leaks > 0 ? "leak" : undefined} />
              <MetricTile label="Avg latency" value={`${result.avg_latency_ms} ms`} />
            </div>

            <div className="mt-6">
              <h3 className="font-semibold mb-2">Task detail</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead className="text-right">Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.tasks.map((t, i) => (
                    <TableRow key={i}>
                      <TableCell>{t.category}</TableCell>
                      <TableCell className="font-mono text-xs">{t.task}</TableCell>
                      <TableCell>
                        <Badge variant={t.status === "pass" ? "default" : "destructive"}>
                          {t.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{t.detail}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.latency_ms} ms</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </Layout>
  );
}

function MetricTile({ label, value, progress, highlight }: { label: string; value: string; progress?: number; highlight?: "leak" }) {
  const Icon = highlight === "leak" ? ShieldX : progress === undefined ? undefined : progress >= 80 ? ShieldCheck : ShieldAlert;
  return (
    <div className="rounded-md border p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon ? <Icon className="w-4 h-4" /> : null}
        {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {progress !== undefined && <Progress value={progress} className="h-1.5" />}
    </div>
  );
}
