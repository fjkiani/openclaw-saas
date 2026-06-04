/**
 * seoAgent.ts
 *
 * SEO Intelligence — ZIE Adapter (pure computation layer).
 *
 * Responsibilities:
 *   1. Zod schemas: ViteSPAAuditSchema, SCINodeSchema, SeoSynthesisSchema (Zod whip)
 *   2. runViteAudit()    — GitHub Raw API fetches, no git clone
 *   3. computeODI()      — PATH A formula (signed Fahad Kiani 2026-04-28)
 *   4. computeSCIRankings() — ODI-normalised SCI table
 *
 * ODI Formula (PATH A — locked):
 *   PSI = 1 - (desktop_performance / 100)   // default 0.30 when unavailable
 *   ODI = (competition_index × 0.7) + (PSI × 0.3)
 *   ODI_floor = 0.01
 *
 *   SCI = (volume × relevance) / (ODI × competitor_score)
 *   sci_normalized = (sci / max_sci) × 100
 *
 * No side effects. No DB calls. No LLM calls. Imported by seo.ts.
 */

import { createHash } from "crypto";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────────────────

export const PSI_DEFAULT = 0.30;   // PageSpeed unavailable fallback
export const ODI_FLOOR   = 0.01;   // avoid division by zero
export const CONFIDENCE_THRESHOLD = 0.85;

// GitHub Raw base — no auth required for public repos
const GH_RAW = "https://raw.githubusercontent.com";

// ── Zod Schemas ───────────────────────────────────────────────────────────────

export const ViteSPAAuditSchema = z.object({
  is_bare_spa:                z.boolean(),
  routing_type:               z.enum(["BrowserRouter", "HashRouter", "unknown"]),
  pre_rendering_detected:     z.boolean(),
  client_side_fetch_detected: z.boolean(),
  sitemap_exists:             z.boolean(),
  /** true when sitemap points Google at unrenderable SPA shells */
  sitemap_harmful:            z.boolean(),
  /** All route path strings that contain a dynamic segment (":param") */
  dynamic_routes:             z.array(z.string()),
  severity:                   z.enum(["OK", "WARNING", "CRITICAL"]),
});
export type ViteSPAAudit = z.infer<typeof ViteSPAAuditSchema>;

export const SCINodeSchema = z.object({
  rank:                z.number().int().positive(),
  path:                z.string(),
  keyword:             z.string(),
  volume:              z.number().int().nonnegative(),
  competition_index:   z.number().min(0).max(1),
  pagespeed_impact:    z.number().min(0).max(1),
  odi:                 z.number().min(0),
  odi_display:         z.number().min(0),
  sci:                 z.number().min(0),
  sci_normalized:      z.number().min(0).max(100),
});
export type SCINode = z.infer<typeof SCINodeSchema>;

/**
 * SeoSynthesisSchema — Zod whip.
 *
 * Enforcements:
 *   1. summary: strict 50-word minimum (z.string().min(N) counts characters, not words)
 *   2. risk_lines: always required, min 1 item
 *   3. superRefine: verdict === "CRITICAL" → risk_lines.length >= 3
 */
export const SeoSynthesisSchema = z
  .object({
    verdict: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    summary: z
      .string()
      .refine(
        (s) => s.split(/\s+/).filter(Boolean).length >= 50,
        { message: "Summary must be at least 50 words" },
      ),
    risk_lines: z
      .array(z.string().min(10))
      .min(1, "risk_lines cannot be empty"),
    quick_wins: z.array(z.string()),
    estimated_traffic_ceiling: z.number().nonnegative(),
  })
  .superRefine((data, ctx) => {
    if (data.verdict === "CRITICAL" && data.risk_lines.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "CRITICAL verdict requires at least 3 specific risk_lines. " +
          `Received ${data.risk_lines.length}.`,
        path: ["risk_lines"],
      });
    }
  });
export type SeoSynthesis = z.infer<typeof SeoSynthesisSchema>;

// ── Input types ───────────────────────────────────────────────────────────────

export interface KeywordInput {
  keyword: string;
  volume: number;
  competition_index: number;
  /** Relevance weight 0–1. Defaults to 1.0 if omitted. */
  relevance?: number;
  /** Target URL path on the audited domain. */
  path?: string;
}

// ── GitHub Raw API helpers ────────────────────────────────────────────────────

