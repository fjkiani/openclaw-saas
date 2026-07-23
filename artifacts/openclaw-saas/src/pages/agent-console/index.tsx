/**
 * /agent-console — the platform's own agent, made evident on the front-end.
 *
 * A user types a free-text goal (optionally scoped to a bucket/tool). The
 * platform's planner turns it into a DAG of REAL platform actions (inspect /
 * loop / judge / regression / train / promote / rollback) and the executor
 * runs them step-by-step. The transcript streams live via polling; mutating
 * steps pause at an approval gate with Approve / Reject buttons.
 *
 * This is a real, non-sandbagged workflow surface: every step result shown is
 * the actual endpoint round-trip, and Approve genuinely resumes execution.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  goal textarea      [bucket ▾] [tool ▾]        [ run agent ]   │
 *   │  quick goals: fix · regression · train · rollback             │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  LIVE RUN                                        status badge  │
 *   │   ▸ [0] inspect_bucket   done     "Inspected 1 bucket(s)…"     │
 *   │   ▸ [1] run_loop         done     "winner=b margin 0.062"      │
 *   │   ▸ [4] promote_policy   ⏸ APPROVE?   [Approve] [Reject]       │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  recent runs (click to load)                                  │
 *   └──────────────────────────────────────────────────────────────┘
 */
import { useMemo, useState } from "react";
import {
  Bot,
  PlayCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  PauseCircle,
  SkipForward,
  ShieldAlert,
  Sparkles,
  History,
} from "lucide-react";
import { useFleet } from "@/pages/intelligence/workflow-hooks";
import {
  useAgentActions,
  useAgentRuns,
  useAgentRunDetail,
  useStartAgentRun,
  useApproveAgentStep,
  useCancelAgentRun,
  type AgentRunT,
  type AgentStepT,
  type AgentStepStatus,
  type AgentRunStatus,
} from "@/pages/intelligence/workflow-hooks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";
import type { FleetRow } from "@/pages/intelligence/workflow-types";

const ADMIN_TOKEN_KEY = "openclaw-admin-token";

const QUICK_GOALS = [
  { label: "Fix a broken tool", goal: "Diagnose the bucket, repair the tool, verify, and promote if it clears the gate." },
  { label: "Run regression", goal: "Run the regression suite and report pass/fail." },
  { label: "Train an adapter", goal: "Check training thresholds and dispatch an adapter, then verify no regression." },
  { label: "Roll back a policy", goal: "Roll back the most recent promotion for this bucket." },
  { label: "Inspect the fleet", goal: "Inspect current fleet health and summarize which buckets need attention." },
];

function statusColor(s: AgentRunStatus | AgentStepStatus): string {
  switch (s) {
    case "completed":
    case "done":
      return "text-emerald-500 border-emerald-500/40 bg-emerald-500/10";
    case "failed":
      return "text-red-500 border-red-500/40 bg-red-500/10";
    case "awaiting_approval":
      return "text-amber-500 border-amber-500/40 bg-amber-500/10";
    case "running":
    case "planning":
      return "text-sky-500 border-sky-500/40 bg-sky-500/10";
    case "skipped":
      return "text-zinc-400 border-zinc-500/40 bg-zinc-500/10";
    case "cancelled":
      return "text-zinc-400 border-zinc-500/40 bg-zinc-500/10";
    default:
      return "text-zinc-400 border-zinc-500/40 bg-zinc-500/10";
  }
}

function StepIcon({ status }: { status: AgentStepStatus }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "running":
      return <Loader2 className="h-4 w-4 text-sky-500 animate-spin" />;
    case "awaiting_approval":
      return <PauseCircle className="h-4 w-4 text-amber-500" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-zinc-400" />;
    default:
      return <Clock className="h-4 w-4 text-zinc-400" />;
  }
}

