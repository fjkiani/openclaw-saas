/**
 * krios.ts — routes for Krios, the factory orchestrator.
 *
 *   GET  /v1/krios/state                     -> one-shot factory snapshot (poll fallback)
 *   GET  /v1/krios/events?since=&limit=      -> recent factory events (initial hydrate / paging)
 *   GET  /v1/krios/stream                    -> SSE feed of factory events + heartbeat
 *   POST /v1/krios/enable   {enabled}        -> start/stop the conductor at runtime (admin)
 *   POST /v1/krios/kick                      -> force one scan pass now (admin)
 *
 * Read routes are open (like the fleet route). Mutating routes require the admin
 * token (x-openclaw-admin-token), matching the agent routes. The SSE endpoint
 * mirrors the in-repo forge.ts convention (text/event-stream + flushHeaders +
 * res.write("data: …\n\n") loop + req.on("close") cleanup).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { kriosConfig } from "../lib/krios/config.js";
import {
  startKriosConductor,
  stopKriosConductor,
  kriosRunning,
  kickOnce,
} from "../lib/krios/conductor.js";
import { buildState, eventsSince, maxCursor } from "../lib/krios/store.js";

const router: IRouter = Router();
const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_TOKEN) return true; // no token configured → open (dev)
  const got = req.header("x-openclaw-admin-token") ?? "";
  if (got !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return false;
  }
  return true;
}

// ── GET /v1/krios/state ─────────────────────────────────────────────────────────
router.get("/v1/krios/state", async (_req: Request, res: Response): Promise<void> => {
  try {
    const state = await buildState(kriosRunning());
    res.json({ ok: true, state });
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: /state failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/krios/events?since=&limit= ───────────────────────────────────────────
router.get("/v1/krios/events", async (req: Request, res: Response): Promise<void> => {
  try {
    const since = Number(req.query.since ?? 0) || 0;
    const limit = Number(req.query.limit ?? 200) || 200;
    const events = await eventsSince(since, limit);
    const cursor = events.length ? events[events.length - 1].id : since || (await maxCursor());
    res.json({ ok: true, events, cursor });
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: /events failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /v1/krios/stream (SSE) ───────────────────────────────────────────────────
// Mirrors forge.ts: text/event-stream + flushHeaders + data: writes + close cleanup.
// Polls zie_krios_events on KRIOS_POLL_MS and emits any rows newer than the cursor,
// plus a heartbeat so proxies keep the connection open even when the floor is idle.
router.get("/v1/krios/stream", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const cfg = kriosConfig();
  // Client may resume from a known cursor (?since=), else start from the tail.
  let cursor = Number(req.query.since ?? 0) || (await maxCursor());
  let closed = false;

  const send = (event: string, payload: unknown): void => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Initial hello so the client flips to "connected" immediately.
  send("hello", { cursor, poll_ms: cfg.pollMs, running: kriosRunning(), ts: new Date().toISOString() });

  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const events = await eventsSince(cursor, 200);
      if (events.length) {
        for (const ev of events) send("krios", ev);
        cursor = events[events.length - 1].id;
      } else {
        // heartbeat keeps the stream + any proxy alive during idle floors
        send("heartbeat", { cursor, running: kriosRunning(), ts: new Date().toISOString() });
      }
    } catch (err) {
      send("error", { error: String(err) });
    }
  };

  const timer = setInterval(() => void poll(), cfg.pollMs);
  void poll();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

// ── POST /v1/krios/enable {enabled} ──────────────────────────────────────────────
// Runtime toggle: flips process.env.KRIOS_ENABLED then starts/stops the conductor.
router.post("/v1/krios/enable", (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const enabled = Boolean((req.body ?? {}).enabled);
  process.env.KRIOS_ENABLED = enabled ? "1" : "0";
  if (enabled) {
    startKriosConductor(pool);
  } else {
    stopKriosConductor();
  }
  logger.info({ enabled, running: kriosRunning() }, "krios: runtime enable toggled");
  res.json({ ok: true, enabled, running: kriosRunning() });
});

// ── POST /v1/krios/kick ──────────────────────────────────────────────────────────
// Force one scan pass immediately (demo burst). Works even if the timer is off,
// but the conductor still respects KRIOS_MAX_INFLIGHT / KRIOS_MAX_PER_TICK and the
// KRIOS_ENABLED flag is NOT required (an operator explicitly asked for a pass).
router.post("/v1/krios/kick", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    await kickOnce();
    const cursor = await maxCursor();
    res.json({ ok: true, kicked: true, cursor });
  } catch (err) {
    logger.warn({ err: String(err) }, "krios: /kick failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