async function fetchRaw(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
): Promise<string | null> {
  const url = `${GH_RAW}/${owner}/${repo}/${branch}/${filePath}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Try multiple candidate filenames concurrently; return first non-null hit.
 * Uses Promise.any so all candidates race — no sequential 8s stall on 404.
 */
async function fetchFirstHit(
  owner: string,
  repo: string,
  branch: string,
  candidates: string[],
): Promise<string | null> {
  try {
    return await Promise.any(
      candidates.map(async (candidate) => {
        const content = await fetchRaw(owner, repo, branch, candidate);
        if (content === null) throw new Error("not found");
        return content;
      }),
    );
  } catch {
    // All candidates returned null (AggregateError from Promise.any)
    return null;
  }
}

// ── Dynamic route detection ───────────────────────────────────────────────────

/**
 * Universal dynamic route regex.
 *
 * Captures any quoted path string that contains "/:".
 * Works for:
 *   - Legacy JSX:   path="/solutions/:slug"
 *   - Object router: { path: "/tech/:slug" }
 *   - createBrowserRouter: { path: "tech/:slug" }
 *   - Template literals are NOT captured (backtick paths are excluded by design —
 *     they are almost always runtime-constructed and not static route definitions).
 *
 * Pattern: opening quote → capture group starting with optional "/" → must contain
 * ":" somewhere after a "/" → closing same-class quote.
 */
function extractDynamicRoutes(appContent: string): string[] {
  // Regex instantiated locally — avoids lastIndex race on concurrent requests.
  // Captures any quoted path (single or double quote) containing "/:".
  // Excludes template literals (backtick paths are runtime-constructed, not static).
  const dynamicRouteRegex = /(?:["'])(\/[^"']*:[^"']*)(?:["'])/g;
  const routes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = dynamicRouteRegex.exec(appContent)) !== null) {
    const path = match[1];
    if (!routes.includes(path)) routes.push(path);
  }
  return routes;
}

// ── runViteAudit ──────────────────────────────────────────────────────────────

/**
 * Audit a Vite SPA repository via GitHub Raw API.
 * No git clone. No local filesystem writes.
 *
 * @param owner   GitHub org/user (e.g. "fjkiani")
 * @param repo    Repository name (e.g. "jedi-v2")
 * @param branch  Branch to audit (default "master")
 */
export async function runViteAudit(
  owner: string,
  repo: string,
  branch = "master",
): Promise<ViteSPAAudit> {
  // Fetch all four files concurrently — independent requests
  const [pkgJson, viteConfig, appContent, mainContent] = await Promise.all([
    fetchRaw(owner, repo, branch, "package.json"),
    fetchFirstHit(owner, repo, branch, ["vite.config.ts", "vite.config.js"]),
    fetchFirstHit(owner, repo, branch, [
      "src/App.tsx", "src/App.jsx",
      "src/app.tsx", "src/app.jsx",
    ]),
    fetchFirstHit(owner, repo, branch, [
      "src/main.tsx", "src/main.jsx",
      "src/index.tsx", "src/index.jsx",
    ]),
  ]);

  // ── package.json analysis ─────────────────────────────────────────────────
  let deps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};
  if (pkgJson) {
    try {
      const parsed = JSON.parse(pkgJson) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps    = parsed.dependencies    ?? {};
      devDeps = parsed.devDependencies ?? {};
    } catch { /* malformed package.json — treat as empty */ }
  }
  const allDeps = { ...deps, ...devDeps };

  const preRenderingPlugins = [
    "vike", "vite-ssg", "prerender-spa-plugin",
    "@vitejs/plugin-ssr", "vite-plugin-ssr",
  ];
  const pre_rendering_detected = preRenderingPlugins.some((p) => p in allDeps);

  const clientFetchLibs = [
    "@apollo/client", "graphql-request", "swr", "react-query",
    "@tanstack/react-query",
  ];
  const client_side_fetch_detected = clientFetchLibs.some((p) => p in allDeps);

  const sitemap_exists = "vite-plugin-sitemap" in allDeps;

  // ── vite.config analysis ──────────────────────────────────────────────────
  // If vite.config exists but has no SSR/pre-render plugin, it's a bare SPA config
  const hasSSRInConfig = viteConfig
    ? /\b(ssr|prerender|vike|vite-ssg)\b/i.test(viteConfig)
    : false;

  // ── routing type ──────────────────────────────────────────────────────────
  let routing_type: ViteSPAAudit["routing_type"] = "unknown";
  const routingSource = (mainContent ?? "") + (appContent ?? "");
  if (/HashRouter/.test(routingSource))    routing_type = "HashRouter";
  else if (/BrowserRouter|createBrowserRouter/.test(routingSource)) routing_type = "BrowserRouter";

  // ── dynamic routes ────────────────────────────────────────────────────────
  const dynamic_routes = appContent ? extractDynamicRoutes(appContent) : [];

  // ── is_bare_spa ───────────────────────────────────────────────────────────
  const is_bare_spa = !pre_rendering_detected && !hasSSRInConfig;

  // ── sitemap_harmful ───────────────────────────────────────────────────────
  // Harmful when: sitemap exists AND SPA is bare (routes are unrenderable shells)
  const sitemap_harmful = sitemap_exists && is_bare_spa;

  // ── severity ──────────────────────────────────────────────────────────────
  let severity: ViteSPAAudit["severity"] = "OK";
  if (is_bare_spa && dynamic_routes.length > 0) {
    severity = dynamic_routes.length >= 5 ? "CRITICAL" : "WARNING";
  } else if (sitemap_harmful) {
    severity = "WARNING";
  }

  return ViteSPAAuditSchema.parse({
    is_bare_spa,
    routing_type,
    pre_rendering_detected,
    client_side_fetch_detected,
    sitemap_exists,
    sitemap_harmful,
    dynamic_routes,
    severity,
  });
}

// ── ODI computation (PATH A) ──────────────────────────────────────────────────

/**
 * Compute Opportunity Difficulty Index for a single keyword.
 *
 * PATH A formula (signed Fahad Kiani 2026-04-28):
 *   PSI = 1 - (desktop_performance / 100)
 *   ODI = (competition_index × 0.7) + (PSI × 0.3)
 *   ODI is clamped to [ODI_FLOOR, 1.0]
 *
 * @param competition_index  Google KW competition_index 0–1
 * @param desktop_performance  PageSpeed desktop score 0–100 (omit → PSI_DEFAULT)
 */
export function computeODI(
  competition_index: number,
  desktop_performance?: number,
): { odi: number; odi_display: number; pagespeed_impact: number } {
  const psi =
    desktop_performance !== undefined
      ? 1 - desktop_performance / 100
      : PSI_DEFAULT;

  const raw_odi = competition_index * 0.7 + psi * 0.3;
  const odi = Math.max(ODI_FLOOR, Math.min(1.0, raw_odi));
  const odi_display = Math.round(odi * 1000) / 10; // e.g. 0.189 → 18.9

  return { odi, odi_display, pagespeed_impact: psi };
}

// ── SCI rankings ──────────────────────────────────────────────────────────────

/**
 * Compute ODI-normalised SCI rankings for a keyword list.
 *
 * SCI = (volume × relevance) / (ODI × competitor_score)
 * sci_normalized = (sci / max_sci) × 100
 *
 * @param keywords           Keyword inputs with volume + competition_index
 * @param desktop_performance  PageSpeed desktop score (shared across all keywords)
 * @param competitor_score   Competitor authority multiplier (default 1.0)
 */
export function computeSCIRankings(
  keywords: KeywordInput[],
  desktop_performance?: number,
  competitor_score = 1.0,
): SCINode[] {
  if (keywords.length === 0) return [];

  // Compute raw SCI for each keyword
  const raw: Array<{
    keyword: KeywordInput;
    odi: number;
    odi_display: number;
    pagespeed_impact: number;
    sci: number;
  }> = keywords.map((kw) => {
    const { odi, odi_display, pagespeed_impact } = computeODI(
      kw.competition_index,
      desktop_performance,
    );
    const relevance = kw.relevance ?? 1.0;
    const sci = (kw.volume * relevance) / (odi * Math.max(competitor_score, 0.01));
    return { keyword: kw, odi, odi_display, pagespeed_impact, sci };
  });

  // Sort descending by SCI
  raw.sort((a, b) => b.sci - a.sci);

  const max_sci = raw[0].sci;

  return raw.map((item, idx): SCINode => ({
    rank:              idx + 1,
    path:              item.keyword.path ?? `/${item.keyword.keyword.toLowerCase().replace(/\s+/g, "-")}`,
    keyword:           item.keyword.keyword,
    volume:            item.keyword.volume,
    competition_index: item.keyword.competition_index,
    pagespeed_impact:  item.pagespeed_impact,
    odi:               item.odi,
    odi_display:       item.odi_display,
    sci:               Math.round(item.sci),
    sci_normalized:    Math.round((item.sci / max_sci) * 1000) / 10,
  }));
}

// ── Deterministic prompt hash ─────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hash for a given audit context.
 *
 * JSON.stringify() is non-deterministic (key ordering varies across V8 versions
 * and object construction paths). We use a strictly ordered string instead so
 * ON CONFLICT (prompt_hash) in zie_training_records fires correctly.
 *
 * Format: "{domain}|{sorted_keywords}|{is_bare_spa}|{severity}"
 */
export function buildPromptHash(
  domain: string,
  keywords: KeywordInput[],
  viteAudit: ViteSPAAudit,
): string {
  // Deterministic pre-image: sorted keywords prevent key-ordering collisions.
  // JSON.stringify() is non-deterministic across V8 versions — never use it here.
  const sortedKeywords = keywords
    .map((k) => k.keyword)
    .sort()
    .join(",");
  const preimage = `${domain}|${sortedKeywords}|${String(viteAudit.is_bare_spa)}|${viteAudit.severity}`;
  return createHash("sha256").update(preimage).digest("hex");
}
