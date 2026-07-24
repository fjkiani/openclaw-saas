/**
 * useKrios.ts — TanStack Query + SSE bindings for the Krios factory orchestrator.
 *
 * Krios is the platform's factory conductor: it composes the EXISTING engines
 * (agent executor + Forge/Modal training dispatch + the router-loop repair/promote
 * path) into one autonomous production line and exposes a live event feed. This
 * module is the single FE data source shared by the Factory Floor, the Control
 * Room, and the Forge PipelineViz live upgrade.
 *
 * Backend contracts (all under the /api prefix):
 *   GET  /api/v1/krios/state              one-shot snapshot (KPIs, in-flight, queue)
 *   GET  /api/v1/krios/events?since=&limit= paged event feed (initial hydrate + poll)
 *   GET  /api/v1/krios/stream?since=      SSE stream (event: hello|heartbeat|krios)
 *   POST /api/v1/krios/enable {enabled}   start/stop the conductor (admin-gated)
 *   POST /api/v1/krios/kick               force one scan pass (admin-gated)
 *
 * The stream is the primary live source; a react-query poll of /state + /events is
 * the fallback so the page keeps working if the EventSource drops (or the browser
 * is offline). Mutating routes need the admin token via x-openclaw-admin-token;
 * read routes (state/events/stream) are open, so read-only UI works without it.
 * EventSource cannot send custom headers, but /stream is a read route — fine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

// ── Types (mirror api-server/src/lib/krios/contract.ts) ───────────────────────
export const KRIOS_EVENT_KINDS = [
  "tick",
  "queued",
  "launched",
  "step_done",
  "awaiting_approval",
  "promoted",
  "trained",
  "completed",
  "failed",
  "skipped",
] as const;
export type KriosEventKind = (typeof KRIOS_EVENT_KINDS)[number];

export const KRIOS_STAGES = [
  "inspect",
  "loop",
  "judge",
  "regress",
  "promote",
  "train",
  "deploy",
] as const;
export type KriosStage = (typeof KRIOS_STAGES)[number];

export interface KriosEvent {
  id: number;
  ts: string;
  kind: KriosEventKind;
  mcp_slug: string | null;
  tool_name: string | null;
  run_id: string | null;
  stage: KriosStage | null;
  detail: Record<string, unknown>;
}

export interface KriosPublicConfig {
  pollMs: number;
  maxInflight: number;
  maxPerTick: number;
  dedupMin: number;
}

export interface KriosInflight {
  run_id: string;
  goal: string;
  mcp_slug: string | null;
  tool_name: string | null;
  status: string;
  stage: KriosStage;
  current_step: number;
  total_steps: number;
  created_at: string;
}

export interface KriosQueueItem {
  mcp_slug: string;
  tool_name: string | null;
  kind: "repair" | "train";
  reason: string;
}

export interface KriosKpis {
  in_flight: number;
  queue_depth: number;
  runs_per_min: number;
  promotions_today: number;
  failures_today: number;
  pass_rate: number;
}

export interface KriosState {
  enabled: boolean;
  config: KriosPublicConfig;
  stage_counts: Record<KriosStage, number>;
  in_flight: KriosInflight[];
  queue: KriosQueueItem[];
  kpis: KriosKpis;
  last_tick_ts: string | null;
  cursor: number;
}

// ── HTTP helpers (mirror the workflow-hooks getJson/postJson convention) ──────
async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

const adminHeader = (t?: string): Record<string, string> | undefined =>
  t ? { "x-openclaw-admin-token": t } : undefined;

// Absolute stream URL (apiFetch's VITE_API_URL prefix logic, replicated for EventSource).
const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
function absUrl(path: string): string {
  return API_BASE && path.startsWith("/") ? `${API_BASE}${path}` : path;
}

// ── React-query hooks ─────────────────────────────────────────────────────────
const POLL_MS = 4000;

/** One-shot factory snapshot; polls as the fallback when the stream is down. */
export function useKriosState(pollWhenLive = false) {
  return useQuery({
    queryKey: ["krios", "state"],
    queryFn: () => getJson<{ ok: boolean; state: KriosState }>("/api/v1/krios/state"),
    // Always poll at a slow cadence so KPIs/queue/in-flight stay fresh even when
    // the stream is the primary source (the stream carries events, not the
    // derived snapshot). Faster when the stream is not connected.
    refetchInterval: pollWhenLive ? POLL_MS * 2 : POLL_MS,
    select: (d) => d.state,
  });
}

