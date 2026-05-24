import crypto from "crypto";
import type {
  DocClass,
  DraftIntake,
  DraftSection,
  StoredDraftArtifact,
} from "./draftReceiptEngine";
import { getTemplate, TEMPLATE_VERSION } from "./startupTemplates";
import { selectVariant, CLAUSE_LIBRARY, CLAUSE_LIBRARY_VERSION } from "./clauseLibrary";

export { TEMPLATE_VERSION, CLAUSE_LIBRARY_VERSION };

// ── Result types ──────────────────────────────────────────────────────────────
export interface BuildDraftResult {
  sections: DraftSection[];
  full_text: string;
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
}

export interface RevisionResult {
  new_sections: DraftSection[]; // NOT "sections"
  new_full_text: string; // NOT "full_text"
  new_section_map: string[]; // NOT "section_map"
  assumptions: string[];
  missing_info_flags: string[];
  not_implemented?: boolean;
}

// ── Placeholder filler ────────────────────────────────────────────────────────
// Fills [PLACEHOLDER: field.path] markers from intake using dot-path traversal.
// Unresolved markers are left as-is (trigger PLACEHOLDER_LEAK in verifier).
function fillPlaceholders(body: string, intake: DraftIntake): string {
  return body.replace(/\[PLACEHOLDER:\s*([^\]]+)\]/g, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const parts = path.split(".");
    let val: unknown = intake;
    for (const part of parts) {
      if (val == null || typeof val !== "object") {
        val = undefined;
        break;
      }
      val = (val as Record<string, unknown>)[part];
    }
    if (val == null) return `[PLACEHOLDER: ${path}]`; // leave unresolved
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

// ── Title builder ─────────────────────────────────────────────────────────────
function buildTitle(title_template: string, intake: DraftIntake): string {
  const names = intake.parties.map((p) => p.name).join(" / ");
  return title_template.replace("[PARTY_NAMES]", names);
}

// ── buildDraft ────────────────────────────────────────────────────────────────
// Takes intake only — template loaded internally. NOT buildDraft(intake, template).
// CLAUSE_LIBRARY is imported at module level — never inside this function.
export function buildDraft(intake: DraftIntake): BuildDraftResult {
  const assumptions: string[] = [];
  const missing_info_flags: string[] = [];

  // Apply defaults — mutate a shallow copy so original intake is not modified
  let i: DraftIntake = { ...intake };

  if (
    i.doc_class === "co_founder_agreement" ||
    i.doc_class === "advisor_agreement"
  ) {
    if (i.equity?.acceleration == null) {
      assumptions.push(
        "equity.acceleration: not provided — defaulted to 'none'",
      );
      i = { ...i, equity: { ...i.equity, acceleration: "none" } };
    }
    if (i.equity?.vesting_years == null) {
      assumptions.push(
        "vesting_schedule: equity.vesting_years not provided — defaulted to 4yr/1yr cliff",
      );
      i = {
        ...i,
        equity: {
          ...i.equity,
          vesting_years: 4,
          cliff_months: i.equity?.cliff_months ?? 12,
        },
      };
    }
  }

  if (i.doc_class === "co_founder_agreement" && i.ip?.scope == null) {
    assumptions.push("ip_assignment: ip.scope not provided — defaulted to 'broad'");
    i = { ...i, ip: { ...i.ip, scope: "broad" } };
  }

  const template = getTemplate(i.doc_class);

  // Determine active sections
  const activeSectionIds: string[] = [...template.required_sections];
  for (const opt of template.optional_sections) {
    if (opt.condition(i)) {
      activeSectionIds.push(opt.section_id);
    }
  }

  // Build each section
  const sections: DraftSection[] = [];
  for (const section_id of activeSectionIds) {
    const variant = selectVariant(section_id, i.doc_class, i.jurisdiction, CLAUSE_LIBRARY);
    if (!variant) {
      missing_info_flags.push(
        `${section_id}: no approved variant for jurisdiction ${i.jurisdiction}`,
      );
      sections.push({
        section_id,
        title: section_id.replace(/_/g, " "),
        body: `[PLACEHOLDER: ${section_id} clause — no approved variant for jurisdiction ${i.jurisdiction}]`,
      });
      continue;
    }
    const body = fillPlaceholders(variant.body, i);
    sections.push({
      section_id,
      title: variant.label,
      body,
      variant_used: variant.variant_id,
    });
  }

  const full_text = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n---\n\n");
  const section_map = sections.map((s) => s.section_id);

  return { sections, full_text, section_map, assumptions, missing_info_flags };
}

// ── applyRevision ─────────────────────────────────────────────────────────────
// Deterministic revision parser. Trusted intake comes from stored.intake — never from client.
export function applyRevision(
  stored: StoredDraftArtifact,
  revision_instruction: string,
  allow_model_rewrite = false,
): RevisionResult {
  if (allow_model_rewrite) {
    return {
      new_sections: stored.sections,
      new_full_text: stored.full_text,
      new_section_map: stored.section_map,
      assumptions: stored.assumptions,
      missing_info_flags: ["model_clause_rewrite_not_implemented"],
      not_implemented: true,
    };
  }

  const instruction = revision_instruction.toLowerCase();
  const sections: DraftSection[] = stored.sections.map((s) => ({ ...s }));
  const assumptions: string[] = [...stored.assumptions];
  const missing_info_flags: string[] = [];

  // "change vesting to Xyr/Ymo" or "use Xyr/Ymo"
  const vestingMatch = instruction.match(
    /(?:change vesting to|use)\s+(\d+)yr\/(\d+)(?:mo|month)/,
  );

  // "switch governing law to XX" or "change governing law to XX"
  const govLawMatch = instruction.match(
    /(?:switch|change) governing law to\s+([a-z]{2,})/,
  );

  // "remove <section_id>"
  const removeMatch = instruction.match(/remove\s+([\w-]+)/);

  if (vestingMatch) {
    const years = parseInt(vestingMatch[1], 10);
    const months = parseInt(vestingMatch[2], 10);
    const newIntake: DraftIntake = {
      ...stored.intake,
      equity: { ...stored.intake.equity, vesting_years: years, cliff_months: months },
    };
    const rebuilt = buildDraft(newIntake);
    const newVesting = rebuilt.sections.find((s) => s.section_id === "vesting_schedule");
    const existingIdx = sections.findIndex((s) => s.section_id === "vesting_schedule");
    if (newVesting && existingIdx >= 0) {
      sections[existingIdx] = newVesting;
      assumptions.push(
        `vesting_schedule: revised to ${years}yr/${months}mo cliff per instruction`,
      );
    }
  } else if (govLawMatch) {
    const newJurisdiction = govLawMatch[1].toUpperCase();
    const newIntake: DraftIntake = { ...stored.intake, jurisdiction: newJurisdiction };
    const rebuilt = buildDraft(newIntake);
    const newGl = rebuilt.sections.find((s) => s.section_id === "governing_law");
    const existingIdx = sections.findIndex((s) => s.section_id === "governing_law");
    if (newGl && existingIdx >= 0) {
      sections[existingIdx] = newGl;
      assumptions.push(`governing_law: revised to ${newJurisdiction} per instruction`);
    }
  } else if (removeMatch) {
    const target = removeMatch[1].replace(/-/g, "_");
    const idx = sections.findIndex((s) => s.section_id === target);
    if (idx >= 0) {
      sections.splice(idx, 1);
      assumptions.push(`${target}: removed per instruction`);
    }
  } else {
    missing_info_flags.push("revision_instruction_not_parseable");
  }

  const new_full_text = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n---\n\n");
  const new_section_map = sections.map((s) => s.section_id);

  return {
    new_sections: sections,
    new_full_text,
    new_section_map,
    assumptions,
    missing_info_flags,
  };
}

// ── buildTitle export (used by route handler) ─────────────────────────────────
export { buildTitle };
