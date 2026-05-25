/**
 * contractNormalizer.ts
 *
 * Pre-processing layer inserted between LLM extraction and buildDraft().
 * Canonicalizes jurisdiction, enum values, and entity_type; drops fields
 * inapplicable to the selected doc_class; categorizes missing fields.
 *
 * Exports:
 *   normalizeExtractedIntake(raw, doc_class, uncertainFields) → NormalizeResult
 */

import type { DraftIntake, DocClass } from "./draftReceiptEngine";
import type { UncertainField } from "./contractExtractor";
import {
  INTAKE_SCHEMAS,
  ESCALATION_TRIGGERS,
  type EscalationTrigger,
} from "./draftIntakeSchemas";
import type { ReviewThreshold } from "./draftReceiptEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizationNote {
  field: string;
  raw_value: unknown;
  normalized_value: unknown;
  reason: string;
}

export interface MissingRequiredField {
  field: string;
  required_by: "schema" | "escalation_trigger";
  blocking: boolean;
  review_threshold: ReviewThreshold;
  risk_if_absent: string;
}

export interface NormalizeResult {
  normalized_intake: DraftIntake;
  normalization_notes: NormalizationNote[];
  normalization_summary: { substitutions_made: number; warnings_present: boolean };
  not_applicable_fields: string[];
  missing_required_fields: MissingRequiredField[];
  uncertain_fields: UncertainField[];   // filtered to applicable fields only
}

// ── Jurisdiction alias map (exact matching, lowercase-normalized) ─────────────

const JURISDICTION_ALIASES: Record<string, string> = {
  // Delaware
  "de":                "DE",
  "delaware":          "DE",
  "delaware, usa":     "DE",
  "delaware,usa":      "DE",
  "delaware usa":      "DE",
  "delaware, us":      "DE",
  "delaware,us":       "DE",
  "state of delaware": "DE",
  // California
  "ca":                "CA",
  "california":        "CA",
  "california, usa":   "CA",
  "california,usa":    "CA",
  "california usa":    "CA",
  "california, us":    "CA",
  "california,us":     "CA",
  "state of california": "CA",
  // New York
  "ny":                "NY",
  "new york":          "NY",
  "new york, usa":     "NY",
  "new york,usa":      "NY",
  "new york usa":      "NY",
  "new york, us":      "NY",
  "new york,us":       "NY",
  "state of new york": "NY",
  // Washington
  "wa":                "WA",
  "washington":        "WA",
  "washington, usa":   "WA",
  "washington,usa":    "WA",
  "washington usa":    "WA",
  "washington, us":    "WA",
  "washington,us":     "WA",
  "state of washington": "WA",
};

function canonicalizeJurisdiction(raw: string): { canonical: string; changed: boolean } {
  const key = raw.trim().toLowerCase();
  const canonical = JURISDICTION_ALIASES[key];
  if (canonical && canonical !== raw) {
    return { canonical, changed: true };
  }
  return { canonical: raw, changed: false };
}

// ── Enum canonicalization ─────────────────────────────────────────────────────

function canonicalizeAcceleration(raw: unknown): { canonical: string; changed: boolean } | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === "single" || s === "single trigger" || s === "single-trigger") {
    return { canonical: "single", changed: s !== "single" };
  }
  if (s === "double" || s === "double trigger" || s === "double-trigger") {
    return { canonical: "double", changed: s !== "double" };
  }
  if (s === "none" || s === "no acceleration" || s === "") {
    return { canonical: "none", changed: s !== "none" };
  }
  // Unrecognized — default to "none"
  return { canonical: "none", changed: true };
}

function canonicalizeIpScope(raw: unknown): { canonical: string; changed: boolean; uncertain: boolean } | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (["broad", "all", "everything", "full", "broad assignment"].includes(s)) {
    return { canonical: "broad", changed: s !== "broad", uncertain: false };
  }
  if (["work_product_only", "work product", "work-product", "deliverables only", "deliverables"].includes(s)) {
    return { canonical: "work_product_only", changed: s !== "work_product_only", uncertain: false };
  }
  // Unrecognized — mark uncertain
  return { canonical: raw as string, changed: false, uncertain: true };
}

function canonicalizeEntityType(raw: unknown): { canonical: string; changed: boolean } | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (["individual", "person", "natural person"].includes(s)) {
    return { canonical: "individual", changed: s !== "individual" };
  }
  if (["llc", "limited liability", "limited liability company"].includes(s)) {
    return { canonical: "LLC", changed: s !== "LLC" };
  }
  if (["corp", "corporation", "inc", "incorporated", "c-corp", "c corp"].includes(s)) {
    return { canonical: "Corporation", changed: s !== "Corporation" };
  }
  // Unrecognized — keep raw, note it
  return { canonical: raw as string, changed: false };
}

// ── Doc-class field applicability ─────────────────────────────────────────────
// Reads INTAKE_SCHEMAS[doc_class].properties to determine top-level applicable keys.
// Sub-keys (equity.split, advisory.*) are derived from the schema's nested properties.

