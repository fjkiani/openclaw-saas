/**
 * Co-Founder Agreement RAG Corpus
 * Structured knowledge base for the cofounder specialist.
 * 10 clause types, highest-risk first.
 */

export type CofounderClauseType =
  | "election_83b"
  | "ruo_medical_liability"
  | "equity_dilution_multi_product"
  | "ip_assignment_scope"
  | "vesting_schedule"
  | "indemnification_personal"
  | "deliverables_schedule_b"
  | "incorporation_entity_type"
  | "rspa_restricted_stock"
  | "mutual_deliverables";

export interface CorpusEntry {
  id: string;
  clause_type: CofounderClauseType;
  title: string;
  rule: string;
  risk_level: "critical" | "high" | "medium";
  triggers: string[];
  example_clause: string;
  red_flags: string[];
  governance_trigger?: string;
  draft_template: string;
}

export const COFOUNDER_CORPUS: CorpusEntry[] = [
  {
    id: "cf-001",
    clause_type: "election_83b",
    title: "83(b) Election Notice",
    risk_level: "critical",
    rule:
      "Under IRC § 83(b), a co-founder who receives restricted stock subject to vesting must file an election with the IRS within 30 days of the grant date to be taxed on the fair market value at grant (typically near zero) rather than at vesting. Failure to file within 30 days is permanent and non-waivable. The election must be filed by certified mail, a copy sent to the company, and a copy retained by the founder.",
    triggers: [
      "83b", "83(b)", "election", "restricted stock", "vesting", "equity grant",
      "stock grant", "founder shares", "restricted shares", "irs election",
    ],
    example_clause:
      "Founder shall timely file an election under Section 83(b) of the Internal Revenue Code with respect to the Shares within thirty (30) days of the Grant Date. Founder acknowledges that failure to make such filing within the 30-day period will result in the recognition of ordinary income by Founder as the Shares vest, rather than at the time of grant. Company shall provide Founder with the form of 83(b) election attached hereto as Exhibit A. Founder shall provide Company with a copy of the filed election within five (5) days of filing.",
    red_flags: [
      "equity grant with no 83(b) reference",
      "vesting schedule present but no election notice",
      "grant date not specified (30-day window cannot be calculated)",
      "83(b) referenced but no certified mail instruction",
      "83(b) referenced but no copy-to-company requirement",
    ],
    governance_trigger: "83b_window_risk",
    draft_template:
      "Section [X]. Section 83(b) Election.\n\n[FOUNDER NAME] shall file an election under Section 83(b) of the Internal Revenue Code with the Internal Revenue Service within thirty (30) calendar days of [GRANT DATE] (the \"Grant Date\"). Such election shall be filed by certified mail, return receipt requested, to the IRS Service Center where [FOUNDER NAME] files their federal income tax return. [FOUNDER NAME] shall deliver a copy of the executed election to the Company within five (5) business days of filing. The form of election is attached hereto as Exhibit [X]. [FOUNDER NAME] acknowledges that the Company has advised [FOUNDER NAME] to consult with a tax advisor regarding the consequences of making or failing to make such election, and that the Company makes no representation regarding the tax consequences of the Shares.",
  },
  {
    id: "cf-002",
    clause_type: "ruo_medical_liability",
    title: "Research Use Only (RUO) Scope Limitation",
    risk_level: "critical",
    rule:
      "Materials, reagents, assays, or devices labeled 'Research Use Only' (RUO) are not FDA-cleared for clinical, diagnostic, or therapeutic use. A co-founder who is a medical professional (CMO, physician, scientist) using RUO materials in a clinical or patient-facing context faces personal FDA enforcement liability, potential loss of medical license, and company liability. The agreement must explicitly define the scope of use and exclude clinical/diagnostic application without FDA clearance.",
    triggers: [
      "ruo", "research use only", "reagent", "assay", "diagnostic", "clinical",
      "fda", "medical device", "in vitro", "laboratory", "cmo", "chief medical",
      "patient", "therapeutic", "clearance", "510k", "pma",
    ],
    example_clause:
      "All materials, reagents, assays, and devices contributed or used by CMO Founder in connection with Company activities are designated for Research Use Only (RUO) and are not intended for use in clinical diagnosis, therapeutic decision-making, or direct patient care unless and until such materials have received applicable FDA clearance or approval. CMO Founder shall not use, authorize, or permit the use of any RUO materials in any clinical or diagnostic context without prior written approval of the Board and confirmation of applicable regulatory clearance.",
    red_flags: [
      "RUO materials mentioned without scope limitation",
      "CMO or medical professional role without RUO disclaimer",
      "clinical or diagnostic use mentioned alongside RUO materials",
      "patient data or patient outcomes referenced without FDA clearance pathway",
      "VetOnco or animal diagnostic use without RUO carve-out (veterinary RUO rules differ)",
    ],
    governance_trigger: "ruo_clinical_risk",
    draft_template:
      "Section [X]. Research Use Only Materials.\n\nAll biological materials, reagents, assays, software, and devices (collectively, \"RUO Materials\") contributed by [CMO FOUNDER NAME] or used by the Company in its research activities are designated for Research Use Only and are not FDA-cleared or approved for clinical diagnostic use, therapeutic use, or use in clinical decision-making involving human or animal patients. The Company shall not, and [CMO FOUNDER NAME] shall not authorize the Company to, use any RUO Materials in any clinical, diagnostic, or patient-care context without: (a) prior written approval of the Board of Directors; and (b) written confirmation from qualified regulatory counsel that such use complies with applicable FDA regulations and guidance. This restriction applies to all products and services of the Company, including but not limited to [VETONCE / LONGEVITY / DEEPCRISPR.AI] platforms. Violation of this section by any party shall constitute a material breach of this Agreement.",
  },
  {
    id: "cf-003",
    clause_type: "equity_dilution_multi_product",
    title: "Equity Structure — Multi-Product Dilution Protection",
    risk_level: "critical",
    rule:
      "Where a co-founder holds equity in a primary entity and the company operates or plans to operate multiple products or subsidiaries (e.g., VetOnco, Longevity, DeepCrispr.ai), the agreement must define: (1) which entity the equity percentage applies to; (2) whether the co-founder participates in subsidiary equity; (3) anti-dilution protections or lack thereof; and (4) what happens to the percentage on future financing rounds. Silence defaults to pro-rata dilution with no protection.",
    triggers: [
      "equity", "30%", "percent", "dilution", "cap table", "shares", "ownership",
      "vetonce", "longevity", "deepcrispr", "subsidiary", "spinout", "product line",
      "series a", "financing", "anti-dilution", "pro-rata", "participation rights",
    ],
    example_clause:
      "The 30% equity interest granted to CMO Founder applies to [PRIMARY ENTITY NAME] only. CMO Founder's participation in the equity of VetOnco, Inc., Longevity Sciences, Inc., and DeepCrispr.ai, Inc. (each a 'Product Entity') shall be governed by separate equity agreements for each Product Entity, to be negotiated in good faith within 90 days of the formation of each Product Entity. CMO Founder's equity in the Primary Entity is subject to pro-rata dilution on future financing rounds unless a separate anti-dilution agreement is executed.",
    red_flags: [
      "equity percentage stated without specifying which entity",
      "multiple products/subsidiaries mentioned without separate equity terms",
      "no anti-dilution provision or explicit acknowledgment of pro-rata dilution",
      "no participation rights on future financing rounds defined",
      "equity in multiple entities lumped into one percentage",
    ],
    governance_trigger: "equity_no_dilution_protection",
    draft_template:
      "Section [X]. Equity Interest and Multi-Product Structure.\n\n(a) Primary Entity Equity. The [30]% equity interest granted to [CMO FOUNDER NAME] (the \"Equity Interest\") applies solely to [PRIMARY ENTITY NAME] (the \"Company\") and does not, by itself, confer any equity interest in any subsidiary, affiliate, or product entity of the Company.\n\n(b) Product Entity Equity. The parties acknowledge that the Company operates or intends to operate the following product lines or entities: [VetOnco / Longevity / DeepCrispr.ai] (each a \"Product Entity\"). [CMO FOUNDER NAME]'s equity participation in each Product Entity shall be governed by a separate written equity agreement for that Product Entity, to be negotiated in good faith and executed within [90] days of the formation or capitalization of each Product Entity.\n\n(c) Dilution. The Equity Interest is subject to dilution on a pro-rata basis upon the issuance of additional equity securities by the Company, unless the parties execute a separate anti-dilution agreement. [CMO FOUNDER NAME] shall have [pro-rata / no] participation rights in future financing rounds.\n\n(d) Cap Table. The Company shall maintain a current cap table and provide [CMO FOUNDER NAME] with a copy within [10] business days of any change to the capitalization of the Company.",
  },
  {
    id: "cf-004",
    clause_type: "ip_assignment_scope",
    title: "IP Assignment — Scope and Pre-Existing IP Carve-Out",
    risk_level: "critical",
    rule:
      "Co-founder IP assignment clauses must define: (1) what IP is assigned to the company; (2) what pre-existing IP is retained by the co-founder; and (3) what IP developed outside the scope of the agreement is retained. Broad 'all inventions' clauses without a carve-out can capture a CMO's pre-existing medical expertise, publications, and prior inventions. The CMO's medical knowledge and prior research are not company IP unless explicitly assigned.",
    triggers: [
      "ip", "intellectual property", "invention", "assignment", "work for hire",
      "patent", "copyright", "trade secret", "prior invention", "background ip",
      "foreground ip", "cmo", "medical expertise", "research", "publication",
      "assign", "transfer", "ownership",
    ],
    example_clause:
      "CMO Founder hereby assigns to Company all right, title, and interest in and to any Inventions made, conceived, or reduced to practice by CMO Founder during the Term that: (a) relate directly to the Company's business as described in Schedule A; and (b) were developed using Company resources or during CMO Founder's time dedicated to Company activities. Notwithstanding the foregoing, CMO Founder retains all right, title, and interest in and to: (i) Prior Inventions listed in Exhibit B; (ii) CMO Founder's general medical and scientific knowledge and expertise; and (iii) any Inventions developed entirely on CMO Founder's own time without use of Company resources and unrelated to the Company's business.",
    red_flags: [
      "all inventions assigned without carve-out for prior inventions",
      "no Exhibit B or prior inventions schedule",
      "assignment clause covers 'all works' without scope limitation",
      "CMO medical expertise not explicitly excluded",
      "no definition of 'Company resources' or 'Company time'",
    ],
    governance_trigger: "ip_broad_assignment",
    draft_template:
      "Section [X]. Intellectual Property Assignment.\n\n(a) Assignment. [CMO FOUNDER NAME] hereby irrevocably assigns to the Company all right, title, and interest in and to all inventions, discoveries, developments, improvements, works of authorship, and trade secrets (collectively, \"Inventions\") that [CMO FOUNDER NAME] makes, conceives, develops, or reduces to practice, either alone or jointly with others, during the Term of this Agreement, that: (i) are made using the Company's equipment, supplies, facilities, or Confidential Information; or (ii) result from work performed by [CMO FOUNDER NAME] for the Company; or (iii) relate to the Company's current or reasonably anticipated business, research, or development.\n\n(b) Prior Inventions. The assignment in Section (a) does not apply to any Invention that [CMO FOUNDER NAME] developed entirely prior to the Effective Date (\"Prior Inventions\"). [CMO FOUNDER NAME]'s Prior Inventions are listed in Exhibit [X] attached hereto. If no Prior Inventions are listed, [CMO FOUNDER NAME] represents that there are no Prior Inventions that are relevant to the Company's business.\n\n(c) Retained Rights. [CMO FOUNDER NAME] retains all right, title, and interest in and to: (i) [CMO FOUNDER NAME]'s general medical and scientific knowledge, training, and expertise; (ii) any publications, presentations, or academic work authored by [CMO FOUNDER NAME] prior to the Effective Date; and (iii) any Inventions developed entirely on [CMO FOUNDER NAME]'s own time, without use of Company resources, and unrelated to the Company's business or reasonably anticipated research.",
  },
  {
    id: "cf-005",
    clause_type: "vesting_schedule",
    title: "Vesting Schedule — Cliff, Acceleration, and Termination",
    risk_level: "high",
    rule:
      "A co-founder vesting schedule must define: (1) the total grant; (2) any immediate vesting on signing; (3) the cliff period; (4) the vesting cadence after cliff; (5) acceleration triggers (single-trigger, double-trigger, or none); and (6) what happens to unvested shares on termination (for cause vs. without cause vs. resignation). '5% upon signing' is an immediate grant and must be documented in the RSPA, not just the co-founder agreement.",
    triggers: [
      "vesting", "cliff", "vest", "4 year", "4-year", "1 year cliff", "monthly vesting",
      "acceleration", "single trigger", "double trigger", "change of control",
      "termination", "unvested", "5% upon signing", "immediate vesting",
    ],
    example_clause:
      "CMO Founder's Shares shall vest as follows: (a) 5% of the total Shares (the 'Signing Grant') shall vest immediately upon execution of this Agreement and the RSPA; (b) the remaining 95% of the Shares shall be subject to a [12]-month cliff, after which [X]% shall vest; (c) the remaining Shares shall vest monthly over [36] months. Upon termination of CMO Founder's service for Cause, all unvested Shares shall be forfeited. Upon termination without Cause or resignation for Good Reason, [X]% of unvested Shares shall accelerate.",
    red_flags: [
      "5% upon signing not documented in RSPA",
      "cliff period not defined",
      "no acceleration clause (single or double trigger)",
      "termination treatment of unvested shares not defined",
      "vesting cadence (monthly/quarterly/annual) not specified",
    ],
    draft_template:
      "Section [X]. Vesting Schedule.\n\n(a) Total Grant. The Company shall issue to [CMO FOUNDER NAME] [TOTAL SHARES] shares of [Common / Restricted] Stock (the \"Shares\"), subject to the terms of the Restricted Stock Purchase Agreement (\"RSPA\") attached hereto as Exhibit [X].\n\n(b) Immediate Vesting. [5]% of the Shares ([IMMEDIATE SHARES] shares) shall vest immediately upon execution of this Agreement and the RSPA (the \"Signing Grant\").\n\n(c) Cliff. The remaining [95]% of the Shares shall be subject to a [12]-month cliff period commencing on the Grant Date. No additional Shares shall vest during the cliff period.\n\n(d) Post-Cliff Vesting. Following the cliff, the remaining Shares shall vest in equal monthly installments over [36] months, subject to [CMO FOUNDER NAME]'s continued service to the Company.\n\n(e) Acceleration. [OPTION A: No acceleration. All unvested Shares are forfeited upon termination.] [OPTION B: Single-trigger — upon a Change of Control, [X]% of unvested Shares shall accelerate.] [OPTION C: Double-trigger — upon a Change of Control followed by termination without Cause within [12] months, [X]% of unvested Shares shall accelerate.]\n\n(f) Termination. Upon termination of [CMO FOUNDER NAME]'s service for Cause, all unvested Shares shall be immediately forfeited. Upon termination without Cause, [X]% of unvested Shares shall [accelerate / be forfeited].",
  },
  {
    id: "cf-006",
    clause_type: "indemnification_personal",
    title: "Indemnification — Personal Liability Protection",
    risk_level: "high",
    rule:
      "A co-founder who is a medical professional (CMO) faces personal liability exposure from regulatory actions (FDA, DEA, state medical board), third-party claims arising from company activities, and IP disputes. The indemnification clause must define: (1) scope (third-party claims only, or also regulatory?); (2) advancement of expenses; (3) carve-outs for gross negligence or willful misconduct; and (4) D&O insurance requirement.",
    triggers: [
      "indemnification", "indemnify", "liability", "personal liability", "d&o",
      "directors and officers", "insurance", "regulatory", "fda enforcement",
      "third party claim", "advancement", "expenses", "defend",
    ],
    example_clause:
      "Company shall indemnify, defend, and hold harmless CMO Founder from and against any third-party claims, actions, or proceedings arising out of CMO Founder's service to the Company in their capacity as a co-founder and officer, to the fullest extent permitted by applicable law, except to the extent arising from CMO Founder's gross negligence, willful misconduct, or material breach of this Agreement. Company shall advance reasonable legal expenses to CMO Founder pending final disposition of any such claim. Company shall maintain D&O insurance with coverage of not less than $[X] per occurrence.",
    red_flags: [
      "no indemnification clause for CMO co-founder",
      "indemnification limited to third-party claims only (excludes regulatory)",
      "no advancement of expenses provision",
      "no D&O insurance requirement",
      "indemnification subject to board approval (creates conflict of interest)",
    ],
    draft_template:
      "Section [X]. Indemnification.\n\n(a) Indemnification. The Company shall indemnify, defend, and hold harmless [CMO FOUNDER NAME] from and against any and all claims, actions, suits, proceedings, losses, damages, liabilities, costs, and expenses (including reasonable attorneys' fees) (collectively, \"Claims\") arising out of or relating to [CMO FOUNDER NAME]'s service to the Company as a co-founder, officer, or director, to the fullest extent permitted by [STATE] law, except to the extent that such Claims arise from [CMO FOUNDER NAME]'s: (i) gross negligence; (ii) willful misconduct; or (iii) material breach of this Agreement.\n\n(b) Regulatory Actions. The indemnification in Section (a) includes Claims arising from regulatory investigations or enforcement actions by the FDA, DEA, or state medical boards, to the extent such actions arise from [CMO FOUNDER NAME]'s authorized activities on behalf of the Company.\n\n(c) Advancement of Expenses. The Company shall advance reasonable legal expenses to [CMO FOUNDER NAME] in connection with any Claim covered by this Section, subject to [CMO FOUNDER NAME]'s written undertaking to repay such advances if it is ultimately determined that [CMO FOUNDER NAME] is not entitled to indemnification.\n\n(d) D&O Insurance. The Company shall obtain and maintain directors' and officers' liability insurance with coverage of not less than $[AMOUNT] per occurrence within [90] days of the Effective Date.",
  },
  {
    id: "cf-007",
    clause_type: "deliverables_schedule_b",
    title: "Deliverables — Schedule B (CMO Obligations)",
    risk_level: "high",
    rule:
      "Co-founder agreements that include deliverables (time-based, milestone-based, or hybrid) must define: (1) specific deliverables with measurable acceptance criteria; (2) the timeline for each deliverable; (3) what constitutes acceptance; (4) consequences of missed deliverables; and (5) whether deliverables are conditions to vesting. Ambiguous deliverables are the most common source of co-founder disputes.",
    triggers: [
      "deliverable", "schedule b", "milestone", "obligation", "commitment",
      "time commitment", "hours per week", "full time", "part time",
      "acceptance criteria", "completion", "cmo responsibilities",
    ],
    example_clause:
      "CMO Founder's deliverables are set forth in Schedule B attached hereto. Each deliverable shall be deemed accepted upon written confirmation from the CEO/CTO within 10 business days of submission. Failure to deliver any Schedule B item within 30 days of the specified deadline shall constitute a material breach, subject to a 15-day cure period.",
    red_flags: [
      "no Schedule B or deliverables schedule",
      "deliverables described in vague terms ('provide medical expertise', 'advise on clinical matters')",
      "no acceptance criteria defined",
      "no timeline for deliverables",
      "no consequence for missed deliverables",
    ],
    draft_template:
      "SCHEDULE B — CMO FOUNDER DELIVERABLES\n\nThis Schedule B sets forth the deliverables to be provided by [CMO FOUNDER NAME] to the Company during the Term of the Co-Founder Agreement.\n\n| # | Deliverable | Description | Deadline | Acceptance Criteria |\n|---|---|---|---|---|\n| 1 | [DELIVERABLE 1] | [DESCRIPTION] | [DATE / MILESTONE] | [CRITERIA] |\n| 2 | [DELIVERABLE 2] | [DESCRIPTION] | [DATE / MILESTONE] | [CRITERIA] |\n| 3 | [DELIVERABLE 3] | [DESCRIPTION] | [DATE / MILESTONE] | [CRITERIA] |\n\nAcceptance. Each deliverable shall be deemed accepted upon written confirmation from [CEO/CTO NAME] within [10] business days of submission by [CMO FOUNDER NAME]. If [CEO/CTO NAME] does not respond within [10] business days, the deliverable shall be deemed accepted.\n\nMissed Deliverables. Failure to deliver any item within [30] days of the specified deadline shall constitute a material breach of the Agreement, subject to a [15]-day written cure period.",
  },
  {
    id: "cf-008",
    clause_type: "incorporation_entity_type",
    title: "Entity Type — S-Corp vs. Non-Profit Resolution",
    risk_level: "high",
    rule:
      "The entity type (S-Corp, C-Corp, LLC, non-profit 501(c)(3)) directly affects: (1) 83(b) election validity (S-Corp and C-Corp restricted stock qualifies; non-profit equity structures differ); (2) equity structure (non-profits cannot issue equity in the traditional sense); (3) tax treatment of the co-founder's equity; and (4) future financing (VCs cannot invest in S-Corps or non-profits). The entity type must be resolved before the co-founder agreement is signed.",
    triggers: [
      "s-corp", "s corp", "non-profit", "nonprofit", "501c3", "501(c)(3)",
      "c-corp", "c corp", "llc", "incorporation", "entity type", "formation",
      "tax election", "subchapter s",
    ],
    example_clause:
      "The parties acknowledge that the Company is currently [incorporated as / in the process of incorporating as] a [Delaware C-Corporation / S-Corporation / Non-Profit]. The parties agree that the entity type shall be [confirmed / resolved] no later than [DATE], and that this Agreement is conditioned upon the Company being incorporated as a [C-Corporation / S-Corporation] prior to the issuance of any equity to CMO Founder.",
    red_flags: [
      "entity type not specified in agreement",
      "S-Corp and non-profit both mentioned without resolution",
      "equity grant conditioned on incorporation but no deadline",
      "83(b) election referenced without confirming entity type supports it",
      "VC financing anticipated but S-Corp structure not addressed",
    ],
    governance_trigger: "incorporation_unresolved",
    draft_template:
      "Section [X]. Entity Type and Incorporation.\n\n(a) Current Status. The Company is currently [incorporated as / in the process of incorporating as] a [ENTITY TYPE] under the laws of [STATE].\n\n(b) Resolution. The parties acknowledge that the entity type has not been finally determined as of the Effective Date. The parties agree to resolve the entity type no later than [DATE] (the \"Entity Resolution Deadline\").\n\n(c) Condition to Equity Issuance. No equity shall be issued to [CMO FOUNDER NAME] under this Agreement or the RSPA until the Company has been duly incorporated as a [C-Corporation / S-Corporation] and the Board has authorized the issuance of the Shares.\n\n(d) Impact on 83(b). The parties acknowledge that the validity and tax treatment of any 83(b) election depends on the entity type. [CMO FOUNDER NAME] is advised to consult with a tax advisor before filing any 83(b) election.\n\n(e) Non-Profit Alternative. If the parties elect to form a non-profit entity, the equity structure described in this Agreement shall be replaced with [ALTERNATIVE COMPENSATION STRUCTURE] to be negotiated in good faith within [30] days of such election.",
  },
  {
    id: "cf-009",
    clause_type: "rspa_restricted_stock",
    title: "RSPA — Restricted Stock Purchase Agreement",
    risk_level: "high",
    rule:
      "The Restricted Stock Purchase Agreement (RSPA) is the legal instrument that actually issues the restricted stock to the co-founder. The co-founder agreement must reference the RSPA and confirm it is executed simultaneously. The RSPA must include: (1) the number of shares; (2) the purchase price (typically par value); (3) the vesting schedule; (4) the company's repurchase right on unvested shares; and (5) the 83(b) election form as an exhibit.",
    triggers: [
      "rspa", "restricted stock purchase", "restricted stock agreement",
      "stock purchase agreement", "repurchase right", "par value",
      "share issuance", "stock certificate", "equity issuance",
    ],
    example_clause:
      "Simultaneously with the execution of this Agreement, CMO Founder and Company shall execute the Restricted Stock Purchase Agreement attached hereto as Exhibit C (the 'RSPA'). The RSPA governs the issuance, vesting, and repurchase of the Shares and is incorporated herein by reference. In the event of any conflict between this Agreement and the RSPA, the RSPA shall control with respect to the terms of the equity grant.",
    red_flags: [
      "equity grant described in co-founder agreement without reference to RSPA",
      "RSPA referenced but not attached or not executed simultaneously",
      "no company repurchase right on unvested shares",
      "83(b) election form not attached to RSPA",
      "purchase price not specified (must be at least par value)",
    ],
    draft_template:
      "Section [X]. Restricted Stock Purchase Agreement.\n\n(a) Simultaneous Execution. Simultaneously with the execution of this Agreement, [CMO FOUNDER NAME] and the Company shall execute the Restricted Stock Purchase Agreement in the form attached hereto as Exhibit [X] (the \"RSPA\").\n\n(b) Incorporation by Reference. The RSPA is incorporated into this Agreement by reference. The terms of the RSPA govern the issuance, vesting, repurchase, and transfer of the Shares. In the event of any conflict between this Agreement and the RSPA, the RSPA shall control.\n\n(c) Purchase Price. [CMO FOUNDER NAME] shall purchase the Shares at a price of $[AMOUNT] per share (the \"Purchase Price\"), which the parties agree represents the fair market value of the Shares as of the Grant Date.\n\n(d) Repurchase Right. The Company shall have the right to repurchase unvested Shares at the Purchase Price upon termination of [CMO FOUNDER NAME]'s service, as set forth in the RSPA.\n\n(e) 83(b) Election. The RSPA shall include as an exhibit the form of 83(b) election described in Section [X] of this Agreement.",
  },
  {
    id: "cf-010",
    clause_type: "mutual_deliverables",
    title: "Mutual Deliverables — CEO/CTO Obligations",
    risk_level: "medium",
    rule:
      "A co-founder agreement that specifies CMO deliverables without equivalent CEO/CTO deliverables is one-sided and may be unenforceable as lacking consideration. The CEO/CTO's obligations (funding, incorporation, product development, business development) must be as specific as the CMO's obligations. Asymmetric obligations are the second most common source of co-founder disputes.",
    triggers: [
      "ceo", "cto", "co-founder obligations", "mutual", "reciprocal",
      "funding", "incorporation deadline", "product development",
      "business development", "ceo deliverables", "cto deliverables",
    ],
    example_clause:
      "CEO/CTO Founder's obligations are set forth in Schedule C attached hereto. CEO/CTO Founder shall: (a) complete incorporation of the Company no later than [DATE]; (b) secure initial funding of not less than $[X] by [DATE]; (c) deliver a working prototype of [PRODUCT] by [DATE]. Failure to meet any CEO/CTO obligation shall entitle CMO Founder to [REMEDY].",
    red_flags: [
      "CMO deliverables specified but no CEO/CTO deliverables",
      "CEO/CTO obligations described vaguely ('use best efforts', 'pursue funding')",
      "no incorporation deadline for CEO/CTO",
      "no funding commitment or timeline",
      "no remedy for CMO if CEO/CTO fails to perform",
    ],
    draft_template:
      "SCHEDULE C — CEO/CTO FOUNDER DELIVERABLES\n\nThis Schedule C sets forth the deliverables to be provided by [CEO/CTO FOUNDER NAME] to the Company during the Term of the Co-Founder Agreement.\n\n| # | Deliverable | Description | Deadline | Acceptance Criteria |\n|---|---|---|---|---|\n| 1 | Incorporation | Incorporate Company as [ENTITY TYPE] in [STATE] | [DATE] | Certificate of Incorporation delivered to [CMO FOUNDER NAME] |\n| 2 | Initial Funding | Secure initial funding of not less than $[AMOUNT] | [DATE] | Executed term sheet or funding agreement |\n| 3 | [PRODUCT] Prototype | Deliver working prototype of [PRODUCT] | [DATE] | [ACCEPTANCE CRITERIA] |\n| 4 | [DELIVERABLE 4] | [DESCRIPTION] | [DATE] | [CRITERIA] |\n\nRemedies. If [CEO/CTO FOUNDER NAME] fails to deliver any item in this Schedule C within [30] days of the specified deadline, [CMO FOUNDER NAME] shall have the right to [REMEDY: e.g., terminate this Agreement / accelerate vesting / reduce equity obligations].",
  },
];

/**
 * Retrieve top matching corpus entries for a given text.
 * Returns up to 3 entries sorted by trigger match count.
 */
export function cofounderRetrieve(text: string, topK = 3): CorpusEntry[] {
  const lower = text.toLowerCase();
  const scored = COFOUNDER_CORPUS.map((entry) => {
    const matches = entry.triggers.filter((t) => lower.includes(t.toLowerCase())).length;
    return { entry, matches };
  });
  return scored
    .filter((s) => s.matches > 0)
    .sort((a, b) => b.matches - a.matches)
    .slice(0, topK)
    .map((s) => s.entry);
}

/**
 * Get all corpus entries for a specific clause type.
 */
export function getCorpusEntry(clauseType: CofounderClauseType): CorpusEntry | undefined {
  return COFOUNDER_CORPUS.find((e) => e.clause_type === clauseType);
}

/**
 * Get all critical-risk entries (always included in analysis regardless of text).
 */
export function getCriticalEntries(): CorpusEntry[] {
  return COFOUNDER_CORPUS.filter((e) => e.risk_level === "critical");
}
