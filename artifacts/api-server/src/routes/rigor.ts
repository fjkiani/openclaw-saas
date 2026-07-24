/**
 * routes/rigor.ts — the Rigor-Gate OpenRouter wrapper API (backend only).
 *
 * Every prompt+output traverses the guardian verification pipeline. House model
 * names ("zeta-rigor-*") are resolved to real OpenRouter ids via the catalog;
 * the upstream id is never leaked on the public listing.
 *
 * Endpoints (mounted under /api/v1/rigor):
 *   POST /chat               wrapper: house model in → verdict-wrapped completion
 *   POST /run                full gated run (superset of /chat; returns trail + capture)
 *   GET  /models             house catalog (OpenAI-style; paid hidden w/o key)
 *   GET  /run/:id            fetch a captured run by id
 *   GET  /runs               list recent captured runs
 *   GET  /dataset            lake summary (counts)
 *   GET  /dataset/export     ?format=sft|dpo → JSONL
 *   POST /_score             loopback scorer for the DSPy sidecar reward_fn (localhost-only)
 *   GET  /health             panel + executor path + catalog status
 *   POST /benchmark          (admin) run the fixture benchmark, return metrics JSON
 *
 * Writes are admin-gated (x-openclaw-admin-token); reads are public; /_score is
 * localhost-only. Admin gate is OPEN when OPENCLAW_ADMIN_TOKEN is unset (dev),
 * matching routes/certify.ts verbatim.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { resolveApiKey } from "../lib/resolveApiKey.js";
import { runRigorGate, type RigorRunInput } from "../lib/rigor/orchestrator.js";
import { runPanel } from "../lib/rigor/guardians/panel.js";
import { captureRun } from "../lib/rigor/capture.js";
import { exportDataset, type ExportFormat } from "../lib/rigor/exportDataset.js";
import { listHouseModels, resolveHouseModel, DEFAULT_HOUSE_MODEL } from "../lib/rigor/catalog.js";
import { runBenchmark } from "../lib/rigor/benchmark.js";
import type { ExecutorEnvelope } from "../lib/rigor/types.js";

const router: IRouter = Router();
const ADMIN_TOKEN = process.env.OPENCLAW_ADMIN_TOKEN ?? "";
const DSPY_URL = process.env.RIGOR_DSPY_URL ?? "http://127.0.0.1:8088";

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_TOKEN) return true; // no token configured → open (dev)
  const got = req.header("x-openclaw-admin-token") ?? "";
  if (got !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin token required" });
    return false;
  }
  return true;
}

/** True only for loopback callers (the DSPy sidecar). */
function isLoopback(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.")
  );
}

// ── GET /models — house catalog (OpenAI-style) ────────────────────────────────
router.get("/v1/rigor/models", async (req: Request, res: Response) => {
  try {
    const admin = ADMIN_TOKEN ? req.header("x-openclaw-admin-token") === ADMIN_TOKEN : true;
    const data = await listHouseModels(admin);
    res.json({ object: "list", data });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /models failed");
    res.status(500).json({ ok: false, error: "failed to list models" });
  }
});

// ── GET /health — panel + executor path + catalog ─────────────────────────────
router.get("/v1/rigor/health", async (_req: Request, res: Response) => {
  const keyed = Boolean(resolveApiKey("OPENROUTER_API_KEY"));
  let dspyUp = false;
  let dspyVersion: string | null = null;
  try {
    const r = await fetch(`${DSPY_URL}/health`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const j = (await r.json()) as { ok?: boolean; dspy_version?: string };
      dspyUp = Boolean(j.ok);
      dspyVersion = j.dspy_version ?? null;
    }
  } catch {
    /* sidecar down → native path */
  }
  const models = await listHouseModels(false);
  res.json({
    ok: true,
    service: "rigor-gate",
    mode: keyed ? "live" : "dry",
    guardians: ["materiality", "numerical", "hedge", "rubric"],
    executor_path: keyed && dspyUp ? "dspy" : "native",
    dspy: { up: dspyUp, version: dspyVersion, url: DSPY_URL },
    openrouter_key_present: keyed,
    catalog: models.map((m) => ({ id: m.id, tier: m.tier })),
    default_model: DEFAULT_HOUSE_MODEL,
  });
});

// ── POST /_score — loopback scorer for the DSPy sidecar (localhost-only) ───────
// Returns {score(0..1), verdicts, pass} — the shape app.py's reward_fn expects.
router.post("/v1/rigor/_score", async (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ ok: false, error: "score endpoint is loopback-only" });
    return;
  }
  const envelope = req.body?.envelope as ExecutorEnvelope | undefined;
  if (!envelope || typeof envelope !== "object") {
    res.status(400).json({ ok: false, error: "envelope required" });
    return;
  }
  try {
    const panel = await runPanel(envelope);
    // Sidecar reward wants 0..1; panel.score is 0..100.
    res.json({ score: panel.score / 100, pass: panel.pass, verdicts: panel.verdicts });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /_score failed");
    res.status(500).json({ score: 0, pass: false, verdicts: [], error: String(err) });
  }
});

