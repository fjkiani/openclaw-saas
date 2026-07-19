/**
 * Agent Robustness Benchmarks — page (5 category sub-tabs + overview)
 *
 * Backend: /api/stress-benchmarks/{summary,leaderboard,runs,facets,health}
 * See lib/stress-benchmarks/README.md and .cursor/rules/11-agent-robustness.mdc
 * for the contract.
 *
 * This page is intentionally read-only. It does not trigger new stress runs.
 * The corpus is versioned at build time — see PROVENANCE.md.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Activity, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  useStressHealth,
  useStressRuns,
  useStressSummary,
  type StressLeaderboardEntry,
} from "./hooks";

const CATEGORIES = [
  { key: "overview", label: "Overview" },
  { key: "baseline", label: "Baseline" },
  { key: "concurrency", label: "Concurrency" },
  { key: "adversarial", label: "Adversarial" },
  { key: "faults", label: "Faults" },
  { key: "ratelimit", label: "Rate limit" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function fmtMs(x: number): string {
  if (x < 1000) return `${Math.round(x)} ms`;
  return `${(x / 1000).toFixed(1)} s`;
}
function fmtInt(x: number): string {
  return x.toLocaleString();
}

function GradeBadge({ passRate }: { passRate: number }) {
  if (passRate >= 0.7) {
    return (
      <Badge variant="default" className="bg-green-600 hover:bg-green-600">
        Strong
      </Badge>
    );
  }
  if (passRate >= 0.4) {
    return (
      <Badge variant="secondary" className="bg-yellow-600 hover:bg-yellow-600 text-white">
        Mixed
      </Badge>
    );
  }
  return <Badge variant="destructive">Weak</Badge>;
}

function LeaderboardTable({ rows }: { rows: StressLeaderboardEntry[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No leaderboard rows for this category.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table data-testid="stress-leaderboard">
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">n</TableHead>
            <TableHead className="text-right">Pass rate</TableHead>
            <TableHead className="text-right">pass@1</TableHead>
            <TableHead className="text-right">pass@3</TableHead>
            <TableHead className="text-right">pass@5</TableHead>
            <TableHead className="text-right">p50</TableHead>
            <TableHead className="text-right">p95</TableHead>
            <TableHead>Signal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.model} data-testid={`stress-lb-row-${r.model}`}>
              <TableCell className="font-mono text-xs">{r.model}</TableCell>
              <TableCell className="text-right">{fmtInt(r.n_runs)}</TableCell>
              <TableCell className="text-right">
                <span className="font-medium">{fmtPct(r.pass_rate)}</span>
              </TableCell>
              <TableCell className="text-right">{fmtPct(r.pass_at_1_mean)}</TableCell>
              <TableCell className="text-right">{fmtPct(r.pass_at_3_mean)}</TableCell>
              <TableCell className="text-right">{fmtPct(r.pass_at_5_mean)}</TableCell>
              <TableCell className="text-right">{fmtMs(r.p50_ms)}</TableCell>
              <TableCell className="text-right">{fmtMs(r.p95_ms)}</TableCell>
              <TableCell>
                <GradeBadge passRate={r.pass_rate} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CategoryOverview({ category }: { category: string | null }) {
  const summary = useStressSummary();
  const runs = useStressRuns({
    category: category ?? undefined,
    limit: 25,
  });

  if (summary.isLoading || runs.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (summary.error || runs.error) {
    const msg = (summary.error as Error | undefined)?.message
      ?? (runs.error as Error | undefined)?.message
      ?? "unknown error";
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Failed to load: {msg}
        </CardContent>
      </Card>
    );
  }
  const s = summary.data!;
  const page = runs.data!;

  // Filter leaderboard to models seen in this category (or all if overview).
  let lb: StressLeaderboardEntry[] = s.leaderboard;
  if (category) {
    const modelsInCat = new Set(page.runs.map((r) => r.model));
    // Also include models present anywhere in this category (not just the
    // first page). If category corpus is larger than 25, we still show the
    // full leaderboard from summary — filtered where possible.
    lb = s.leaderboard.filter((r) => modelsInCat.has(r.model) || page.total <= 25);
    if (lb.length === 0) lb = s.leaderboard;
  }

  const catStat = category
    ? s.categories.find((c) => c.category === category)
    : null;

  return (
    <div className="space-y-6">
      {catStat && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Runs" value={fmtInt(catStat.n_runs)} />
          <StatCard label="Passed" value={`${fmtInt(catStat.n_passed)} (${fmtPct(catStat.pass_rate)})`} />
          <StatCard label="p50 latency" value={fmtMs(catStat.p50_ms)} />
          <StatCard label="p95 latency" value={fmtMs(catStat.p95_ms)} />
        </div>
      )}
      {!category && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total runs" value={fmtInt(s.n_runs)} />
          <StatCard label="Models" value={fmtInt(s.n_models)} />
          <StatCard label="Categories" value={fmtInt(s.n_categories)} />
          <StatCard label="Domains" value={fmtInt(s.n_domains)} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaderboard {category ? `— ${category}` : ""}</CardTitle>
        </CardHeader>
        <CardContent>
          <LeaderboardTable rows={lb} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Recent runs {category ? `— ${category}` : ""} ({fmtInt(page.total)} total, showing {page.runs.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RunsTable runs={page.runs} />
        </CardContent>
      </Card>

      {!category && s.failure_classes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Failure classes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {s.failure_classes.slice(0, 8).map((f) => (
                <div key={f.failure_class} className="flex items-center gap-3">
                  <div className="w-40 text-xs font-mono truncate">{f.failure_class}</div>
                  <Progress value={f.share * 100} className="flex-1" />
                  <div className="text-xs text-muted-foreground w-24 text-right">
                    {fmtInt(f.count)} ({fmtPct(f.share)})
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function RunsTable({ runs }: { runs: Array<{
  worker_id: string;
  model: string;
  category: string;
  perturbation_id: string;
  domain: string;
  passed: boolean;
  failure_class: string;
  latency_ms: number;
  iterations: number;
  tool_calls: number;
  token_usage: { total: number };
}>}) {
  if (runs.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No runs match this filter.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table data-testid="stress-runs-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Model</TableHead>
            <TableHead>Domain</TableHead>
            <TableHead>Perturbation</TableHead>
            <TableHead className="text-right">Iters</TableHead>
            <TableHead className="text-right">Tool calls</TableHead>
            <TableHead className="text-right">Latency</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead>Failure class</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r, i) => (
            <TableRow key={`${r.worker_id}-${r.model}-${r.perturbation_id}-${i}`}>
              <TableCell>
                {r.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-destructive" />
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">{r.model}</TableCell>
              <TableCell className="text-xs">{r.domain}</TableCell>
              <TableCell className="text-xs">{r.perturbation_id}</TableCell>
              <TableCell className="text-right text-xs">{r.iterations}</TableCell>
              <TableCell className="text-right text-xs">{r.tool_calls}</TableCell>
              <TableCell className="text-right text-xs">{fmtMs(r.latency_ms)}</TableCell>
              <TableCell className="text-right text-xs">{fmtInt(r.token_usage?.total ?? 0)}</TableCell>
              <TableCell className="text-xs font-mono text-muted-foreground">
                {r.passed ? "—" : r.failure_class || "unknown"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AgentRobustnessPage() {
  const [tab, setTab] = useState<CategoryKey>("overview");
  const summary = useStressSummary();
  const health = useStressHealth();

  const provenance = useMemo(() => summary.data?.provenance, [summary.data]);

  return (
    <div className="container mx-auto px-4 py-6 space-y-6" data-testid="page-agent-robustness">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="w-6 h-6" />
            Agent Robustness Benchmarks
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Read-only observability over stress-test runs from mcp-universe-benchmarks.
            Categories cover baseline correctness, concurrency, adversarial prompts,
            transient faults, and rate-limit behaviour. Data is baked at build time —
            this page does not trigger new runs.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          {health.data?.ok ? (
            <span className="text-green-600" data-testid="stress-health-ok">
              corpus loaded — {fmtInt(health.data.n_runs)} runs
            </span>
          ) : health.data ? (
            <span className="text-destructive" data-testid="stress-health-err">
              corpus unavailable: {health.data.error ?? "unknown"}
            </span>
          ) : (
            <span>checking corpus…</span>
          )}
        </div>
      </div>

      {provenance && (
        <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md px-3 py-2 font-mono">
          source: {provenance.source_repo} · branch: {provenance.branch} · commit: {provenance.commit} · generated: {provenance.generated_at}
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as CategoryKey)}>
        <TabsList>
          {CATEGORIES.map((c) => (
            <TabsTrigger key={c.key} value={c.key} data-testid={`stress-tab-${c.key}`}>
              {c.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {CATEGORIES.map((c) => (
          <TabsContent key={c.key} value={c.key} className="mt-6">
            <CategoryOverview category={c.key === "overview" ? null : c.key} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
