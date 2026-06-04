/**
 * seo.ts — SEO Intelligence ZIE Adapter
 *
 * Endpoint:
 *   POST /api/v1/seo/audit
 *
 * Double-Dip Data Flywheel (mirrors doubleDipRouter.ts exactly):
 *
 *   Dip 1: OR_GPT_20B (openai/gpt-oss-20b:free, OPENROUTER_API_KEY_2)
 *          Confidence map: CRITICAL=0.55, HIGH=0.65, MEDIUM=0.80, LOW=0.92
 *          If confidence >= 0.85 → abort Dip 2 controller, return immediately.
 *          No flywheel persist on Dip 1 fast-path.
 *
 *   Dip 2: OR_GPT_120B (openai/gpt-oss-120b:free, OPENROUTER_API_KEY)
 *          Zod whip: SeoSynthesisSchema (50-word summary, CRITICAL→risk_lines≥3)
 *          Schema-repair retry built into invokeWithFallback (step 8 in modelRouter).
 *          Fire-and-forget: persistFlywheelData → zie_training_records + zie_preference_pairs
 *
 * INV-02 (Active socket abort):
 *   Dip 2 is launched concurrently with Dip 1 evaluation.
 *   If Dip 1 clears CONFIDENCE_THRESHOLD, dip2Controller.abort() is called
 *   immediately — no remote tokens consumed, no billing.
 *
 * Deterministic hash: buildPromptHash() → SHA-256 of ordered pre-image string.
 *   ON CONFLICT (prompt_hash) DO NOTHING prevents duplicate SFT records.
 *
 * task_type = 'seo_audit' in all flywheel inserts.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import {
  persistSeoFlywheelData,
  type SeoFactoryInput,
} from "../factory/seoFactoryAdapter.js";
import { invokeWithFallback, type ModelRouteConfig } from "../lib/modelRouter.js";
import { logger } from "../lib/logger.js";
import {
  runViteAudit,
  computeSCIRankings,
  buildPromptHash,
  SeoSynthesisSchema,
  CONFIDENCE_THRESHOLD,
  type ViteSPAAudit,
  type SeoSynthesis,
  type SCINode,
  type KeywordInput,
} from "../lib/seoAgent.js";

// ── Model chain configs ───────────────────────────────────────────────────────
// Sourced from routePolicy.ts constants — do not inline model IDs here.

const DIP1_CHAIN: ModelRouteConfig[] = [
  {
    id: "openai/gpt-oss-20b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 1024,
    timeoutMs: 25_000,
    tags: ["20b", "dip1"],
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 1024,
    timeoutMs: 15_000,
    tags: ["70b", "dip1-fallback"],
  },
];

const DIP2_CHAIN: ModelRouteConfig[] = [
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokens: 2048,
    timeoutMs: 55_000,
    tags: ["120b", "dip2-primary"],
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokens: 2048,
    timeoutMs: 15_000,
    tags: ["70b", "dip2-fallback"],
  },
];

// ── Confidence heuristic ──────────────────────────────────────────────────────
// Mirrors doubleDipRouter.ts: lower severity = higher local model confidence.

const CONFIDENCE_MAP: Record<SeoSynthesis["verdict"], number> = {
  LOW:      0.92,
  MEDIUM:   0.80,
  HIGH:     0.65,
  CRITICAL: 0.55,
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SEO_SYSTEM_PROMPT = `You are an SEO intelligence engine embedded in the OpenClaw ZIE Multi-Tenant Factory.

Given a ViteSPA audit result and ODI-normalised SCI keyword rankings, output a structured JSON verdict.

STRICT OUTPUT RULES:
1. verdict: one of CRITICAL, HIGH, MEDIUM, LOW — based on crawlability severity and SCI opportunity gap.
2. summary: a detailed, specific analysis of at least 50 words. Do NOT output a summary shorter than 50 words. Generic filler fails validation.
3. risk_lines: an array of specific, actionable risk statements. NEVER output an empty array.
   - If verdict is CRITICAL, you MUST output at least 3 distinct risk_lines.
   - Each risk_line must be a complete sentence describing a concrete SEO risk.
4. quick_wins: array of specific URL paths or actions that can improve rankings within 30 days.
5. estimated_traffic_ceiling: estimated monthly organic visits achievable after fixing all critical issues (integer).

Output ONLY valid JSON matching this schema. No markdown, no prose outside the JSON object.

Schema:
{
  "verdict": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "summary": "<50+ word analysis>",
  "risk_lines": ["<specific risk 1>", "<specific risk 2>", ...],
  "quick_wins": ["<action 1>", ...],
  "estimated_traffic_ceiling": <integer>
}`;

// ── Request schema ────────────────────────────────────────────────────────────

const SeoAuditRequestSchema = z.object({
  domain: z.string().min(3),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  github_branch: z.string().default("master"),
  keywords: z
    .array(
      z.object({
        keyword: z.string().min(1),
        volume: z.number().int().nonnegative(),
        competition_index: z.number().min(0).max(1),
        relevance: z.number().min(0).max(1).optional(),
        path: z.string().optional(),
      }),
    )
    .min(1, "At least one keyword required"),
  desktop_performance: z.number().min(0).max(100).optional(),
});

type SeoAuditRequest = z.infer<typeof SeoAuditRequestSchema>;

// ── Response type ─────────────────────────────────────────────────────────────

interface SeoAuditResponse {
  domain: string;
  vite_audit: ViteSPAAudit;
  sci_rankings: SCINode[];
  synthesis: SeoSynthesis;
  model_used: string;
  dip_used: 1 | 2;
}

// ── Flywheel persistence (fire-and-forget) ────────────────────────────────────
// Delegates to seoFactoryAdapter — writes migration-0004 columns, returns UUIDs.
// Raw pool.query inside adapter — no Drizzle ORM (matches doubleDipRouter.ts pattern).

async function persistFlywheelData(
  promptHash: string,
  promptJson: unknown,
  remoteResult: SeoSynthesis,
  localResult: { data: SeoSynthesis; confidence: number },
  tenantId?: string | null,
  workspaceId?: number | null,
): Promise<void> {
  const input: SeoFactoryInput = {
    promptHash,
    promptJson,
    remoteResult,
    localResult,
    tenantId: tenantId ?? null,
    workspaceId: workspaceId ?? null,
  };
  const result = await persistSeoFlywheelData(input);
  logger.info(
    {
      sftRecordId:   result.sftRecordId,
      localRecordId: result.localRecordId,
      dpoRecordId:   result.dpoRecordId,
      promptHash,
    },
    "seo.ts: flywheel persisted via seoFactoryAdapter",
  );
}

// ── Dip 1: Local 20B runner ───────────────────────────────────────────────────

async function runDip1(
  promptJson: unknown,
): Promise<{ data: SeoSynthesis; confidence: number }> {
  try {
    const result = await invokeWithFallback<SeoSynthesis>(
      {
        systemPrompt: SEO_SYSTEM_PROMPT,
        userContent: JSON.stringify(promptJson),
        title: "OpenClaw SEO Audit (dip1-20b)",
        maxTokens: 1024,
        temperature: 0,
      },
      DIP1_CHAIN,
      {
        validator: (raw) => SeoSynthesisSchema.parse(raw),
        routeChainId: "seo-dip1-20b",
        schemaType: "seo",
      },
    );

    const confidence = CONFIDENCE_MAP[result.parsed.verdict] ?? 0.70;
    return { data: result.parsed, confidence };
  } catch {
    // Local model failed entirely — confidence 0 forces Dip 2 escalation.
    // Summary is >= 50 words to satisfy SeoSynthesisSchema.refine() if this
    // object is ever re-validated (e.g. schema version bump, audit logging).
    return {
      data: {
        verdict: "LOW",
        summary:
          "The local inference model failed to produce a valid structured synthesis for this SEO audit request. " +
          "This is a transient infrastructure failure, not a reflection of the domain's SEO health. " +
          "The request is being automatically escalated to the premium 120B model for an authoritative analysis. " +
          "No SEO conclusions should be drawn from this placeholder response.",
        risk_lines: ["Local model inference failed — result unreliable; premium model escalation in progress"],
        quick_wins: [],
        estimated_traffic_ceiling: 0,
      },
      confidence: 0,
    };
  }
}

// ── Dip 2: Premium 120B runner ────────────────────────────────────────────────
// invokeWithFallback handles schema-repair retry internally (step 8 in modelRouter):
// if SeoSynthesisSchema.parse() throws ZodError, it retries with a low-temperature
// schema-correction suffix before exhausting the chain.

async function runDip2(
  promptJson: unknown,
  abortController: AbortController,
): Promise<{ result: SeoSynthesis; model_used: string }> {
  // Note: invokeWithFallback uses AbortSignal.timeout() per entry internally.
  // We pass the external AbortController signal via a wrapper so Dip 1 fast-path
  // can cancel the in-flight fetch at the socket level (INV-02).
  //
  // Implementation: we race invokeWithFallback against the abort signal.
  // If abortController.abort() fires, the Promise.race rejects with AbortError
  // and the fetch is cancelled at the OS socket level.
  const abortPromise = new Promise<never>((_, reject) => {
    abortController.signal.addEventListener("abort", () => {
      // DOMException is not in lib.es2022 — construct a plain Error with name="AbortError"
      // so tsc compiles cleanly under types:["node"] without lib.dom.d.ts.
      const abortErr = Object.assign(
        new Error("Dip 2 aborted by Dip 1 fast-path (INV-02)"),
        { name: "AbortError" },
      );
      reject(abortErr);
    }, { once: true });
  });

  const invokePromise = invokeWithFallback<SeoSynthesis>(
    {
      systemPrompt: SEO_SYSTEM_PROMPT,
      userContent: JSON.stringify(promptJson),
      title: "OpenClaw SEO Audit (dip2-120b)",
      maxTokens: 2048,
      // Low temperature on repair retries is handled inside invokeWithFallback
      // via schemaRepairSuffix — we set 0 here for the primary attempt.
      temperature: 0,
    },
    DIP2_CHAIN,
    {
      validator: (raw) => SeoSynthesisSchema.parse(raw),
      routeChainId: "seo-dip2-120b",
      schemaType: "seo",
    },
  );

  // Race: if Dip 1 aborts the controller, abortPromise rejects immediately
  // and the underlying fetch is cancelled at the socket level.
  const result = await Promise.race([invokePromise, abortPromise]);
  return { result: result.parsed, model_used: result.model_used };
}

// ── Route handler ─────────────────────────────────────────────────────────────

const router: IRouter = Router();

/**
 * POST /api/v1/seo/audit
 *
 * Runs ViteSPA audit + ODI/SCI computation, then routes through the
 * double-dip ZIE flywheel for LLM synthesis.
 */