function StatusBadge({ status }: { status: AgentRunStatus | AgentStepStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusColor(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function AgentConsolePage() {
  const fleet = useFleet();
  const actions = useAgentActions();
  const recentRuns = useAgentRuns(15, "console");

  const [goal, setGoal] = useState("");
  const [mcpSlug, setMcpSlug] = useState("");
  const [toolName, setToolName] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [adminToken, setAdminToken] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem(ADMIN_TOKEN_KEY)) || "",
  );

  const startRun = useStartAgentRun(adminToken);
  const approve = useApproveAgentStep(adminToken);
  const cancel = useCancelAgentRun(adminToken);
  const runDetail = useAgentRunDetail(activeRunId);

  const grouped = useMemo(() => {
    const g: Record<string, FleetRow[]> = {};
    for (const row of fleet.data?.rows ?? []) {
      (g[row.mcp_slug] ||= []).push(row);
    }
    return g;
  }, [fleet.data]);

  const toolsForSlug = useMemo(
    () => (mcpSlug ? (grouped[mcpSlug] ?? []).map((r) => r.tool_name) : []),
    [grouped, mcpSlug],
  );

  const run = runDetail.data?.run;

  function persistToken(t: string) {
    setAdminToken(t);
    if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_KEY, t);
  }

  async function handleRun() {
    if (!goal.trim()) return;
    const res = await startRun.mutateAsync({
      goal: goal.trim(),
      mode: "console",
      mcp_slug: mcpSlug || null,
      tool_name: toolName || null,
    });
    setActiveRunId(res.run_id);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* header */}
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-sky-500/10 p-2">
          <Bot className="h-6 w-6 text-sky-500" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Agent Console</h1>
          <p className="text-sm text-muted-foreground">
            Describe a goal. The platform&apos;s agent plans and executes real actions step by step.
          </p>
        </div>
      </div>

      {/* composer */}
      <Card className="space-y-4 p-5">
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Fix the broken anthropic-postgres query tool and get it green"
          rows={3}
          className="resize-none"
        />
        <div className="flex flex-wrap gap-2">
          {QUICK_GOALS.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => setGoal(q.goal)}
              className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition hover:border-sky-500/50 hover:text-foreground"
            >
              <Sparkles className="h-3 w-3" />
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Bucket (optional)</label>
            <select
              value={mcpSlug}
              onChange={(e) => {
                setMcpSlug(e.target.value);
                setToolName("");
              }}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">— all —</option>
              {Object.keys(grouped).map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Tool (optional)</label>
            <select
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              disabled={!mcpSlug}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
            >
              <option value="">— any —</option>
              {toolsForSlug.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Admin token</label>
            <Input
              type="password"
              value={adminToken}
              onChange={(e) => persistToken(e.target.value)}
              placeholder="x-openclaw-admin-token"
              className="h-9 w-56"
            />
          </div>
          <Button onClick={handleRun} disabled={!goal.trim() || startRun.isPending} className="ml-auto gap-2">
            {startRun.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Run agent
          </Button>
        </div>
        {startRun.isError && (
          <Alert variant="destructive">
            <CircleAlert className="h-4 w-4" />
            <AlertTitle>Failed to start</AlertTitle>
            <AlertDescription>{String((startRun.error as Error)?.message ?? startRun.error)}</AlertDescription>
          </Alert>
        )}
      </Card>

      {/* live run transcript */}
      {run && (
        <Card className="space-y-4 p-5" data-testid="agent-run-card">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Run</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{run.id.slice(0, 8)}</code>
                <StatusBadge status={run.status} />
                {run.planner && (
                  <span className="text-xs text-muted-foreground">planner: {run.planner}</span>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">{run.goal}</p>
            </div>
            {(run.status === "running" || run.status === "awaiting_approval" || run.status === "planning") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancel.mutate(run.id)}
                disabled={cancel.isPending}
              >
                Cancel
              </Button>
            )}
          </div>

          <StepList run={run} onApprove={(idx, decision) => approve.mutate({ runId: run.id, step_idx: idx, decision })} approving={approve.isPending} />

          {run.summary && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <span className="font-medium">Summary: </span>
              {run.summary}
            </div>
          )}
          {run.error && (
            <Alert variant="destructive">
              <CircleAlert className="h-4 w-4" />
              <AlertTitle>Run error</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          )}
        </Card>
      )}

      {/* recent runs */}
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Recent runs</h2>
        </div>
        <div className="space-y-1">
          {(recentRuns.data?.runs ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No runs yet. Describe a goal above to begin.</p>
          )}
          {(recentRuns.data?.runs ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setActiveRunId(r.id)}
              className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition hover:border-sky-500/40 ${
                r.id === activeRunId ? "border-sky-500/50 bg-sky-500/5" : "border-border"
              }`}
            >
              <StatusBadge status={r.status} />
              <span className="min-w-0 flex-1 truncate">{r.goal}</span>
              {r.mcp_slug && (
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {r.mcp_slug}
                  {r.tool_name ? `/${r.tool_name}` : ""}
                </code>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(r.created_at).toLocaleTimeString()}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {/* action registry reference */}
      {actions.data?.actions && (
        <p className="text-center text-xs text-muted-foreground">
          {actions.data.actions.length} platform actions available ·{" "}
          {actions.data.actions.filter((a) => a.mutating).length} require approval
        </p>
      )}
    </div>
  );
}

function StepList({
  run,
  onApprove,
  approving,
}: {
  run: AgentRunT;
  onApprove: (idx: number, decision: "approve" | "reject") => void;
  approving: boolean;
}) {
  const steps = run.steps ?? [];
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Planning…
      </div>
    );
  }
  return (
    <ol className="space-y-2">
      {steps.map((s) => (
        <li
          key={s.idx}
          className={`rounded-md border p-3 ${
            s.status === "awaiting_approval" ? "border-amber-500/50 bg-amber-500/5" : "border-border"
          }`}
          data-testid={`agent-step-${s.idx}`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              <StepIcon status={s.status} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">#{s.idx}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{s.action_type}</code>
                <StatusBadge status={s.status} />
                {s.requires_approval && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                    <ShieldAlert className="h-3 w-3" /> gated
                  </span>
                )}
              </div>
              {s.rationale && <p className="mt-1 text-sm text-muted-foreground">{s.rationale}</p>}
              {s.result?.summary && (
                <p className="mt-1 text-sm text-foreground/90">{s.result.summary}</p>
              )}
              {s.error && <p className="mt-1 text-sm text-red-500">{s.error}</p>}

              {s.status === "awaiting_approval" && (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => onApprove(s.idx, "approve")}
                    disabled={approving}
                    className="gap-1 bg-emerald-600 hover:bg-emerald-700"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onApprove(s.idx, "reject")}
                    disabled={approving}
                    className="gap-1"
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </Button>
                </div>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
