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

const MOCK_ORGS: CrunchbaseOrg[] = [
  {
    identifier: { permalink: "sequoia-capital", value: "Sequoia Capital" },
    short_description: "Sequoia helps daring founders build legendary companies from idea to IPO and beyond.",
    funding_total: { value_usd: 0 },
    last_funding_type: "venture",
    investor_stage: ["seed", "series_a", "series_b", "growth"],
    location_identifiers: [{ value: "Menlo Park, CA", location_type: "city" }],
    website: { value: "https://www.sequoiacap.com" },
    num_employees_enum: "101-250",
  },
  {
    identifier: { permalink: "andreessen-horowitz", value: "Andreessen Horowitz" },
    short_description: "a16z backs bold entrepreneurs building the future through technology.",
    funding_total: { value_usd: 0 },
    last_funding_type: "venture",
    investor_stage: ["seed", "series_a", "series_b", "growth", "late_stage"],
    location_identifiers: [{ value: "Menlo Park, CA", location_type: "city" }],
    website: { value: "https://a16z.com" },
    num_employees_enum: "251-500",
  },
  {
    identifier: { permalink: "y-combinator", value: "Y Combinator" },
    short_description: "Y Combinator provides seed funding for startups twice a year.",
    funding_total: { value_usd: 0 },
    last_funding_type: "accelerator",
    investor_stage: ["seed", "pre_seed"],
    location_identifiers: [{ value: "Mountain View, CA", location_type: "city" }],
    website: { value: "https://www.ycombinator.com" },
    num_employees_enum: "51-100",
  },
  {
    identifier: { permalink: "benchmark", value: "Benchmark" },
    short_description: "Benchmark is an early-stage venture capital firm based in San Francisco.",
    investor_stage: ["seed", "series_a", "series_b"],
    location_identifiers: [{ value: "San Francisco, CA", location_type: "city" }],
    website: { value: "https://benchmark.com" },
    num_employees_enum: "11-50",
  },
  {
    identifier: { permalink: "founders-fund", value: "Founders Fund" },
    short_description: "Founders Fund invests in science and technology companies solving difficult problems.",
    investor_stage: ["series_a", "series_b", "growth"],
    location_identifiers: [{ value: "San Francisco, CA", location_type: "city" }],
    website: { value: "https://foundersfund.com" },
    num_employees_enum: "11-50",
  },
  {
    identifier: { permalink: "general-catalyst", value: "General Catalyst" },
    short_description: "General Catalyst is a multi-stage venture capital firm investing in technology companies.",
    investor_stage: ["seed", "series_a", "series_b", "growth"],
    location_identifiers: [{ value: "Cambridge, MA", location_type: "city" }],
    website: { value: "https://www.generalcatalyst.com" },
    num_employees_enum: "51-100",
  },
  {
    identifier: { permalink: "accel", value: "Accel" },
    short_description: "Accel is a leading global venture capital firm that partners with exceptional founding teams.",
    investor_stage: ["seed", "series_a", "series_b"],
    location_identifiers: [{ value: "Palo Alto, CA", location_type: "city" }],
    website: { value: "https://www.accel.com" },
    num_employees_enum: "101-250",
  },
  {
    identifier: { permalink: "kleiner-perkins", value: "Kleiner Perkins" },
    short_description: "Kleiner Perkins is a Silicon Valley venture capital firm focused on technology and life sciences.",
    investor_stage: ["series_a", "series_b", "growth"],
    location_identifiers: [{ value: "Menlo Park, CA", location_type: "city" }],
    website: { value: "https://www.kleinerperkins.com" },
    num_employees_enum: "51-100",
  },
];

const CRUNCHBASE_BASE = "https://api.crunchbase.com/api/v4";

export async function searchInvestors(
  query: string,
  apiKey: string | null,
  limit = 10,
): Promise<CrunchbaseSearchResult> {
  if (apiKey) {
    try {
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
      });
      if (resp.ok) {
        const data = await resp.json() as { entities: CrunchbaseOrg[]; count: number };
        return data;
      }
    } catch {
      // fall through to mock
    }
  }

  const q = query.toLowerCase();
  const filtered = q
    ? MOCK_ORGS.filter(
        (o) =>
          o.identifier.value.toLowerCase().includes(q) ||
          o.short_description.toLowerCase().includes(q) ||
          o.location_identifiers?.some((l) => l.value.toLowerCase().includes(q)),
      )
    : MOCK_ORGS;

  return {
    entities: filtered.slice(0, limit),
    count: filtered.length,
  };
}