/** Paged event feed. Used for initial hydrate and as the polling fallback. */
export function useKriosEvents(since = 0, limit = 200, enabled = true) {
  return useQuery({
    queryKey: ["krios", "events", since, limit],
    queryFn: () =>
      getJson<{ ok: boolean; events: KriosEvent[]; cursor: number }>(
        `/api/v1/krios/events?since=${since}&limit=${limit}`,
      ),
    enabled,
    refetchInterval: POLL_MS,
  });
}

export function useKriosEnable(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      postJson<{ ok: boolean; enabled: boolean; running: boolean }>(
        "/api/v1/krios/enable",
        { enabled },
        adminHeader(adminToken),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["krios", "state"] });
    },
  });
}

export function useKriosKick(adminToken?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postJson<{ ok: boolean; kicked: boolean }>("/api/v1/krios/kick", {}, adminHeader(adminToken)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["krios", "state"] });
      qc.invalidateQueries({ queryKey: ["krios", "events"] });
    },
  });
}

// ── SSE live stream hook ───────────────────────────────────────────────────────
export type StreamStatus = "connecting" | "live" | "polling" | "error";

export interface UseKriosStreamResult {
  /** Rolling buffer of the most recent factory events (newest last). */
  events: KriosEvent[];
  /** Highest event id seen so far (the SSE `since` cursor). */
  cursor: number;
  /** Connection status for the live/connected indicator. */
  status: StreamStatus;
  /** True once at least one hello/heartbeat/event frame has arrived. */
  connected: boolean;
}

/**
 * Subscribe to the Krios SSE stream with a react-query polling fallback.
 *
 * Behaviour:
 *  - Opens an EventSource on /api/v1/krios/stream?since=<cursor>.
 *  - `krios` frames are parsed as KriosEvent and appended (deduped by id, capped).
 *  - `hello`/`heartbeat` frames flip status to "live".
 *  - On error, EventSource auto-reconnects; if it stays down we fall back to the
 *    /events poll (react-query) so the buffer keeps advancing regardless.
 *  - `maxBuffer` caps the retained event count to keep the log light.
 */
