export interface CrunchbaseOrg {
  identifier: { permalink: string; value: string; image_id?: string };
  short_description: string;
  funding_total?: { value_usd: number };
  last_funding_type?: string;
  investor_stage?: string[];
  location_identifiers?: { value: string; location_type: string }[];
  website?: { value: string };
  num_employees_enum?: string;
}

export interface CrunchbaseSearchResult {
  entities: CrunchbaseOrg[];
  count: number;
}

const CRUNCHBASE_BASE = "https://api.crunchbase.com/api/v4";

/**
 * Search investors via the Crunchbase API v4.
 *
 * Requires a valid Crunchbase API key (user_key). If no key is provided,
 * returns an honest error instead of mock data — there is no fallback.
 */
export async function searchInvestors(
  query: string,
  apiKey: string | null,
  limit = 10,
): Promise<CrunchbaseSearchResult> {
  if (!apiKey) {
    throw new Error(
      "Crunchbase API key not configured. Set CRUNCHBASE_API_KEY to enable investor search. No mock fallback is provided.",
    );
  }

  const resp = await fetch(`${CRUNCHBASE_BASE}/searches/organizations?user_key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      field_ids: [
        "identifier",
        "short_description",
        "funding_total",
        "last_funding_type",
        "investor_stage",
        "location_identifiers",
        "website",
        "num_employees_enum",
      ],
      query: [
        { type: "predicate", field_id: "facet_ids", operator_id: "includes", values: ["investor"] },
        ...(query
          ? [{ type: "predicate", field_id: "identifier", operator_id: "contains", values: [query] }]
          : []),
      ],
      limit,
      order: [{ field_id: "rank_org", sort: "asc" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Crunchbase API error: HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { entities: CrunchbaseOrg[]; count: number };
  return data;
}
