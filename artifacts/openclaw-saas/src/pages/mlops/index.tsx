/**
 * MLOps page — Cloudflare Workers-backed observability for the MCP fleet.
 *
 * Reads /api/mcps/:slug/metrics (which proxies to the CF Worker at
 * $CF_MLOPS_WORKER_URL or falls back to /tmp/cf-mlops-mirror.jsonl in dry mode).
 *
 * Panels:
 *   1. Per-MCP invocation aggregate (n, success ratio, p50/p95 latency, label distribution)
 *   2. Training-threshold progress bar (per bucket)
 *   3. Last dispatched training job
 */
import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LineChart, ActivityIcon, ShieldCheck, ShieldAlert, Rocket } from "lucide-react";
import {
  useMcpsList,
  useMcpMetrics,
  useMcpTrainingPairs,
  useMcpTrainingHealth,
} from "../mcps/hooks";

function Sparkline({ value, max = 100, tone = "primary" }: { value: number; max?: number; tone?: "primary" | "green" | "amber" | "destructive" }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  const color =
    tone === "green" ? "bg-green-600" :
    tone === "amber" ? "bg-amber-500" :
    tone === "destructive" ? "bg-destructive" :
    "bg-primary";
  return (
    <div className="w-full h-2 bg-muted rounded">
      <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MetricsPanel({ slug }: { slug: string }) {
  const q = useMcpMetrics(slug);
  if (q.isLoading) {
    return <div className="text-xs text-muted-foreground">Loading metrics…</div>;
  }
  if (q.isError || !q.data) {
    return <div className="text-xs text-destructive">Failed: {String(q.error)}</div>;
  }
  const m = q.data;
  const successPct = m.n > 0 ? Math.round((m.n_success / m.n) * 100) : 0;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex justify-between">
        <span className="font-mono">{slug}</span>
        <Badge variant="outline">source: {m.source}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-muted-foreground">Invocations</div>
          <div className="text-lg font-semibold">{m.n}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Success</div>
          <div className="text-lg font-semibold text-green-600">{successPct}%</div>
        </div>
        <div>
          <div className="text-muted-foreground">Mean latency</div>
          <div className="text-lg font-semibold">{m.mean_latency_ms} ms</div>
        </div>
        <div>
          <div className="text-muted-foreground">p95 latency</div>
          <div className="text-lg font-semibold">{m.p95_latency_ms} ms</div>
        </div>
      </div>
      <div>
        <div className="text-muted-foreground mb-1">Label distribution</div>
        <div className="flex gap-2">
          <Badge className="bg-green-600 text-white">safe {m.n_labelled_safe}</Badge>
          <Badge variant="destructive">unsafe {m.n_labelled_unsafe}</Badge>
        </div>
      </div>
      <div className="text-muted-foreground">Last seen: {m.last_seen ?? "—"}</div>
    </div>
  );
}

export default function MlOpsPage() {
  const list = useMcpsList();
  const pairs = useMcpTrainingPairs();
  const health = useMcpTrainingHealth();
  const rows = list.data?.rows ?? [];
  const [selectedSlug, setSelectedSlug] = useState<string | null>(rows[0]?.slug ?? null);
  return (
    <div className="container mx-auto px-4 py-6 space-y-6" data-testid="page-mlops">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <LineChart className="w-6 h-6" /> MLOps
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Cloudflare Workers-backed observability for the MCP fleet.
            Every invocation is ingested into the D1-backed metrics store
            (or the dry-run mirror at <code>/tmp/cf-mlops-mirror.jsonl</code>).
            Training thresholds fire from the same buffer that feeds this dashboard.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          Buffer: <b>{health.data?.n_records ?? 0}</b> records
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-MCP metrics</CardTitle>
          <CardDescription>
            Select a registered MCP to see live aggregate stats from the CF Worker (or the dry mirror).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-1 border border-border rounded p-2 max-h-96 overflow-y-auto space-y-1">
              {rows.map((m) => (
                <button
                  key={m.slug}
                  onClick={() => setSelectedSlug(m.slug)}
                  className={`w-full text-left px-2 py-1 rounded font-mono text-xs ${selectedSlug === m.slug ? "bg-primary/10 text-primary" : "hover:bg-muted/40"}`}
                >
                  {m.slug}
                </button>
              ))}
            </div>
            <div className="col-span-3 border border-border rounded p-4">
              {selectedSlug ? <MetricsPanel slug={selectedSlug} /> : <div className="text-muted-foreground text-sm">Pick an MCP.</div>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Rocket className="w-4 h-4" /> Training threshold progress
          </CardTitle>
          <CardDescription>
            Each row: verified preference pairs per (mcp, tool). Threshold is 25 verified with ≥25 safe + ≥25 unsafe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>MCP</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Fires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pairs.data?.counts ?? []).slice(0, 40).map((c) => (
                  <TableRow key={`${c.mcp_slug}::${c.tool_name}`}>
                    <TableCell className="font-mono text-xs">{c.mcp_slug}</TableCell>
                    <TableCell className="text-xs">{c.tool_name}</TableCell>
                    <TableCell className="text-xs">{c.verified_pairs}</TableCell>
                    <TableCell className="w-56">
                      <Sparkline value={c.verified_pairs} max={80} tone={c.fires ? "green" : "primary"} />
                    </TableCell>
                    <TableCell>
                      {c.fires ? <Badge className="bg-green-600 text-white">READY</Badge> : <Badge variant="secondary">waiting</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
                {(pairs.data?.counts.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground text-sm">
                      No training buckets tracked yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