function getApplicableTopLevelFields(doc_class: DocClass): Set<string> {
  const schema = INTAKE_SCHEMAS[doc_class] as any;
  const props = schema?.properties ?? {};
  return new Set(Object.keys(props));
}

// Returns dot-paths of fields present in raw intake that are NOT applicable
// to the given doc_class.
function findNotApplicableFields(raw: DraftIntake, doc_class: DocClass): string[] {
  const applicable = getApplicableTopLevelFields(doc_class);
  const notApplicable: string[] = [];

  // Check top-level keys (excluding always-present doc_class/jurisdiction/parties)
  const topLevelKeys = ["equity", "ip", "advisory", "effective_date"] as const;
  for (const key of topLevelKeys) {
    if (raw[key] != null && !applicable.has(key)) {
      notApplicable.push(key);
    }
  }

  // Check sub-fields within applicable top-level objects
  // equity.split: only applicable to co_founder_agreement
  if (raw.equity?.split != null && doc_class !== "co_founder_agreement") {
    notApplicable.push("equity.split");
  }

  // advisory.*: only applicable to advisor_agreement
  if (doc_class !== "advisor_agreement" && raw.advisory != null) {
    const advisoryKeys = Object.keys(raw.advisory as Record<string, unknown>);
    for (const k of advisoryKeys) {
      if ((raw.advisory as any)[k] != null) {
        notApplicable.push(`advisory.${k}`);
      }
    }
  }

  return [...new Set(notApplicable)];
}

// ── equity.split completeness check ──────────────────────────────────────────

function checkEquitySplitCompleteness(
  split: Record<string, number>,
): { complete: boolean; sum: number } {
  const sum = Object.values(split).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
  return { complete: Math.abs(sum - 100) < 0.01, sum };
}

// ── Missing required fields ───────────────────────────────────────────────────

function findMissingRequiredFields(
  normalized: DraftIntake,
  doc_class: DocClass,
): MissingRequiredField[] {
  const missing: MissingRequiredField[] = [];

  // Schema-required fields (from INTAKE_SCHEMAS[doc_class].required array)
  const schema = INTAKE_SCHEMAS[doc_class] as any;
  const schemaRequired: string[] = schema?.required ?? [];
  for (const field of schemaRequired) {
    if (field === "doc_class" || field === "jurisdiction" || field === "parties") continue; // always present
    const val = (normalized as any)[field];
    if (val == null || (Array.isArray(val) && val.length === 0)) {
      missing.push({
        field,
        required_by: "schema",
        blocking: true,
        review_threshold: "blocked",
        risk_if_absent: `Schema-required field '${field}' is absent.`,
      });
    }
  }

  // Escalation-trigger required fields
  const triggers = ESCALATION_TRIGGERS.filter((t) => t.doc_classes.includes(doc_class));
  for (const trigger of triggers) {
    // Skip parties[*].entity_type — handled separately
    if (trigger.field === "parties[*].entity_type") continue;

    // Resolve dot-path
    const parts = trigger.field.split(".");
    let val: unknown = normalized;
    for (const part of parts) {
      if (val == null || typeof val !== "object") { val = undefined; break; }
      val = (val as any)[part];
    }

    const absent = val == null || (Array.isArray(val) && val.length === 0);
    if (absent) {
      // Don't double-count schema-required fields
      const alreadyListed = missing.some((m) => m.field === trigger.field);
      if (!alreadyListed) {
        missing.push({
          field: trigger.field,
          required_by: "escalation_trigger",
          blocking: trigger.blocking,
          review_threshold: trigger.review_threshold,
          risk_if_absent: trigger.risk_if_absent,
        });
      }
    }
  }

  return missing;
}

// ── Deep clone helper ─────────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ── Main export ───────────────────────────────────────────────────────────────

