/** Deterministic flags from contract text — drives statute retrieval + company-leverage analysis. */

export interface ContractSignals {
  has_83b: boolean;
  has_rspa: boolean;
  has_qsbs_context: boolean;
  has_restricted_stock: boolean;
  has_mutual_dependency: boolean;
  has_milestone_vesting: boolean;
  has_acceleration: boolean;
  has_ruo: boolean;
  has_schedule_c_blank: boolean;
  has_employee_classification: boolean;
  has_contractor_classification: boolean;
  has_ip_moat_rep: boolean;
  has_without_cause_termination: boolean;
  has_cause_only_company_termination: boolean;
}

export function detectContractSignals(text: string): ContractSignals {
  const t = text.toLowerCase();
  return {
    has_83b: /83\s*\(\s*b|section 83\(b\)/i.test(text),
    has_rspa: /\brspa\b|restricted stock purchase agreement/i.test(text),
    has_qsbs_context: /qsbs|section 1202|qualified small business/i.test(text),
    has_restricted_stock: /restricted stock|equity grant|fully diluted/i.test(text),
    has_mutual_dependency: /mutual dependency/i.test(text),
    has_milestone_vesting: /schedule b|milestone-linked|milestone linked/i.test(text),
    has_acceleration: /acceleration|change of control|double trigger|single trigger/i.test(text),
    has_ruo: /research use only|\bruo\b/i.test(text),
    has_schedule_c_blank:
      /schedule c[^\n]*pre-existing[\s\S]{0,120}\[(list|\.\.\.|placeholder|todo)/i.test(text) ||
      /schedule c - pre-existing ip\s*\n\s*\[list/i.test(text),
    has_employee_classification: /full time employee|full-time employee/i.test(text),
    has_contractor_classification: /independent contractor/i.test(text),
    has_ip_moat_rep: /ip moat|substantially similar intellectual property assignments/i.test(text),
    has_without_cause_termination: /without cause/i.test(text),
    has_cause_only_company_termination:
      /termination by company[\s\S]{0,200}immediately for cause/i.test(text) &&
      !/without cause/i.test(text.split(/termination by company/i)[1]?.slice(0, 300) ?? ""),
  };
}

export function buildStatuteRetrievalQueries(signals: ContractSignals): string[] {
  const queries: string[] = [];
  if (signals.has_83b || signals.has_rspa || signals.has_restricted_stock) {
    queries.push("IRC 83b election 30 days restricted stock vesting cofounder grant certified mail");
  }
  if (signals.has_qsbs_context || signals.has_restricted_stock) {
    queries.push("IRC 1202 QSBS qualified small business stock 75 million gross assets post-OBBBA");
  }
  if (signals.has_restricted_stock) {
    queries.push("DGCL 144 restricted stock safe harbor affiliate resale Delaware");
    queries.push("IRC 409A fair market value stock grant independent valuation");
  }
  if (signals.has_mutual_dependency || signals.has_milestone_vesting) {
    queries.push("milestone vesting performance conditions cure period acceptance criteria");
  }
  if (signals.has_acceleration) {
    queries.push("change of control acceleration double trigger single trigger unvested shares");
  }
  if (signals.has_ruo) {
    queries.push("research use only clinical decision support FDA diagnostic RUO");
  }
  if (signals.has_schedule_c_blank || signals.has_ip_moat_rep) {
    queries.push("prior inventions carve-out schedule pre-existing IP assignment scoped");
  }
  return queries;
}
