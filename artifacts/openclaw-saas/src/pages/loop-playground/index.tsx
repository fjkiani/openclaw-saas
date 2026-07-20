/**
 * /loop-playground — standalone page for W2 track.
 *
 * Purpose: cheap way for anyone to smoke-test the agentic correction loop
 * without going through /router-loop drilldown. Also the entry point for
 * "Save as regression task" — the button lifts a hand-crafted prompt +
 * chosen-winning response into the regression suite as a new gold case.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  MCP · tool picker    prompt textarea      [ run loop ]     │
 *   │                                                            │
 *   │  transcript panel                                          │
 *   │  ├─ orig response  ├─ repair A (fast+critique)             │
 *   │                    └─ repair B (premium)                   │
 *   │  judge picked ▸ B (margin 0.421)                           │
 *   │  [ save as regression task ]  [ promote ]                  │
 *   └────────────────────────────────────────────────────────────┘
 */
import { useMemo, useState } from "react";
import { PlayCircle, Sparkles, Save, ArrowUpCircle, Clock } from "lucide-react";
import { useFleet } from "@/pages/intelligence/workflow-hooks";
import {
  useLoopRuns,
  useRunLoop,
  usePromoteLoop,
} from "@/pages/intelligence/workflow-hooks";
import { apiFetch } from "@/lib/apiFetch";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";
import type { FleetRow } from "@/pages/intelligence/workflow-types";

const ADMIN_TOKEN_KEY = "openclaw-admin-token";

