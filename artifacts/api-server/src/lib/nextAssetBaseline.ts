/**
 * next_asset_baseline.ts — Termination Clause Structured Extraction Baseline
 *
 * Evaluates gpt-oss-20b zero-shot on structured field extraction from termination clauses.
 * Task: given a termination clause, extract:
 *   - notice_period_days: int|null
 *   - trigger: string
 *   - survival_clauses: string[]
 *   - effective_date: string|null
 *
 * Run via: POST /api/v1/legal/next-asset-baseline
 * Returns: field-level accuracy, hallucination rate, JSON compliance, per-example results
 */

export const TERMINATION_EXAMPLES = [
  {
    id: 1,
    text: "Either party may terminate this Agreement upon thirty (30) days prior written notice to the other party. Upon termination, Sections 5 (Confidentiality), 7 (Indemnification), and 9 (Limitation of Liability) shall survive.",
    ground_truth: { notice_period_days: 30, trigger: "written notice by either party", survival_clauses: ["Confidentiality", "Indemnification", "Limitation of Liability"], effective_date: null }
  },
  {
    id: 2,
    text: "This Agreement shall terminate automatically upon the expiration of the License Term set forth in Exhibit A, unless earlier terminated. Either party may terminate immediately upon written notice if the other party materially breaches this Agreement and fails to cure such breach within fifteen (15) days after written notice thereof.",
    ground_truth: { notice_period_days: 15, trigger: "material breach uncured after notice", survival_clauses: [], effective_date: null }
  },
  {
    id: 3,
    text: "Company may terminate this Agreement immediately upon written notice if Contractor: (i) becomes insolvent; (ii) makes an assignment for the benefit of creditors; or (iii) has a receiver appointed. No notice period is required for termination under this Section.",
    ground_truth: { notice_period_days: 0, trigger: "insolvency, assignment for creditors, or receiver appointment", survival_clauses: [], effective_date: null }
  },
  {
    id: 4,
    text: "Either party may terminate this Agreement for convenience upon sixty (60) days written notice. Upon expiration or termination, the following provisions shall survive: Sections 3 (Ownership), 6 (Warranties), 8 (Indemnification), 10 (Governing Law), and 12 (Dispute Resolution).",
    ground_truth: { notice_period_days: 60, trigger: "convenience, written notice by either party", survival_clauses: ["Ownership", "Warranties", "Indemnification", "Governing Law", "Dispute Resolution"], effective_date: null }
  },
  {
    id: 5,
    text: "This Agreement will terminate on December 31, 2025, unless the parties agree in writing to extend the term. Either party may terminate this Agreement upon ninety (90) days prior written notice.",
    ground_truth: { notice_period_days: 90, trigger: "written notice by either party or fixed end date", survival_clauses: [], effective_date: "December 31, 2025" }
  },
  {
    id: 6,
    text: "Licensor may terminate this license immediately, without notice, if Licensee breaches any provision of this Agreement. Upon termination, Licensee shall immediately cease all use of the Licensed Software and destroy all copies.",
    ground_truth: { notice_period_days: 0, trigger: "breach by Licensee", survival_clauses: [], effective_date: null }
  },
  {
    id: 7,
    text: "Either party may terminate this Agreement without cause upon one hundred twenty (120) days written notice. Termination shall not relieve either party of obligations accrued prior to the effective date of termination. Sections 4, 7, 9, and 11 shall survive termination.",
    ground_truth: { notice_period_days: 120, trigger: "without cause, written notice by either party", survival_clauses: ["Section 4", "Section 7", "Section 9", "Section 11"], effective_date: null }
  },
  {
    id: 8,
    text: "This Agreement may be terminated by either party upon seven (7) days written notice in the event of a material breach by the other party that remains uncured for five (5) days following written notice of such breach.",
    ground_truth: { notice_period_days: 7, trigger: "material breach uncured after 5 days notice", survival_clauses: [], effective_date: null }
  },
  {
    id: 9,
    text: "The Agreement shall terminate upon the completion of the Services described in Statement of Work #1, unless earlier terminated. Either party may terminate for convenience with thirty (30) days notice. The confidentiality obligations in Section 6 shall survive for a period of three (3) years following termination.",
    ground_truth: { notice_period_days: 30, trigger: "completion of services or convenience", survival_clauses: ["Confidentiality (Section 6, 3 years)"], effective_date: null }
  },
  {
    id: 10,
    text: "Either party may terminate this Agreement upon written notice if: (a) the other party files for bankruptcy or becomes insolvent; (b) the other party ceases to conduct business in the ordinary course; or (c) the other party assigns this Agreement without consent. No cure period applies.",
    ground_truth: { notice_period_days: 0, trigger: "bankruptcy, insolvency, cessation of business, or unauthorized assignment", survival_clauses: [], effective_date: null }
  },
];