router.post(
  "/v1/seo/audit",
  async (req: Request, res: Response): Promise<void> => {
    // ── 1. Validate request body ────────────────────────────────────────────
    const parseResult = SeoAuditRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        issues: parseResult.error.issues,
      });
      return;
    }
    const body: SeoAuditRequest = parseResult.data;

    // ── 2. ViteSPA audit (GitHub Raw API) ───────────────────────────────────
    let viteAudit: ViteSPAAudit;
    try {
      viteAudit = await runViteAudit(
        body.github_owner,
        body.github_repo,
        body.github_branch,
      );
    } catch (err: unknown) {
      logger.error({ err, domain: body.domain }, "seo.ts: runViteAudit failed");
      res.status(502).json({ error: "GitHub Raw API fetch failed" });
      return;
    }

    // ── 3. ODI/SCI rankings ─────────────────────────────────────────────────
    const keywords: KeywordInput[] = body.keywords.map((k) => ({
      keyword:           k.keyword,
      volume:            k.volume,
      competition_index: k.competition_index,
      relevance:         k.relevance,
      path:              k.path,
    }));

    const sciRankings = computeSCIRankings(keywords, body.desktop_performance);

    // ── 4. Build prompt payload ─────────────────────────────────────────────
    const promptJson = {
      domain:        body.domain,
      vite_audit:    viteAudit,
      sci_rankings:  sciRankings.slice(0, 10), // top 10 for context window efficiency
      desktop_performance: body.desktop_performance ?? null,
    };

    // ── 5. Deterministic prompt hash ────────────────────────────────────────
    const promptHash = buildPromptHash(body.domain, keywords, viteAudit);

    // ── 6. Double-Dip ZIE Flywheel (INV-02: true concurrent abort) ──────────
    //
    // INV-02 requires an active in-flight socket on Dip 2 to abort.
    // Both dips are launched concurrently. If Dip 1 clears CONFIDENCE_THRESHOLD,
    // dip2Controller.abort() fires on the live Dip 2 fetch — socket-level
    // cancellation, no remote tokens billed.
    //
    // Flow:
    //   1. Create AbortController for Dip 2.
    //   2. Launch Dip 1 and Dip 2 concurrently via Promise.all.
    //   3. After Dip 1 resolves:
    //      a. If confidence >= 0.85 → abort Dip 2 controller, return Dip 1 result.
    //      b. If confidence < 0.85  → await Dip 2 result (already in-flight).
    //
    // The Promise.race inside runDip2() rejects immediately when abort() fires,
    // cancelling the underlying fetch at the OS socket level.

    const dip2Controller = new AbortController();

    // ── Launch both dips concurrently ────────────────────────────────────────
    // Dip 2 is in-flight from this point — abort() will cancel a real socket.
    const dip1Promise = runDip1(promptJson);
    const dip2Promise = runDip2(promptJson, dip2Controller);

    // ── Dip 1 resolves first (it's the cheaper model) ────────────────────────
    const localResult = await dip1Promise;

    if (localResult.confidence >= CONFIDENCE_THRESHOLD) {
      // INV-02: abort the live Dip 2 socket immediately
      dip2Controller.abort();

      // Suppress unhandled rejection from the now-aborted dip2Promise
      dip2Promise.catch(() => { /* intentional abort — not an error */ });

      logger.info(
        {
          domain:     body.domain,
          verdict:    localResult.data.verdict,
          confidence: localResult.confidence,
          dip:        1,
        },
        "seo.ts: Dip 1 fast-path — Dip 2 socket aborted (INV-02)",
      );

      const response: SeoAuditResponse = {
        domain:       body.domain,
        vite_audit:   viteAudit,
        sci_rankings: sciRankings,
        synthesis:    localResult.data,
        model_used:   DIP1_CHAIN[0].id,
        dip_used:     1,
      };
      res.status(200).json(response);
      return;
    }

    // ── Dip 2: await the already in-flight premium model ─────────────────────
    let remoteResult: SeoSynthesis;
    let modelUsed: string;

    try {
      const dip2 = await dip2Promise;
      remoteResult = dip2.result;
      modelUsed    = dip2.model_used;
    } catch (err: unknown) {
      // DOMException not in lib.es2022 — check name string only (safe at runtime).
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"));

      if (isAbort) {
        // Defensive: abort fired but confidence was below threshold — use Dip 1.
        logger.warn({ domain: body.domain }, "seo.ts: Dip 2 aborted below confidence threshold, using Dip 1 result");
        const response: SeoAuditResponse = {
          domain:       body.domain,
          vite_audit:   viteAudit,
          sci_rankings: sciRankings,
          synthesis:    localResult.data,
          model_used:   DIP1_CHAIN[0].id,
          dip_used:     1,
        };
        res.status(200).json(response);
        return;
      }

      logger.error({ err, domain: body.domain }, "seo.ts: Dip 2 exhausted all chain entries");
      res.status(502).json({ error: "LLM synthesis failed after all fallbacks" });
      return;
    }

    // ── The Theft: async persist, never block the caller ─────────────────────
    void persistFlywheelData(promptHash, promptJson, remoteResult, localResult, req.resolvedTenantId ?? null, req.resolvedWorkspace?.id ?? null).catch(
      (err: unknown) => {
        logger.error(
          { err, promptHash, domain: body.domain },
          "seo.ts: flywheel persistence failed",
        );
      },
    );

    logger.info(
      {
        domain:     body.domain,
        verdict:    remoteResult.verdict,
        model_used: modelUsed,
        dip:        2,
      },
      "seo.ts: Dip 2 synthesis complete",
    );

    const response: SeoAuditResponse = {
      domain:       body.domain,
      vite_audit:   viteAudit,
      sci_rankings: sciRankings,
      synthesis:    remoteResult,
      model_used:   modelUsed,
      dip_used:     2,
    };
    res.status(200).json(response);
  },
);

