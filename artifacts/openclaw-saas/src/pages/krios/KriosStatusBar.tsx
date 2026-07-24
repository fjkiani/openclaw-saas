/**
 * KriosStatusBar.tsx — the factory control strip shown above both tabs.
 *
 * Responsibilities:
 *  - conductor on/off toggle  → POST /api/v1/krios/enable {enabled}
 *  - "Kick" button            → POST /api/v1/krios/kick   (force one scan pass)
 *  - live/connected indicator (driven by the SSE stream status)
 *  - admin-token input, localStorage-backed under "openclaw-admin-token"
 *    (same key + pattern as Agent Console, so a token entered on either page works)
 *
 * Read routes (state/events/stream) are open, so the page renders without a token;
 * the token is only required to enable/kick. If a mutating call 401s we surface it.
 */
import { useState } from "react";
import { Play, Square, Zap, Loader2, Radio, WifiOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useKriosEnable,
  useKriosKick,
  type KriosState,
  type StreamStatus,
} from "./useKrios";

const ADMIN_TOKEN_KEY = "openclaw-admin-token";

function LiveIndicator({ status, enabled }: { status: StreamStatus; enabled: boolean }) {
  const live = status === "live";
  const label = live ? (enabled ? "LIVE" : "IDLE") : status === "polling" ? "POLLING" : "CONNECTING";
  const cls = live
    ? enabled
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : "text-zinc-300 border-zinc-500/30 bg-zinc-500/10"
    : status === "polling"
      ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
      : "text-sky-400 border-sky-500/30 bg-sky-500/10";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-mono ${cls}`}
      data-testid="krios-live-indicator"
    >
      {live ? (
        <Radio className={`h-3 w-3 ${enabled ? "animate-pulse" : ""}`} aria-hidden="true" />
      ) : status === "polling" ? (
        <WifiOff className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

export function KriosStatusBar({
  state,
  streamStatus,
}: {
  state?: KriosState;
  streamStatus: StreamStatus;
}) {
  const [adminToken, setAdminToken] = useState<string>(
    () => (typeof window !== "undefined" && localStorage.getItem(ADMIN_TOKEN_KEY)) || "",
  );
  const enable = useKriosEnable(adminToken);
  const kick = useKriosKick(adminToken);

  const enabled = Boolean(state?.enabled);
  const cfg = state?.config;

  function persistToken(t: string) {
    setAdminToken(t);
    if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_KEY, t);
  }

  const busy = enable.isPending || kick.isPending;
  const err = (enable.error as Error | null)?.message || (kick.error as Error | null)?.message || null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/60 px-4 py-3"
      data-testid="krios-status-bar"
    >
      {/* conductor toggle */}
      <Button
        onClick={() => enable.mutate(!enabled)}
        disabled={busy}
        variant={enabled ? "outline" : "default"}
        className="gap-2"
        data-testid="krios-enable"
      >
        {enable.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : enabled ? (
          <Square className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {enabled ? "Stop factory" : "Start factory"}
      </Button>

      {/* kick */}
      <Button
        onClick={() => kick.mutate()}
        disabled={busy}
        variant="outline"
        className="gap-2"
        data-testid="krios-kick"
      >
        {kick.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
        Kick
      </Button>

      <LiveIndicator status={streamStatus} enabled={enabled} />

      {/* factory bounds (from public config) */}
      {cfg && (
        <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline" data-testid="krios-config">
          max {cfg.maxInflight} in-flight · {cfg.maxPerTick}/tick · poll {Math.round(cfg.pollMs / 1000)}s
        </span>
      )}

      {/* admin token (localStorage-backed, shared with Agent Console) */}
      <div className="ml-auto flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <Input
          type="password"
          value={adminToken}
          onChange={(e) => persistToken(e.target.value)}
          placeholder="admin token"
          className="h-8 w-44 font-mono text-xs"
          data-testid="krios-admin-token"
        />
      </div>

      {err && (
        <p className="w-full text-xs text-red-500" data-testid="krios-status-error">
          {err}
        </p>
      )}
    </div>
  );
}

export default KriosStatusBar;
