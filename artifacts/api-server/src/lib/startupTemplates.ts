import type { DocClass, DraftIntake } from "./draftReceiptEngine";

export const TEMPLATE_VERSION = "v1";

export interface OptionalSection {
  section_id: string;
  condition: (intake: DraftIntake) => boolean;
}

export interface DocumentTemplate {
  doc_class: DocClass;
  title_template: string; // NOT "title" — field is "title_template"
  required_sections: string[];
  optional_sections: OptionalSection[];
}

const CO_FOUNDER_TEMPLATE: DocumentTemplate = {
  doc_class: "co_founder_agreement",
  title_template: "Co-Founder Agreement — [PARTY_NAMES]",
  required_sections: [
    "preamble",
    "equity_split",
    "vesting_schedule",
    "election_83b",
    "ip_assignment",
    "roles_and_responsibilities",
    "decision_making",
    "deadlock_resolution",
    "transfer_restrictions",
    "termination_and_buyout",
    "governing_law",
  ],
  optional_sections: [
    {
      section_id: "acceleration_clause",
      condition: (i) =>
        i.equity?.acceleration !== "none" && i.equity?.acceleration != null,
    },
    {
      // CA: non-solicitation void under Bus. & Prof. Code § 16600 — omit entirely
      section_id: "non_solicitation",
      condition: (i) => i.jurisdiction !== "CA",
    },
  ],
};

const CONTRACTOR_IP_TEMPLATE: DocumentTemplate = {
  doc_class: "contractor_ip_assignment",
  title_template: "Contractor IP Assignment Agreement — [PARTY_NAMES]",
  required_sections: [
    "preamble",
    "scope_of_work",
    "ip_assignment",
    "work_made_for_hire",
    "moral_rights_waiver",
    "prior_inventions_carveout",
    "confidentiality",
    "governing_law",
    "representations_and_warranties",
  ],
  optional_sections: [
    {
      section_id: "non_solicitation",
      condition: (i) => i.jurisdiction !== "CA",
    },
    {
      section_id: "non_compete",
      condition: (i) => i.jurisdiction !== "CA",
    },
  ],
};

const ADVISOR_TEMPLATE: DocumentTemplate = {
  doc_class: "advisor_agreement",
  title_template: "Advisor Agreement — [PARTY_NAMES]",
  required_sections: [
    "preamble",
    "advisory_services",
    "equity_compensation",
    "vesting_schedule",
    "ip_assignment",
    "confidentiality",
    "no_conflict",
    "termination",
    "governing_law",
  ],
  optional_sections: [
    {
      section_id: "cash_compensation",
      condition: (i) => i.advisory?.cash_fee != null,
    },
    {
      section_id: "acceleration_clause",
      condition: (i) =>
        i.equity?.acceleration !== "none" && i.equity?.acceleration != null,
    },
  ],
};

const TEMPLATES: Record<DocClass, DocumentTemplate> = {
  co_founder_agreement: CO_FOUNDER_TEMPLATE,
  contractor_ip_assignment: CONTRACTOR_IP_TEMPLATE,
  advisor_agreement: ADVISOR_TEMPLATE,
};

export function getTemplate(doc_class: DocClass): DocumentTemplate {
  const t = TEMPLATES[doc_class];
  if (!t) throw new Error(`Unknown doc_class: ${doc_class}`);
  return t;
}