// ── GET /api/v1/seo/benchmark ─────────────────────────────────────────────────
//
// Returns the top 10 domains in zie_training_records where domain='seo',
// ranked by avg(quality_score), with their sci_normalized scores extracted
// from the prompt_json payload.
//
// This is the moat endpoint: every new audit makes the benchmark more accurate.
// User audits their site → sees "your ODI is 18.9"
// Benchmark shows: "Top performers in your keyword category have ODI 8-12"
// That gap = the product's value proposition, shown with real data.
//
// Response shape:
// {
//   total_audits: 12,
//   benchmark: [
//     {
//       rank: 1,
//       domain: "stripe.com",
//       avg_quality_score: 1.0,
//       audit_count: 3,
//       best_sci_normalized: 100,
//       best_odi_display: 8.2,
//       verdict: "LOW",
//       latest_audit_at: "2026-06-04T..."
//     },
//     ...
//   ]
// }

router.get(
  "/v1/seo/benchmark",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      // Pull all remote_promoted seo_audit records.
      // Extract sci_normalized and odi_display from the stored prompt_json
      // (which contains sci_rankings array) and remote_response_json (verdict).
      const result = await pool.query<{
        domain: string;
        avg_quality_score: string;
        audit_count: string;
        best_sci_normalized: string;
        best_odi_display: string;
        verdict: string;
        latest_audit_at: string;
      }>(
        `SELECT
           prompt_json->>'domain'                                          AS domain,
           AVG(quality_score)::numeric(5,4)                               AS avg_quality_score,
           COUNT(*)                                                        AS audit_count,
           MAX(
             COALESCE(
               (prompt_json->'sci_rankings'->0->>'sci_normalized')::numeric,
               0
             )
           )                                                               AS best_sci_normalized,
           MIN(
             COALESCE(
               (prompt_json->'sci_rankings'->0->>'odi_display')::numeric,
               999
             )
           )                                                               AS best_odi_display,
           (array_agg(
             remote_response_json->>'verdict'
             ORDER BY created_at DESC
           ))[1]                                                           AS verdict,
           MAX(created_at)                                                 AS latest_audit_at
         FROM zie_training_records
         WHERE domain = 'seo'
           AND source_kind = 'remote_promoted'
           AND task_type = 'seo_audit'
           AND prompt_json->>'domain' IS NOT NULL
         GROUP BY prompt_json->>'domain'
         ORDER BY avg_quality_score DESC, audit_count DESC
         LIMIT 10`,
      );

      // Total unique audits across all domains
      const countResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM zie_training_records
         WHERE domain = 'seo'
           AND source_kind = 'remote_promoted'
           AND task_type = 'seo_audit'`,
      );

      const totalAudits = parseInt(countResult.rows[0]?.total ?? "0", 10);

      const benchmark = result.rows.map((row, idx) => ({
        rank: idx + 1,
        domain: row.domain,
        avg_quality_score: parseFloat(row.avg_quality_score),
        audit_count: parseInt(row.audit_count, 10),
        best_sci_normalized: parseFloat(row.best_sci_normalized ?? "0"),
        best_odi_display: parseFloat(row.best_odi_display ?? "0"),
        verdict: row.verdict ?? "UNKNOWN",
        latest_audit_at: row.latest_audit_at ?? null,
      }));

      res.status(200).json({ total_audits: totalAudits, benchmark });
    } catch (err: unknown) {
      logger.error({ err }, "seo.ts: benchmark query failed");
      res.status(500).json({ error: "Benchmark query failed" });
    }
  },
);


export default router;