// ── shared run handler for /chat and /run ─────────────────────────────────────
async function handleRun(req: Request, res: Response, wrapperShape: boolean): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = req.body ?? {};
  const prompt: string =
    typeof body.prompt === "string"
      ? body.prompt
      : Array.isArray(body.messages)
        ? String(body.messages[body.messages.length - 1]?.content ?? "")
        : "";
  if (!prompt.trim()) {
    res.status(400).json({ ok: false, error: "prompt (or messages) required" });
    return;
  }
  const houseModel: string = typeof body.model === "string" ? body.model : body.house_model ?? DEFAULT_HOUSE_MODEL;
  const resolved = await resolveHouseModel(houseModel);
  if (!resolved) {
    res.status(400).json({ ok: false, error: `unknown house model "${houseModel}"` });
    return;
  }

  const input: RigorRunInput = {
    prompt,
    house_model: houseModel,
    task_type: typeof body.task_type === "string" ? body.task_type : "general",
    contract: body.contract && typeof body.contract === "object" ? body.contract : undefined,
    seed_artifacts: Array.isArray(body.seed_artifacts) ? body.seed_artifacts : undefined,
    force_native: body.force_native === true,
  };

  try {
    const result = await runRigorGate(input);
    const capture = await captureRun(result, prompt);

    if (wrapperShape) {
      // OpenAI-ish chat completion shape + verdict wrapper.
      res.json({
        id: result.run_id,
        object: "rigor.chat.completion",
        model: houseModel,
        verdict: result.verdict,
        mode: result.mode,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.final_envelope.answer_text },
            artifacts: result.final_envelope.artifacts,
            finish_reason: result.verdict === "PASS" ? "stop" : "escalated",
          },
        ],
        rigor: {
          score_before: result.rigor_score_before,
          score_after: result.rigor_score_after,
          n_attempts: result.n_attempts,
          escalated: result.escalated,
          executor_path: result.executor_path,
          model_path: result.model_path,
          guardian_verdicts: result.attempts.at(-1)?.panel.verdicts ?? [],
        },
        capture,
      });
    } else {
      res.json({ ok: true, result, capture });
    }
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] run failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
}

// ── POST /chat — the wrapper ──────────────────────────────────────────────────
router.post("/v1/rigor/chat", (req: Request, res: Response) => {
  void handleRun(req, res, true);
});

// ── POST /run — full gated run ────────────────────────────────────────────────
router.post("/v1/rigor/run", (req: Request, res: Response) => {
  void handleRun(req, res, false);
});

// ── GET /dataset/export — SFT/DPO JSONL (LITERAL before :param routes) ────────
router.get("/v1/rigor/dataset/export", async (req: Request, res: Response) => {
  const format = (req.query.format as string) === "sft" ? "sft" : "dpo";
  try {
    const { jsonl, count } = await exportDataset(format as ExportFormat);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("X-Rigor-Export-Count", String(count));
    res.setHeader("X-Rigor-Export-Format", format);
    res.send(jsonl);
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] export failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /dataset — lake summary ───────────────────────────────────────────────
router.get("/v1/rigor/dataset", async (_req: Request, res: Response) => {
  try {
    const totalRes = await pool.query(`SELECT count(*)::int AS n FROM zie_rigor_records`);
    const escRes = await pool.query(`SELECT count(*)::int AS n FROM zie_rigor_records WHERE escalated = true`);
    const pairRes = await pool.query(
      `SELECT count(*)::int AS n FROM zie_preference_pairs WHERE preference_source = 'rigor_gate'`,
    );
    const total = (totalRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    const escalated = (escRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    const pairs = (pairRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    res.json({ ok: true, records: total, escalated, passed: total - escalated, dpo_pairs: pairs });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /dataset failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /runs — recent captured runs (LITERAL before :param) ──────────────────
router.get("/v1/rigor/runs", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? "50"), 500);
  try {
    const res2 = await pool.query(
      `SELECT id, task_type, house_model, attempts, executor_path,
              rigor_score_before, rigor_score_after, escalated, created_at
         FROM zie_rigor_records
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ ok: true, runs: res2.rows });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /runs failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /run/:id — one captured run (PARAM route, registered AFTER literals) ──
router.get("/v1/rigor/run/:id", async (req: Request, res: Response) => {
  try {
    const res2 = await pool.query(`SELECT * FROM zie_rigor_records WHERE id = $1 LIMIT 1`, [
      Number(req.params.id),
    ]);
    if (!res2.rows[0]) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({ ok: true, run: res2.rows[0] });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /run/:id failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── POST /benchmark — run the fixture suite (admin) ───────────────────────────
router.post("/v1/rigor/benchmark", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const metrics = await runBenchmark();
    res.json({ ok: true, metrics });
  } catch (err) {
    logger.error({ err: String(err) }, "[rigor] /benchmark failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