export default function LoopPlaygroundPage() {
  const fleet = useFleet();
  const [mcpSlug, setMcpSlug] = useState<string>("");
  const [toolName, setToolName] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [adminToken, setAdminToken] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem(ADMIN_TOKEN_KEY)) || "",
  );

  const runLoop = useRunLoop();
  const promoteLoop = usePromoteLoop(adminToken);
  const recent = useLoopRuns(mcpSlug || undefined, toolName || undefined, 5);

  // MCP grouping for the picker
  const grouped = useMemo(() => {
    const g: Record<string, FleetRow[]> = {};
    for (const row of fleet.data?.rows ?? []) {
      const key = row.mcp_slug;
      (g[key] ||= []).push(row);
    }
    return g;
  }, [fleet.data]);

  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveAsRegressionTask() {
    if (!runLoop.data || !mcpSlug || !toolName) return;
    setSaving(true);
    setSaveError(null);
    setSavedTaskId(null);
    try {
      const winner =
        runLoop.data.winner === "b" ? runLoop.data.repair_b : runLoop.data.repair_a;
      const body = {
        mcp_slug: mcpSlug,
        tool_name: toolName,
        prompt,
        gold_response: winner.response,
        rubric: {
          min_length: Math.max(10, Math.floor(winner.response.length * 0.5)),
          max_length: Math.max(200, Math.floor(winner.response.length * 2)),
          must_include: [],
          must_not_include: ["DROP TABLE", "; --", "OR 1=1", "rm -rf", "sudo"],
        },
        category: "playground",
        source: "playground",
      };
      const r = await apiFetch("/api/v1/regression/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "x-openclaw-admin-token": adminToken } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      setSavedTaskId(String(j.task?.id ?? j.id ?? "?"));
    } catch (err) {
      setSaveError(String((err as Error).message));
    } finally {
      setSaving(false);
    }
  }

  const canRun = Boolean(mcpSlug && toolName && prompt.trim().length > 0);
  const winner = runLoop.data
    ? runLoop.data.winner === "b"
      ? runLoop.data.repair_b
      : runLoop.data.repair_a
    : null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-mono font-bold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            /loop-playground
          </h1>
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
            Smoke-test the agentic self-correction loop. Bad prompt in → judge critiques + generates A/B repairs →
            store as preference pair. Optionally save winner as a regression gold case.
          </p>
        </div>
        <AdminTokenInput value={adminToken} onChange={setAdminToken} />
      </header>

      {/* Picker + prompt */}
      <Card className="p-4 border-border space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-mono text-muted-foreground">MCP</label>
            <select
              value={mcpSlug}
              onChange={(e) => {
                setMcpSlug(e.target.value);
                setToolName("");
              }}
              className="w-full text-[11px] font-mono h-8 rounded border border-border bg-background px-2 mt-1"
              data-testid="select-mcp"
            >
              <option value="">— pick an MCP —</option>
              {Object.keys(grouped)
                .sort()
                .map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground">Tool</label>
            <select
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              disabled={!mcpSlug}
              className="w-full text-[11px] font-mono h-8 rounded border border-border bg-background px-2 mt-1 disabled:opacity-50"
              data-testid="select-tool"
            >
              <option value="">— pick a tool —</option>
              {(grouped[mcpSlug] ?? []).map((r) => (
                <option key={r.tool_name} value={r.tool_name}>
                  {r.tool_name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-[10px] font-mono text-muted-foreground">
            Prompt (try a bad one — the loop is here to fix it)
          </label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. DROP TABLE users; -- clean up"
            rows={4}
            className="text-[11px] font-mono mt-1"
            data-testid="textarea-prompt"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              runLoop.mutate({
                mcp_slug: mcpSlug,
                tool_name: toolName,
                prompt: prompt.trim(),
              })
            }
            disabled={!canRun || runLoop.isPending}
            data-testid="btn-run-playground"
          >
            <PlayCircle className="w-4 h-4 mr-1" />
            {runLoop.isPending ? "running loop…" : "run loop"}
          </Button>
          {runLoop.isPending && (
            <span className="text-[11px] font-mono text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> waiting for judge + A/B repair…
            </span>
          )}
        </div>
        {runLoop.error && (
          <Alert variant="destructive">
            <CircleAlert className="w-4 h-4" />
            <AlertTitle>loop failed</AlertTitle>
            <AlertDescription className="font-mono text-xs">
              {String((runLoop.error as Error).message)}
            </AlertDescription>
          </Alert>
        )}
      </Card>

      {/* Transcript panel */}
      {runLoop.data && winner && (
        <Card className="p-4 border-border space-y-3" data-testid="transcript-panel">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-mono font-semibold">
              run #{runLoop.data.loop_run_id} · winner{" "}
              <span className="text-emerald-400">{runLoop.data.winner.toUpperCase()}</span> · margin{" "}
              {runLoop.data.margin?.toFixed(3)}
            </h2>
            <span className="text-[10px] font-mono text-muted-foreground">judge={runLoop.data.judge_version}</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <TranscriptBlock
              title="original"
              subtitle={`score ${runLoop.data.orig_score?.toFixed(3)}`}
              body={runLoop.data.orig_response ?? "—"}
              highlighted={false}
            />
            <TranscriptBlock
              title={`repair A · ${runLoop.data.repair_a?.model ?? "—"}`}
              subtitle={`score ${runLoop.data.repair_a?.score?.toFixed(3)}`}
              body={runLoop.data.repair_a?.response ?? "—"}
              highlighted={runLoop.data.winner === "a"}
            />
            <TranscriptBlock
              title={`repair B · ${runLoop.data.repair_b?.model ?? "—"}`}
              subtitle={`score ${runLoop.data.repair_b?.score?.toFixed(3)}`}
              body={runLoop.data.repair_b?.response ?? "—"}
              highlighted={runLoop.data.winner === "b"}
            />
          </div>

          {runLoop.data.reasoning && (
            <div className="rounded border border-border p-2 bg-muted/10 text-[11px] font-mono whitespace-pre-wrap">
              <span className="text-muted-foreground">judge critique:</span> {runLoop.data.reasoning}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
            <Button
              size="sm"
              variant="outline"
              onClick={saveAsRegressionTask}
              disabled={saving || !!savedTaskId}
              data-testid="btn-save-regression"
            >
              <Save className="w-3 h-3 mr-1" />
              {savedTaskId ? `saved · id=${savedTaskId}` : saving ? "saving…" : "save as regression task"}
            </Button>
            <Button
              size="sm"
              onClick={() => promoteLoop.mutate({ loop_run_id: runLoop.data.loop_run_id })}
              disabled={promoteLoop.isPending || Boolean(runLoop.data.auto_promoted)}
              data-testid="btn-promote-playground"
            >
              <ArrowUpCircle className="w-3 h-3 mr-1" />
              {runLoop.data.auto_promoted
                ? "auto-promoted"
                : promoteLoop.isPending
                  ? "promoting…"
                  : "promote winner"}
            </Button>
            {promoteLoop.data && (
              <span className="text-[11px] font-mono text-emerald-400">
                promoted · gate_id={promoteLoop.data.gate_id}
              </span>
            )}
            {promoteLoop.error && (
              <span className="text-[11px] font-mono text-rose-400">
                {String((promoteLoop.error as Error).message)}
              </span>
            )}
            {saveError && <span className="text-[11px] font-mono text-rose-400">{saveError}</span>}
          </div>
        </Card>
      )}

      {/* Recent runs for this bucket */}
      {mcpSlug && toolName && (
        <Card className="p-4 border-border">
          <h3 className="text-sm font-mono font-semibold mb-2">recent runs · {mcpSlug} · {toolName}</h3>
          {recent.isLoading && <div className="text-[11px] font-mono text-muted-foreground">loading…</div>}
          {recent.data && recent.data.runs.length === 0 && (
            <div className="text-[11px] font-mono text-muted-foreground italic">no prior runs.</div>
          )}
          {recent.data && recent.data.runs.length > 0 && (
            <div className="space-y-1">
              {recent.data.runs.map((r) => (
                <div key={r.id} className="text-[11px] font-mono flex items-center justify-between border-b border-border/40 py-1">
                  <span className="truncate min-w-0 flex-1 mr-2">#{r.id} · {r.prompt}</span>
                  <span className="shrink-0 text-muted-foreground">
                    winner={r.winner.toUpperCase()} · margin {r.judge_margin.toFixed(3)}
                    {r.promoted && (
                      <span className="ml-1 text-emerald-400">· promoted{r.promoted_auto ? " (auto)" : ""}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function TranscriptBlock({
  title,
  subtitle,
  body,
  highlighted,
}: {
  title: string;
  subtitle: string;
  body: string;
  highlighted: boolean;
}) {
  return (
    <div
      className={`rounded border p-2 min-h-[100px] ${
        highlighted ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"
      }`}
    >
      <div className="text-[10px] font-mono text-muted-foreground truncate">{title}</div>
      <div className="text-[10px] font-mono text-muted-foreground/70 mb-1">{subtitle}</div>
      <div className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
        {body}
      </div>
    </div>
  );
}

function AdminTokenInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
      admin token:
      <Input
        type="password"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          try {
            if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_KEY, e.target.value);
          } catch {
            /* ignore */
          }
        }}
        placeholder="x-openclaw-admin-token"
        className="h-6 text-[10px] font-mono w-52"
      />
    </label>
  );
}