export function useKriosStream(maxBuffer = 300): UseKriosStreamResult {
  const [events, setEvents] = useState<KriosEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const cursorRef = useRef(0);
  const seenRef = useRef<Set<number>>(new Set());
  const esRef = useRef<EventSource | null>(null);

  const pushEvents = useCallback(
    (incoming: KriosEvent[]) => {
      if (incoming.length === 0) return;
      setEvents((prev) => {
        const merged = prev.slice();
        for (const ev of incoming) {
          if (seenRef.current.has(ev.id)) continue;
          seenRef.current.add(ev.id);
          merged.push(ev);
          if (ev.id > cursorRef.current) {
            cursorRef.current = ev.id;
          }
        }
        merged.sort((a, b) => a.id - b.id);
        const trimmed = merged.length > maxBuffer ? merged.slice(merged.length - maxBuffer) : merged;
        return trimmed;
      });
      setCursor(cursorRef.current);
    },
    [maxBuffer],
  );

  // Primary: EventSource. Reconnect is handled natively by the browser; we key
  // the subscription off mount only (the `since` cursor is read from the ref on
  // (re)connect so a fresh EventSource resumes near where we left off).
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const url = absUrl(`/api/v1/krios/stream?since=${cursorRef.current}`);
      let es: EventSource;
      try {
        es = new EventSource(url, { withCredentials: true });
      } catch {
        setStatus("polling");
        return;
      }
      esRef.current = es;
      setStatus((s) => (s === "live" ? s : "connecting"));

      es.addEventListener("hello", () => {
        if (!cancelled) setStatus("live");
      });
      es.addEventListener("heartbeat", () => {
        if (!cancelled) setStatus("live");
      });
      es.addEventListener("krios", (e) => {
        if (cancelled) return;
        setStatus("live");
        try {
          const parsed = JSON.parse((e as MessageEvent).data);
          const arr: KriosEvent[] = Array.isArray(parsed) ? parsed : [parsed];
          pushEvents(arr.filter((x) => x && typeof x.id === "number"));
        } catch {
          /* ignore malformed frame */
        }
      });
      // Some servers emit default (unnamed) message frames — accept those too.
      es.onmessage = (e) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(e.data);
          if (parsed && typeof parsed.id === "number") pushEvents([parsed]);
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        if (cancelled) return;
        // EventSource retries on its own; reflect the degraded state and let the
        // /events poll (below) carry the buffer forward in the meantime.
        setStatus("polling");
        // If the browser permanently closed it, schedule a manual reopen.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, 4000);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [pushEvents]);

  // Fallback: while not live, poll /events from the current cursor and merge.
  const polling = status !== "live";
  const pollQuery = useKriosEvents(cursor, 200, polling);
  useEffect(() => {
    if (polling && pollQuery.data?.events?.length) {
      pushEvents(pollQuery.data.events);
    }
  }, [polling, pollQuery.data, pushEvents]);

  const connected = events.length > 0 || status === "live";
  return useMemo(
    () => ({ events, cursor, status, connected }),
    [events, cursor, status, connected],
  );
}

// ── Shared display helpers (used by Floor / Control Room / Forge upgrade) ─────
export const STAGE_LABELS: Record<KriosStage, string> = {
  inspect: "Inspect",
  loop: "Loop",
  judge: "Judge",
  regress: "Regress",
  promote: "Promote",
  train: "Train",
  deploy: "Deploy",
};

/** Colourblind-friendly per-stage accent (Okabe-Ito derived). */
export const STAGE_COLORS: Record<KriosStage, string> = {
  inspect: "#0279EE", // blue
  loop: "#56B4E9", // sky
  judge: "#009E73", // green
  regress: "#E69F00", // orange
  promote: "#CC79A7", // pink/magenta
  train: "#D55E00", // vermilion
  deploy: "#75A025", // olive/ship
};

export const EVENT_KIND_LABELS: Record<KriosEventKind, string> = {
  tick: "tick",
  queued: "queued",
  launched: "launched",
  step_done: "step done",
  awaiting_approval: "awaiting approval",
  promoted: "promoted",
  trained: "trained",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
};

export function eventSummary(ev: KriosEvent): string {
  const d = ev.detail || {};
  if (typeof d.summary === "string" && d.summary) return d.summary;
  const bucket =
    ev.mcp_slug && ev.tool_name ? `${ev.mcp_slug}/${ev.tool_name}` : ev.mcp_slug || "";
  switch (ev.kind) {
    case "tick":
      return `Scan pass complete${typeof d.queue_depth === "number" ? ` (queue ${d.queue_depth})` : ""}.`;
    case "queued":
      return `Queued ${bucket}${d.reason ? ` — ${d.reason}` : ""}.`;
    case "launched":
      return `Launched ${d.kind === "train" ? "training" : "repair"} for ${bucket}.`;
    case "skipped":
      return `Skipped ${bucket}${d.reason ? ` — ${d.reason}` : ""}.`;
    default:
      return `${EVENT_KIND_LABELS[ev.kind]}${bucket ? ` — ${bucket}` : ""}.`;
  }
}