export const EXTRACTION_SYSTEM_PROMPT = `You are a contract analyst. Extract structured fields from a termination clause.

Output JSON with exactly these fields:
- notice_period_days: integer (days of notice required) or null (if immediate or not specified)
- trigger: string (the condition(s) that allow termination — concise, specific)
- survival_clauses: array of strings (provisions that survive termination, empty array if none)
- effective_date: string (specific termination date if stated) or null

Rules:
- notice_period_days: use 0 for "immediately" or "no notice required", null only if truly unspecified
- trigger: 5-15 words, specific to the clause
- survival_clauses: list only what is explicitly named in the text
- effective_date: exact date string from text, or null

Respond with valid JSON only. No markdown, no explanation.`;

export async function runTerminationExtractionBaseline(apiKey: string): Promise<{
  examples: Array<{
    id: number;
    predicted: any;
    ground_truth: any;
    notice_exact: boolean;
    survival_count_exact: boolean;
    effective_date_exact: boolean;
    json_valid: boolean;
    hallucinated_notice: boolean;
    latency_ms: number;
    raw_response: string;
  }>;
  summary: {
    n: number;
    json_compliance: number;
    notice_exact_match: number;
    survival_count_exact: number;
    effective_date_exact: number;
    hallucination_rate: number;
    avg_latency_ms: number;
    model: string;
    eval_date: string;
  };
}> {
  const results = [];

  for (const ex of TERMINATION_EXAMPLES) {
    const startMs = Date.now();
    let predicted: any = null;
    let jsonValid = false;
    let rawResponse = "";

    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer \${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw-api-k30t.onrender.com",
          "X-Title": "OpenClaw Next Asset Baseline",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b:free",
          messages: [
            { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
            { role: "user", content: `Extract structured fields from this termination clause:\n\n"""\n\${ex.text}\n"""` },
          ],
          temperature: 0.0,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const data = await resp.json() as any;
      rawResponse = data.choices?.[0]?.message?.content ?? "";
      const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        predicted = JSON.parse(jsonMatch[0]);
        jsonValid = true;
      }
    } catch (e: any) {
      rawResponse = e.message;
    }

    const latencyMs = Date.now() - startMs;
    const gt = ex.ground_truth;

    // Field-level scoring
    const noticeExact = jsonValid && predicted?.notice_period_days === gt.notice_period_days;
    const survivalCountExact = jsonValid && Array.isArray(predicted?.survival_clauses) &&
      predicted.survival_clauses.length === gt.survival_clauses.length;
    const effectiveDateExact = jsonValid &&
      (predicted?.effective_date ?? null) === (gt.effective_date ?? null);

    // Hallucination: model outputs a notice_period_days value that is NOT in the source text
    // Simple check: if gt is 0 (immediate) but model outputs a positive number
    const hallucinatedNotice = jsonValid &&
      gt.notice_period_days === 0 &&
      typeof predicted?.notice_period_days === "number" &&
      predicted.notice_period_days > 0;

    results.push({
      id: ex.id,
      predicted,
      ground_truth: gt,
      notice_exact: noticeExact,
      survival_count_exact: survivalCountExact,
      effective_date_exact: effectiveDateExact,
      json_valid: jsonValid,
      hallucinated_notice: hallucinatedNotice,
      latency_ms: latencyMs,
      raw_response: rawResponse,
    });
  }

  const n = results.length;
  const summary = {
    n,
    json_compliance: results.filter(r => r.json_valid).length / n,
    notice_exact_match: results.filter(r => r.notice_exact).length / n,
    survival_count_exact: results.filter(r => r.survival_count_exact).length / n,
    effective_date_exact: results.filter(r => r.effective_date_exact).length / n,
    hallucination_rate: results.filter(r => r.hallucinated_notice).length / n,
    avg_latency_ms: results.reduce((s, r) => s + r.latency_ms, 0) / n,
    model: "openai/gpt-oss-20b:free",
    eval_date: new Date().toISOString().split("T")[0],
  };

  return { examples: results, summary };
}
