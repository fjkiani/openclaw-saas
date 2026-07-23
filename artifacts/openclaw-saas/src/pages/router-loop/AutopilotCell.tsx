/**
 * AutopilotCell — per-bucket Autopilot switch + live agent-activity strip,
 * rendered in the Autopilot column of the fleet grid.
 *
 * Toggling the switch POSTs /api/v1/agent/autopilot {mcp_slug, tool_name, enabled}.
 * When on, the background autopilot daemon launches agent runs (mode=autopilot)
 * to drive the bucket toward green. This cell polls the bucket's recent agent
 * runs and shows the latest run's status + current step so the operator can
 * watch the agent work without leaving the grid.
 *
 * The switch stops event propagation so toggling it does not trigger the row's
 * drill-down navigation.
 */
import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import {
  useToggleAutopilot,
  useAgentRunsForBucket,
  type AgentRunT,
  type AgentRunStatus,
} from "@/pages/intelligence/workflow-hooks";
import { Switch } from "@/components/ui/switch";

const ADMIN_TOKEN_KEY = "openclaw-admin-token";

function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  // Accept either key used across the app so the operator only sets it once.
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? localStorage.getItem("oc-admin-token") ?? "";
}

function statusTone(s: AgentRunStatus): string {
  switch (s) {
    case "completed":
      return "text-emerald-400";
    case "failed":
      return "text-rose-400";
    case "awaiting_approval":
      return "text-amber-400";
    case "running":
    case "planning":
      return "text-sky-400";
    default:
      return "text-muted-foreground";
  }
}

function ActivityStrip({ run }: { run: AgentRunT | undefined }) {
  if (!run) {
    return <span className="text-[10px] text-muted-foreground/60">idle</span>;
  }
  const steps = run.steps ?? [];
  const current =
    steps.find((s) => s.status === "running" || s.status === "awaiting_approval") ??
    steps[run.current_step ?? 0] ??
    steps[steps.length - 1];
  const active = run.status === "running" || run.status === "planning";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] ${statusTone(run.status)}`} data-testid="autopilot-activity">
      {active && <Loader2 className="h-3 w-3 animate-spin" />}
      <span className="font-semibold">{run.status.replace(/_/g, " ")}</span>
      {current && (
        <span className="text-muted-foreground/80">· {current.action_type}</span>
      )}
    </span>
  );
}

export function AutopilotCell({
  mcpSlug,
  toolName,
  enabled,
}: {
  mcpSlug: string;
  toolName: string;
  enabled: boolean;
}) {
  const [adminToken] = useState<string>(readAdminToken);
  const toggle = useToggleAutopilot(adminToken);
  // Only poll the activity strip for buckets that are (or were just) on, to
  // avoid 30 idle pollers on the landing grid.
  const runs = useAgentRunsForBucket(
    enabled ? mcpSlug : undefined,
    enabled ? toolName : undefined,
    3,
  );
  const latest = runs.data?.runs?.[0];

  return (
    <div
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
      data-testid={`autopilot-cell-${mcpSlug}-${toolName}`}
    >
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={(next) =>
          toggle.mutate({ mcp_slug: mcpSlug, tool_name: toolName, enabled: next })
        }
        aria-label={`Autopilot for ${mcpSlug}/${toolName}`}
        data-testid={`autopilot-switch-${mcpSlug}-${toolName}`}
      />
      {enabled ? (
        <ActivityStrip run={latest} />
      ) : (
        <Bot className="h-3 w-3 text-muted-foreground/40" />
      )}
      {toggle.isError && (
        <span className="text-[10px] text-rose-400" title={String((toggle.error as Error)?.message)}>
          err
        </span>
      )}
    </div>
  );
}
