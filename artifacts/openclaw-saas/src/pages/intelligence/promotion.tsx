/**
 * /intelligence/promotion — Promotion Gate dashboard.
 *
 * Shows recent gate decisions (accept/reject with the reason string) and
 * exposes a form to fire a fresh gate check for (domain, task, candidate,
 * baseline, mcp). A green row means zie_router_policies was actually
 * flipped to the candidate model.
 */
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Rocket, Check, X, Play } from "lucide-react";
import { Layout } from "@/components/Layout";
import { usePromotions, useRunPromotion, type PromotionDecision } from "./hooks";

export default function PromotionPage() {
  const list = usePromotions();
  const run = useRunPromotion();
  const [form, setForm] = useState({
    domain: "mcp",
    task_type: "",
    candidate_model_id: "",
    baseline_model_id: "liquid-lfm-2.5-1.2b-instruct",
    candidate_mcp_slug: "",
  });
  const [lastDecision, setLastDecision] = useState<PromotionDecision | null>(null);

  const rows = list.data?.rows ?? [];

  const submit = () => {
    const body = { ...form };
    if (!body.candidate_mcp_slug) delete (body as { candidate_mcp_slug?: string }).candidate_mcp_slug;
    if (!body.task_type || !body.candidate_model_id) return;
    run.mutate(body as Parameters<typeof run.mutate>[0], {
      onSuccess: (r) => setLastDecision(r.decision),
    });
  };

  return (
    <Layout>
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Rocket className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">Promotion Gate</h1>
          <p className="text-muted-foreground">
            Judge signals + MCP benchmark → accept/reject router-policy update. Live-judge only.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="w-4 h-4" /> Run gate
          </CardTitle>
          <CardDescription>
            Aggregates judge_verified pairs (excluding dry-heuristic) and the latest MCP benchmark.
            On promote, zie_router_policies is updated live.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="domain" />
          <Input value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })} placeholder="task_type" />
          <Input value={form.candidate_model_id} onChange={(e) => setForm({ ...form, candidate_model_id: e.target.value })} placeholder="candidate_model_id" />
          <Input value={form.baseline_model_id} onChange={(e) => setForm({ ...form, baseline_model_id: e.target.value })} placeholder="baseline_model_id" />
          <Input value={form.candidate_mcp_slug} onChange={(e) => setForm({ ...form, candidate_mcp_slug: e.target.value })} placeholder="candidate_mcp_slug (optional)" />
          <div className="md:col-span-5">
            <Button onClick={submit} disabled={run.isPending}>
              {run.isPending ? "Evaluating…" : "Evaluate promotion"}
            </Button>
            {run.error && <span className="ml-3 text-sm text-destructive">{(run.error as Error).message}</span>}
          </div>
        </CardContent>
      </Card>

      {lastDecision && (
        <Card className={lastDecision.promoted ? "border-green-500" : "border-amber-500"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {lastDecision.promoted ? <Check className="w-5 h-5 text-green-600" /> : <X className="w-5 h-5 text-amber-600" />}
              Decision — {lastDecision.task_type}
            </CardTitle>
            <CardDescription>
              gate_id={lastDecision.gate_id} • {lastDecision.reason}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>candidate: <span className="font-mono">{lastDecision.candidate_model_id}</span></div>
              <div>baseline: <span className="font-mono">{lastDecision.baseline_model_id}</span></div>
              <div>n_judged_pairs: <b>{lastDecision.n_judged_pairs}</b></div>
              <div>win_rate: <b>{(lastDecision.win_rate_chosen * 100).toFixed(1)}%</b></div>
              {lastDecision.latest_mcp_bench && (
                <>
                  <div>mcp: <span className="font-mono">{lastDecision.latest_mcp_bench.slug}</span></div>
                  <div>safety: <b>{lastDecision.latest_mcp_bench.safety_pct}%</b></div>
                  <div>completion: <b>{lastDecision.latest_mcp_bench.task_completion_pct}%</b></div>
                  <div>leaks: <b>{lastDecision.latest_mcp_bench.n_safety_leaks}</b></div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent gate decisions</CardTitle>
          <CardDescription>Last 25 promotion runs.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Candidate</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.id}</TableCell>
                  <TableCell className="text-xs">{r.task_type}</TableCell>
                  <TableCell className="font-mono text-xs">{r.candidate_model_id}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.eval_score?.toFixed(1) ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={r.promoted ? "default" : "secondary"}>
                      {r.promoted ? "promoted" : "rejected"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.promotion_date ?? r.created_at}
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-center">
                    No gate decisions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
    </Layout>
  );
}