export function normalizeExtractedIntake(
  raw: DraftIntake,
  doc_class: DocClass,
  uncertainFields: UncertainField[],
): NormalizeResult {
  const normalized: DraftIntake = deepClone(raw);
  const notes: NormalizationNote[] = [];

  // ── 1. Jurisdiction canonicalization ───────────────────────────────────────
  if (typeof normalized.jurisdiction === "string") {
    const { canonical, changed } = canonicalizeJurisdiction(normalized.jurisdiction);
    if (changed) {
      notes.push({
        field: "jurisdiction",
        raw_value: normalized.jurisdiction,
        normalized_value: canonical,
        reason: `jurisdiction canonicalized: '${normalized.jurisdiction}' → '${canonical}'`,
      });
      normalized.jurisdiction = canonical;
    }
  }

  // ── 2. equity.acceleration canonicalization ────────────────────────────────
  if (normalized.equity?.acceleration != null) {
    const result = canonicalizeAcceleration(normalized.equity.acceleration);
    if (result && result.changed) {
      notes.push({
        field: "equity.acceleration",
        raw_value: normalized.equity.acceleration,
        normalized_value: result.canonical,
        reason: `equity.acceleration canonicalized: '${normalized.equity.acceleration}' → '${result.canonical}'`,
      });
      (normalized.equity as any).acceleration = result.canonical;
    }
  }

  // ── 3. ip.scope canonicalization ──────────────────────────────────────────
  if (normalized.ip?.scope != null) {
    const result = canonicalizeIpScope(normalized.ip.scope);
    if (result) {
      if (result.changed) {
        notes.push({
          field: "ip.scope",
          raw_value: normalized.ip.scope,
          normalized_value: result.canonical,
          reason: `ip.scope canonicalized: '${normalized.ip.scope}' → '${result.canonical}'`,
        });
        (normalized.ip as any).scope = result.canonical;
      }
      if (result.uncertain) {
        // Add to uncertain_fields if not already there
        const alreadyUncertain = uncertainFields.some((uf) => uf.field === "ip.scope");
        if (!alreadyUncertain) {
          uncertainFields = [
            ...uncertainFields,
            {
              field: "ip.scope",
              extracted_value: normalized.ip.scope,
              confidence: 0.4,
              reason: `ip.scope value '${normalized.ip.scope}' is not a recognized enum value`,
            },
          ];
        }
      }
    }
  }

  // ── 4. parties[*].entity_type canonicalization ────────────────────────────
  if (Array.isArray(normalized.parties)) {
    for (let i = 0; i < normalized.parties.length; i++) {
      const party = normalized.parties[i];
      if (party.entity_type != null) {
        const result = canonicalizeEntityType(party.entity_type);
        if (result && result.changed) {
          notes.push({
            field: `parties[${i}].entity_type`,
            raw_value: party.entity_type,
            normalized_value: result.canonical,
            reason: `entity_type canonicalized: '${party.entity_type}' → '${result.canonical}'`,
          });
          (normalized.parties[i] as any).entity_type = result.canonical;
        }
      }
    }
  }

  // ── 5. equity.split completeness check ────────────────────────────────────
  if (normalized.equity?.split != null && doc_class === "co_founder_agreement") {
    const { complete, sum } = checkEquitySplitCompleteness(
      normalized.equity.split as Record<string, number>,
    );
    if (!complete) {
      notes.push({
        field: "equity.split",
        raw_value: normalized.equity.split,
        normalized_value: normalized.equity.split,
        reason: `equity.split extracted but incomplete — sums to ${sum.toFixed(1)}, not 100`,
      });
      // Keep in normalized_intake — verifier fires EQUITY_SPLIT_NOT_100 downstream
    }
  }

  // ── 6. Drop not-applicable fields ─────────────────────────────────────────
  const notApplicableFields = findNotApplicableFields(normalized, doc_class);

  // Remove not-applicable top-level keys
  if (notApplicableFields.includes("equity") && doc_class !== "co_founder_agreement" && doc_class !== "advisor_agreement") {
    delete (normalized as any).equity;
  }
  if (notApplicableFields.includes("ip") && doc_class === "advisor_agreement") {
    delete (normalized as any).ip;
  }
  if (notApplicableFields.includes("advisory") && doc_class !== "advisor_agreement") {
    delete (normalized as any).advisory;
  }

  // Remove equity.split for non-co_founder doc classes
  if (notApplicableFields.includes("equity.split") && normalized.equity) {
    delete (normalized.equity as any).split;
  }

  // Remove advisory sub-fields for non-advisor doc classes
  if (doc_class !== "advisor_agreement" && normalized.advisory) {
    delete (normalized as any).advisory;
  }

  // ── 7. Filter uncertain_fields to applicable fields only ──────────────────
  const applicable = getApplicableTopLevelFields(doc_class);
  const filteredUncertain = uncertainFields.filter((uf) => {
    const topLevel = uf.field.split(".")[0];
    if (!applicable.has(topLevel)) return false;
    // Also filter equity.split for non-co_founder
    if (uf.field === "equity.split" && doc_class !== "co_founder_agreement") return false;
    // Filter advisory.* for non-advisor
    if (uf.field.startsWith("advisory.") && doc_class !== "advisor_agreement") return false;
    return true;
  });

  // ── 8. Missing required fields ────────────────────────────────────────────
  const missingRequiredFields = findMissingRequiredFields(normalized, doc_class);

  // ── 9. Normalization summary ──────────────────────────────────────────────
  const substitutionsMade = notes.filter(
    (n) => n.raw_value !== n.normalized_value,
  ).length;
  const warningsPresent =
    missingRequiredFields.some((f) => f.blocking) ||
    filteredUncertain.length > 0;

  return {
    normalized_intake: normalized,
    normalization_notes: notes,
    normalization_summary: {
      substitutions_made: substitutionsMade,
      warnings_present: warningsPresent,
    },
    not_applicable_fields: notApplicableFields,
    missing_required_fields: missingRequiredFields,
    uncertain_fields: filteredUncertain,
  };
}
