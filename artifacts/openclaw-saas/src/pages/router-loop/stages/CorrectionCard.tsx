/**
 * CorrectionCard (W1) — agentic loop correction drawer.
 * Shows recent /loop/run entries: prompt → judge picks A/B → optional promote.
 *
 * Also shows LoopSettings (auto_promote, thresholds) with an inline PUT.
 */
import { useState } from "react";
import { Sparkles, Play, ArrowUpCircle, Settings2 } from "lucide-react";
import type { DrilldownResponse } from "@/pages/intelligence/workflow-types";
import {
  useLoopRuns,
  useLoopSettings,
  useUpdateLoopSettings,
  useRunLoop,
  usePromoteLoop,
  type LoopRun,
} from "@/pages/intelligence/workflow-hooks";
import { StageCard } from "../StageCard";
import { AdvancedDrawer, RawJson } from "../AdvancedDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

function corrStatus(runs: LoopRun[] | undefined): "green" | "amber" | "red" | "grey" {
  if (!runs || runs.length === 0) return "grey";
  const auto = runs.filter((r) => r.promoted_auto).length;
  if (auto >= 5) return "green";
  const promoted = runs.filter((r) => r.promoted).length;
  if (promoted >= 3) return "green";
  if (runs.length >= 10) return "amber";
  return "grey";
}

export function CorrectionCard({
  data: _data,
  mcpSlug,
  toolName,
  adminToken,
}: {
  data: DrilldownResponse;
  mcpSlug: string;
  toolName: string;
  adminToken?: string;
}) {
  const runs = useLoopRuns(mcpSlug, toolName, 10);
  const settings = useLoopSettings(mcpSlug, toolName);
  const runLoop = useRunLoop();
  const promoteLoop = usePromoteLoop(adminToken);
  const updateSettings = useUpdateLoopSettings(adminToken);

  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const status = corrStatus(runs.data?.runs);
  const total = runs.data?.count ?? 0;
  const autoPromoted = (runs.data?.runs ?? []).filter((r) => r.promoted_auto).length;
  const s = settings.data?.settings;

  return (
    <StageCard
      icon={Sparkles}
      title="Correction"
      subtitle={
        s
          ? `${total} recent runs · ${autoPromoted} auto · auto_promote=${s.auto_promote ? "on" : "off"} · margin≥${s.min_margin}`
          : `${total} recent runs`
      }
      status={status}
      action={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSettings((v) => !v)}
            data-testid="btn-correction-settings"
          >
            <Settings2 className="w-3 h-3" />
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* Ad-hoc loop run */}
        <div className="rounded border border-border p-2 flex items-center gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="run a one-shot loop — e.g. `DROP TABLE users; --oops`"
            className="text-[11px] font-mono h-7"
            data-testid="input-loop-prompt"
          />
          <Button
            size="sm"
            onClick={() => {
              if (!prompt.trim()) return;
              runLoop.mutate(
                { mcp_slug: mcpSlug, tool_name: toolName, prompt: prompt.trim() },
                { onSuccess: () => setPrompt("") },
              );
            }}
            disabled={runLoop.isPending || !prompt.trim()}
            data-testid="btn-run-loop"
          >
            <Play className="w-3 h-3 mr-1" />
            {runLoop.isPending ? "running…" : "run"}
          </Button>
        </div>
        {runLoop.data && (
          <div className="text-[11px] font-mono text-emerald-400">
            loop_run_id={runLoop.data.loop_run_id} winner={runLoop.data.winner} margin={runLoop.data.margin?.toFixed(3)}
            {runLoop.data.auto_promoted ? " · auto-promoted" : ""}
          </div>
        )}
        {runLoop.error && (
          <div className="text-[11px] font-mono text-rose-400">{String((runLoop.error as Error).message)}</div>
        )}

        {/* Settings row */}
        {showSettings && s && (
          <div className="rounded border border-border p-2 grid grid-cols-4 gap-2 items-center bg-muted/20">
            <label className="col-span-4 flex items-center gap-2 text-[11px] font-mono">
              <Switch
                checked={s.auto_promote}
                onCheckedChange={(v) =>
                  updateSettings.mutate({ mcp_slug: mcpSlug, tool_name: toolName, auto_promote: v })
                }
                data-testid="switch-auto-promote"
              />
              auto_promote
            </label>
            <NumInput
              label="margin"
              value={s.min_margin}
              onChange={(v) => updateSettings.mutate({ mcp_slug: mcpSlug, tool_name: toolName, min_margin: v })}
            />
            <NumInput
              label="pairs"
              value={s.min_pairs_agree}
              step={1}
              onChange={(v) => updateSettings.mutate({ mcp_slug: mcpSlug, tool_name: toolName, min_pairs_agree: v })}
            />
            <NumInput
              label="confidence"
              value={s.min_confidence}
              onChange={(v) => updateSettings.mutate({ mcp_slug: mcpSlug, tool_name: toolName, min_confidence: v })}
            />
            {updateSettings.error && (
              <div className="col-span-4 text-[11px] font-mono text-rose-400">
                {String((updateSettings.error as Error).message)}
              </div>
            )}
          </div>
        )}

        {/* Recent runs */}
        {runs.isLoading && <div className="text-[11px] font-mono text-muted-foreground">loading runs…</div>}
        {runs.data && runs.data.runs.length === 0 && (
          <div className="text-[11px] font-mono text-muted-foreground italic">
            no loop runs yet — try the box above with a bad prompt.
          </div>
        )}
        {runs.data && runs.data.runs.length > 0 && (
          <div className="space-y-1">
            {runs.data.runs.map((r) => (
              <RunRow
                key={r.id}
                r={r}
                expanded={expanded === r.id}
                onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                onPromote={() => promoteLoop.mutate({ loop_run_id: r.id })}
                promoting={promoteLoop.isPending}
              />
            ))}
          </div>
        )}
        <AdvancedDrawer>
          <RawJson value={{ runs: runs.data, settings: settings.data }} />
        </AdvancedDrawer>
      </div>
    </StageCard>
  );
}

