/**
 * Seed corpus for legal counsel RAG (Postgres tsvector, not in-memory slop).
 * Sources: IRC QSBS (post-OBBBA), DGCL §144 summary, cofounder-critical rules, CUAD-style contract patterns.
 */

export interface LegalCorpusDocumentSeed {
  slug: string;
  title: string;
  citation: string;
  domain: "cofounder" | "contract" | "tax" | "delaware" | "regulatory";
  tags: string[];
  /** Always inject for cofounder / contract review when matched or forced */
  priority: "critical" | "normal";
  content: string;
}

export const LEGAL_CORPUS_SEED: LegalCorpusDocumentSeed[] = [
  {
    slug: "qsbs-post-obbba",
    title: "QSBS Section 1202 — Post-OBBBA Gross Asset Ceiling",
    citation: "IRC §1202 (as amended by OBBBA 2025)",
    domain: "tax",
    tags: ["qsbs", "section 1202", "capital gains", "startup", "stock", "obbba", "75m", "exclusion"],
    priority: "critical",
    content: `QUALIFIED SMALL BUSINESS STOCK (QSBS) — POST-OBBBA THRESHOLDS

Use these thresholds when analyzing founder equity, stock purchases, or tax planning language. Do NOT cite the pre-2025 $50 million figure as current law for new analysis.

Asset ceiling (post-OBBBA): The qualified small business corporation gross assets test uses a $75 MILLION gross asset ceiling (not $50 million) for purposes of determining QSBS eligibility under IRC §1202 as amended.

Analysis instruction: When a contract, cap table discussion, or tax representation mentions QSBS, Section 1202, or qualified small business stock, verify whether the analysis uses the post-OBBBA $75M gross assets threshold. Flag as CRITICAL if materials cite only the obsolete $50M ceiling without acknowledging the amended threshold.

Holding period: Generally five years for full exclusion benefits (subject to statutory limits on exclusion percentage and amount).

Red flags in agreements: Tax representations that freeze QSBS eligibility without referencing current asset tests; stale model language from pre-2025 templates; missing counsel review on 1202 representations at financing.`,
  },
  {
    slug: "dgcl-144-safe-harbor",
    title: "DGCL §144 — Restricted Securities Safe Harbor (Delaware)",
    citation: "8 Del. C. §144 (2025 amendments)",
    domain: "delaware",
    tags: ["dgcl", "section 144", "delaware", "restricted stock", "safe harbor", "resale", "144"],
    priority: "critical",
    content: `DELAWARE GENERAL CORPORATION LAW §144 — RESTRICTED SECURITIES SAFE HARBOR

When analyzing Delaware-incorporated founder agreements, RSAs, RSPAs, or stock restriction agreements, evaluate compliance with DGCL §144 safe harbor conditions for resale of restricted/control securities.

Core safe harbor themes (paraphrase for counsel review, not legal advice):
1. Holder must hold restricted shares for a minimum period (traditionally six months; verify current DGCL text and 2025 amendment package for any revised holding-period or disclosure requirements).
2. Company must be current in Exchange Act reporting obligations if publicly reporting; private companies rely on information availability representations.
3. Volume and manner-of-sale limits apply for affiliates; founders with board/officer roles may be affiliates.
4. 2025 amendment package: Delaware has updated §144-related provisions affecting founder liquidity planning — any agreement dated 2024 or earlier that references "DGCL Section 144" without a 2025 compliance review should be flagged for counsel.

Analysis instruction: If the agreement is governed by Delaware law and involves restricted stock, stock grants, or repurchase rights, explicitly assess whether §144 safe harbor conditions are addressed or whether the agreement assumes unrestricted resale without board/counsel sign-off.

Red flags: No mention of restricted legend; no board approval pathway for transfers; RSPA silent on Rule 144/DGCL 144 compliance; founder liquidity rights without affiliate analysis.`,
  },
  {
    slug: "irc-83b-election",
    title: "IRC §83(b) Election — 30-Day Window",
    citation: "IRC §83(b); Treas. Reg. §1.83-2",
    domain: "cofounder",
    tags: ["83b", "83(b)", "vesting", "restricted stock", "irs", "election", "founder"],
    priority: "critical",
    content: `IRC §83(b) ELECTION — CO-FOUNDER RESTRICTED STOCK

Rule: A service provider who receives restricted stock subject to vesting may elect under §83(b) to be taxed on the fair market value at grant (often near zero) rather than at vesting. The election must be filed with the IRS within 30 calendar days of the transfer/grant date. The 30-day deadline is absolute and non-waivable.

Required process elements: (1) signed election form; (2) certified mail or approved filing method to IRS; (3) copy to employer/company; (4) copy retained by founder; (5) grant date clearly defined in RSPA.

Red flags: Vesting schedule without 83(b) reference; grant date ambiguous; no exhibit with election form; company promises to "help with taxes" without election mechanics.`,
  },
  {
    slug: "cofounder-ip-assignment-carveout",
    title: "Co-Founder IP Assignment — Prior Inventions Carve-Out",
    citation: "Standard startup IP assignment practice",
    domain: "cofounder",
    tags: ["ip", "assignment", "prior inventions", "background ip", "founder", "invention"],
    priority: "critical",
    content: `IP ASSIGNMENT SCOPE — FOUNDER CARVE-OUTS

Broad "all inventions" assignment without carve-out captures prior research, publications, and medical/scientific expertise improperly.

Required elements: (1) scoped assignment (company business + company resources); (2) Prior Inventions exhibit listing excluded IP; (3) explicit retention of general knowledge and pre-existing publications; (4) definition of company resources and company time.

Red flags: "All inventions whether or not related to company business"; no Exhibit B; CMO/clinical founder with no prior inventions schedule.`,
  },
  {
    slug: "cofounder-ruo-fda-scope",
    title: "Research Use Only (RUO) — Clinical Scope Limitation",
    citation: "FDA RUO guidance; 21 CFR framework",
    domain: "regulatory",
    tags: ["ruo", "fda", "clinical", "diagnostic", "cmo", "research use only"],
    priority: "critical",
    content: `RESEARCH USE ONLY (RUO) MATERIALS — CLINICAL USE PROHIBITION

RUO-labeled materials are not cleared for clinical diagnostic or therapeutic decision-making. Co-founder agreements involving CMO/clinical founders must define permitted use scope and exclude patient-facing application without clearance.

Red flags: RUO reagents mentioned without scope limitation; clinical/patient language alongside RUO; no board approval pathway for regulated use.`,
  },
  {
    slug: "cuad-termination-notice",
    title: "Contract Termination — Notice and Cure Patterns",
    citation: "CUAD / NVCA-style contract patterns",
    domain: "contract",
    tags: ["termination", "notice", "cure", "breach", "contract"],
    priority: "normal",
    content: `TERMINATION CLAUSE ANALYSIS PATTERNS

Evaluate: (1) notice period (days/months); (2) cure period for material breach; (3) termination for convenience vs cause; (4) effect on licenses, data, and survival clauses; (5) post-termination payment obligations.

High-risk patterns: Immediate termination without cure; asymmetric termination rights; survival clause omits confidentiality/indemnity.`,
  },
  {
    slug: "cuad-indemnification-mutual",
    title: "Indemnification — Mutual vs One-Sided",
    citation: "CUAD indemnification patterns",
    domain: "contract",
    tags: ["indemnification", "indemnify", "hold harmless", "third party"],
    priority: "normal",
    content: `INDEMNIFICATION ANALYSIS

Check: mutual vs one-sided; IP infringement carve-outs; cap on liability interaction; advancement of expenses; insurance requirements (D&O).

Red flags: Broad one-sided indemnity from founder; no cap; indemnity survives without scoping third-party claims only.`,
  },
  {
    slug: "cuad-governing-law-delaware",
    title: "Governing Law — Delaware Choice",
    citation: "Delaware choice-of-law; CUAD governing_law",
    domain: "contract",
    tags: ["governing law", "delaware", "jurisdiction", "choice of law"],
    priority: "normal",
    content: `GOVERNING LAW — DELAWARE CORPORATE CONTRACTS

Delaware governing law is standard for venture-backed entities. Pair with: (1) exclusive jurisdiction (Delaware courts or specified forum); (2) waiver of jury trial if present; (3) consistency with DGCL for corporate matters.

Flag if governing law conflicts with place of incorporation without explanation.`,
  },
  {
    slug: "cofounder-vesting-acceleration",
    title: "Founder Vesting — Cliff, Acceleration, Termination",
    citation: "Standard 4-year/1-year cliff founder vesting",
    domain: "cofounder",
    tags: ["vesting", "cliff", "acceleration", "termination", "rspa"],
    priority: "normal",
    content: `FOUNDER VESTING ANALYSIS

Document: total grant; immediate vest on signing (if any); cliff months; monthly/quarterly cadence; single vs double-trigger acceleration; treatment of unvested shares on termination for cause vs without cause.

Red flags: Verbal vesting not in RSPA; 5% on signing not in stock purchase agreement; no repurchase price for unvested shares.`,
  },
  {
    slug: "cofounder-equity-multi-entity",
    title: "Multi-Product Equity — Entity Scope",
    citation: "Startup multi-entity cap table practice",
    domain: "cofounder",
    tags: ["equity", "dilution", "subsidiary", "cap table", "multi-product"],
    priority: "normal",
    content: `MULTI-ENTITY EQUITY STRUCTURE

When multiple products/subsidiaries exist, equity percentage must specify which entity. Silence defaults to pro-rata dilution without anti-dilution protection.

Red flags: Single percentage across unnamed entities; no participation rights on future rounds; spinout language absent.`,
  },
  {
    slug: "cofounder-schedule-c-prior-ip",
    title: "Schedule C — Prior Inventions & IP Carve-Out (Empty Schedule Risk)",
    citation: "NVCA / startup RSPA practice",
    domain: "cofounder",
    tags: ["schedule c", "prior inventions", "ip assignment", "carve-out", "blank schedule"],
    priority: "critical",
    content: `SCHEDULE C — PRIOR INVENTIONS AND IP CARVE-OUT

When an agreement contains broad IP assignment (all inventions related to the business) AND Schedule C (Prior Inventions) is empty or marked "None", the counterparty may have inadvertently assigned pre-existing IP, clinical datasets, or product-specific know-how.

Company counsel checklist:
1. Require exhaustive Schedule C listing all prior inventions, publications, clinical trial data, and side-project domains before signing.
2. If Schedule C is blank while IP assignment is present, treat as CRITICAL — blocking until amended.
3. Carve-out language must survive assignment clause: "Except as listed on Schedule C, Company claims no right to..."
4. For CMO/clinical co-founders: list VetOnco, prior employer inventions, and any FDA-regulated artifacts explicitly.

Redline pattern: "Schedule C is intentionally incomplete. Co-Founder shall deliver a complete Schedule C within 10 business days; IP assignment is suspended as to listed items until Board acceptance."`,
  },
  {
    slug: "cofounder-mutual-dependency",
    title: "Mutual Dependency / Symbiotic Business Clauses",
    citation: "Delaware enforceability — restraint of trade",
    domain: "cofounder",
    tags: ["mutual dependency", "symbiotic", "non-compete", "enforceability", "16600"],
    priority: "normal",
    content: `MUTUAL DEPENDENCY AND SYMBIOTIC BUSINESS CLAUSES

"Mutual Dependency" clauses tie each party's equity or role to the other's continued participation in named products or entities. These create enforceability and tax characterization risks.

Enforceability (Lens 1): Over-broad dependency may function as a de facto non-compete or forfeiture trigger. In California-adjacent hires or multi-state operations, cross-check CA Bus. & Prof. Code §16600 escalation rules in governance engine.

Company exposure (Lens 4): Dependency clauses can trap the Company if a co-founder departs — product roadmap stalls, equity forfeiture disputes, or forced buyback at unclear price.

Tax (Lens 2): Forfeiture on dependency breach may recharacterize equity as compensatory; verify 83(b) and QSBS holding period impact.

Counsel action: Narrow dependency to objective milestones; add Company termination-for-convenience without equity clawback beyond standard vesting; define "Dependency Event" with cure period.`,
  },
];

export const LEGAL_CORPUS_VERSION = "legal-corpus-pg-v1";
