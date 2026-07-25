/**
 * catalog.ts — house-model catalog resolver for the Rigor-Gate wrapper.
 *
 * Maps a public house name ("zeta-rigor-fast") to the real upstream OpenRouter
 * id. Backed by the zie_model_catalog table (seeded in index.ts ZIE migration);
 * falls back to a hard-coded default set if the DB read fails so the wrapper
 * still resolves models when the migration has not run. Paid rows are only
 * surfaced when a usable OpenRouter key is present (honest: never advertise a
 * model we cannot actually call).
 */
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import { resolveApiKey } from "../resolveApiKey.js";
import type { HouseModel } from "./types.js";

// Ordered fast→frontier. Mirrors the ZIE seed; used as fallback + swap order.
// NOTE (2026-07-25): remapped to models the live OpenRouter key can actually
// reach. The prior slugs (liquid/lfm-2.5-1.2b:free, llama-3.3-70b:free,
// gpt-oss-120b:free) were all 404 — either delisted or no longer free — and the
// account has no paid credits, so every tier maps to a verified-working free
// model. All four were probed live and returned real completions. They are
// reasoning models (emit a `reasoning` field + final `content`).
const DEFAULT_CATALOG: HouseModel[] = [
  {
    house_name: "zeta-rigor-fast",
    openrouter_id: "nvidia/nemotron-nano-9b-v2:free",
    tier: "fast",
    paid: false,
    api_key_env: "OPENROUTER_API_KEY",
    description: "Fast house model for low-latency gated completions.",
  },
  {
    house_name: "zeta-rigor-balanced",
    openrouter_id: "nvidia/nemotron-3-nano-30b-a3b:free",
    tier: "balanced",
    paid: false,
    api_key_env: "OPENROUTER_API_KEY",
    description: "Balanced house model (default) for gated completions.",
  },
  {
    house_name: "zeta-rigor-max",
    openrouter_id: "nvidia/nemotron-3-super-120b-a12b:free",
    tier: "max",
    paid: false,
    api_key_env: "OPENROUTER_API_KEY",
    description: "Max-capability free house model for hard gated tasks.",
  },
  {
    house_name: "zeta-rigor-frontier",
    openrouter_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    tier: "frontier",
    paid: false,
    api_key_env: "OPENROUTER_API_KEY",
    description: "Largest available house model for the hardest gated tasks.",
  },
];

const TIER_ORDER: Record<HouseModel["tier"], number> = {
  fast: 0,
  balanced: 1,
  max: 2,
  frontier: 3,
};

export const DEFAULT_HOUSE_MODEL = "zeta-rigor-balanced";

function haveOpenRouterKey(): boolean {
  return Boolean(resolveApiKey("OPENROUTER_API_KEY"));
}

/**
 * Load the full catalog from the DB, ordered fast→frontier. Falls back to the
 * built-in defaults on any error. Does NOT filter paid rows — see listHouseModels
 * for the key-aware public listing.
 */
export async function loadCatalog(): Promise<HouseModel[]> {
  try {
    interface CatalogRow {
      house_name: string;
      openrouter_id: string;
      tier: string;
      paid: boolean;
      description: string | null;
      enabled: boolean;
    }
    const res = await pool.query(
      `SELECT house_name, openrouter_id, tier, paid, description, enabled
         FROM zie_model_catalog
        WHERE enabled = true`,
    );
    const rows = res.rows as CatalogRow[];
    if (rows.length === 0) return [...DEFAULT_CATALOG];
    const mapped: HouseModel[] = rows.map((r: CatalogRow) => ({
      house_name: r.house_name,
      openrouter_id: r.openrouter_id,
      tier: (["fast", "balanced", "max", "frontier"].includes(r.tier)
        ? r.tier
        : "balanced") as HouseModel["tier"],
      paid: r.paid,
      api_key_env: "OPENROUTER_API_KEY",
      description: r.description ?? "",
    }));
    mapped.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
    return mapped;
  } catch (err) {
    logger.warn({ err: String(err) }, "[rigor.catalog] DB read failed; using default catalog");
    return [...DEFAULT_CATALOG];
  }
}

/**
 * Public listing (OpenAI-style-ish). Paid models are omitted unless a key is
 * present, so we never advertise something we can't serve. Never leaks the
 * upstream openrouter_id unless `includeUpstream` is set (admin path).
 */
export async function listHouseModels(includeUpstream = false): Promise<
  Array<{
    id: string;
    object: "model";
    tier: string;
    paid: boolean;
    description: string;
    owned_by: string;
    upstream?: string;
  }>
> {
  const catalog = await loadCatalog();
  const keyed = haveOpenRouterKey();
  return catalog
    .filter((m) => (m.paid ? keyed : true))
    .map((m) => ({
      id: m.house_name,
      object: "model" as const,
      tier: m.tier,
      paid: m.paid,
      description: m.description,
      owned_by: "zeta-rigor",
      ...(includeUpstream ? { upstream: m.openrouter_id } : {}),
    }));
}

/**
 * Resolve a single house name to its catalog entry. Returns null if unknown.
 */
export async function resolveHouseModel(houseName: string): Promise<HouseModel | null> {
  const catalog = await loadCatalog();
  return catalog.find((m) => m.house_name === houseName) ?? null;
}

/**
 * The model-swap chain for the orchestrator: the requested model first, then the
 * remaining enabled models in ascending tier order (skipping the requested one,
 * and skipping paid rows when no key is present). This is the black-box analogue
 * of GraySwan's "reroute": on repeated failure, escalate to a stronger model.
 */
export async function buildSwapChain(startHouseName: string): Promise<HouseModel[]> {
  const catalog = await loadCatalog();
  const keyed = haveOpenRouterKey();
  const usable = catalog.filter((m) => (m.paid ? keyed : true));
  const start = usable.find((m) => m.house_name === startHouseName);
  const rest = usable.filter((m) => m.house_name !== startHouseName);
  return start ? [start, ...rest] : usable;
}