function RunRow({
  r,
  expanded,
  onToggle,
  onPromote,
  promoting,
}: {
  r: LoopRun;
  expanded: boolean;
  onToggle: () => void;
  onPromote: () => void;
  promoting: boolean;
}) {
  const winnerModel = r.winner === "a" ? r.repair_a_model : r.repair_b_model;
  const winnerScore = r.winner === "a" ? r.repair_a_score : r.repair_b_score;
  return (
    <div
      className="rounded border border-border p-2 hover:bg-secondary/40 cursor-pointer"
      onClick={onToggle}
      data-testid={`loop-run-${r.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono truncate">{r.prompt}</div>
          <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
            #{r.id} · {new Date(r.created_at).toLocaleTimeString()} · winner={r.winner.toUpperCase()} · {winnerModel} ·
            score {winnerScore.toFixed(3)} · margin {r.judge_margin.toFixed(3)}
            {r.promoted && <span className="ml-1 text-emerald-400">· promoted{r.promoted_auto ? " (auto)" : ""}</span>}
          </div>
        </div>
        {!r.promoted && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onPromote();
            }}
            disabled={promoting}
            data-testid={`btn-promote-${r.id}`}
          >
            <ArrowUpCircle className="w-3 h-3 mr-1" />
            promote
          </Button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-mono">
          <div className="rounded border border-border p-1.5">
            <div className="text-muted-foreground">orig · {r.orig_score.toFixed(3)}</div>
          </div>
          <div className={`rounded border p-1.5 ${r.winner === "a" ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
            <div className="text-muted-foreground">A · {r.repair_a_model}</div>
            <div>{r.repair_a_score.toFixed(3)}</div>
          </div>
          <div className={`rounded border p-1.5 ${r.winner === "b" ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
            <div className="text-muted-foreground">B · {r.repair_b_model}</div>
            <div>{r.repair_b_score.toFixed(3)}</div>
          </div>
          <div className="col-span-3 text-[10px] text-muted-foreground">
            judge={r.judge_version} · pref_pair={r.pref_pair_id?.slice(0, 8) ?? "—"}
          </div>
        </div>
      )}
    </div>
  );
}

function NumInput({
  label,
  value,
  onChange,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  const [local, setLocal] = useState<string>(String(value));
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono text-muted-foreground">{label}</label>
      <Input
        type="number"
        step={step}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (!Number.isNaN(n) && n !== value) onChange(n);
        }}
        className="h-7 text-[11px] font-mono"
      />
    </div>
  );
}
