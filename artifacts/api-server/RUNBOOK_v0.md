# Startup Counsel v0 — Recovery Runbook
**Date:** 2026-05-23
**Audience:** JR1 (implementer), JR2 (verifier)
**Scope:** `artifacts/api-server/src/`
**Status:** v0 not landed — workspace lost twice. This runbook is the single source of truth.

> **Contract authority:** Sections 4 and 5 define the canonical API contract. Field names,
> nesting, and status codes must match exactly. Any deviation is a defect, not a style choice.

---

## 1. Smallest Valid File Graph

Seven implementation files plus three golden verification fixtures.

```
src/
├── lib/
│   ├── draftReceiptEngine.ts        ← all shared types + HMAC trust layer
│   ├── startupTemplates.ts          ← 3 document class templates
│   ├── clauseLibrary.ts             ← clause variants + selectVariant()
│   ├── draftEngine.ts               ← buildDraft() + applyRevision()
│   └── draftVerifier.ts             ← verifyDraft() + buildDraftGovernance()
├── routes/
│   └── legal.draft.addendum.ts      ← route handlers, mounted into legal.ts
└── routes/__tests__/
    └── startup.counsel.integration.test.ts   ← endpoint-level tests (see §5)
src/golden/
    ├── golden_cofounder.json
    ├── golden_contractor_ip.json
    └── golden_advisor.json
```

**Not in scope for v0 (do not create):**
- `draftIntakeSchemas.ts` — v0.5
- `intakeQuestions.ts` — v0.5
- `counselResponse.ts` — v0.5

### `legal.ts` mount — MANDATORY

**This is not optional.** The draft routes will not be reachable without it.
Add exactly these two lines to `legal.ts` — no other edits:

```typescript
// At the top of legal.ts, with the other imports:
import draftRouter from "./legal.draft.addendum";

// Inside the router setup block, after existing route registrations:
router.use(draftRouter);
```

**Where to place `router.use(draftRouter)`:** After the last existing `router.use(...)` or
`router.post(...)` call in `legal.ts`, before the `export default router` line.
Do not insert it inside a conditional block or middleware chain.

**Verification:** After mounting, `POST /api/v1/legal/draft` must return 200 or 400
(not 404). A 404 means the mount is missing or placed incorrectly.

**`legal.ts` scope:** Only these two lines are allowed. No other edits to `legal.ts`.
No changes to `legalActionEngine.ts`, `cofounderCorpus.ts`, `governanceEngine.ts`.

---

## 2. Exact Dependency Order

Implement strictly in this sequence. Each file may only import from files above it.

```
1. draftReceiptEngine.ts          — zero local imports; exports ALL shared types
2. startupTemplates.ts            — imports: DocClass from draftReceiptEngine
3. clauseLibrary.ts               — imports: DocClass from draftReceiptEngine
4. draftEngine.ts                 — imports: draftReceiptEngine + startupTemplates + clauseLibrary
5. draftVerifier.ts               — imports: draftReceiptEngine + draftEngine (types only)
6. legal.draft.addendum.ts        — imports: all five lib files above
7. startup.counsel.integration.test.ts — imports: draftEngine + draftVerifier + draftReceiptEngine
```

**Hard rule:** `draftVerifier` must NOT call `buildDraft()`. It receives `BuildDraftResult`
as a parameter. No circular imports.

---

## 3. Complete Type Contracts

### 3.1 `draftReceiptEngine.ts` — all shared types live here

```typescript
import crypto from "crypto";

// ── Enums / unions ────────────────────────────────────────────────────────────
export type DocClass =
  | "co_founder_agreement"
  | "contractor_ip_assignment"
  | "advisor_agreement";

export type ArtifactStatus =
  | "draft_pending_approval"
  | "needs_revision"
  | "blocked";

// ── Intake ────────────────────────────────────────────────────────────────────
// DraftIntake is the INTERNAL trusted type — used after the route handler
// has validated and coerced the raw request body.
// allow_model_clause_rewrite is locked to false | undefined here.
// See §3.6 for the request-boundary type distinction.
export interface DraftIntake {
  doc_class: DocClass;
  jurisdiction: string;
  parties: Array<{ name: string; role: string; entity_type?: string }>;
  effective_date?: string;
  equity?: {
    split?: Record<string, number>;
    vesting_years?: number;
    cliff_months?: number;
    acceleration?: "single" | "double" | "none";
  };
  ip?: {
    prior_inventions?: string[];
    scope?: "broad" | "work_product_only";
  };
  advisory?: {
    equity_pct?: number;
    services_description?: string;
    cash_fee?: number;
  };
  user_instruction?: string;
  allow_model_clause_rewrite?: false;   // internal: only false or absent
}

// ── Verifier flag types ───────────────────────────────────────────────────────
export interface MissingDataFlag {
  field: string;
  impact: string;
}
export interface LegalConflictFlag {
  conflict_id: string;
  description: string;
  sections_involved: string[];
  severity: "blocking" | "warning";
}
export interface TemplateFailureFlag {
  failure_id: string;
  section: string;
  detail: string;
  severity: "blocking" | "warning";
}
export interface JurisdictionFlag {
  flag_id: string;
  jurisdiction: string;
  section: string;
  description: string;
  severity: "blocking" | "warning";
  recommended_action: string;
}
export interface VerifierResult {
  passed: boolean;
  missing_data: MissingDataFlag[];
  legal_conflicts: LegalConflictFlag[];
  template_failures: TemplateFailureFlag[];
  jurisdiction_escalations: JurisdictionFlag[];
}

// ── DraftSection (defined here so StoredDraftArtifact can reference it
//    without a circular import from draftEngine) ───────────────────────────────
export interface DraftSection {
  section_id: string;
  title: string;
  body: string;
  variant_used?: string;
}

// ── Receipt ───────────────────────────────────────────────────────────────────
export interface DraftReceipt {
  receipt_id: string;           // UUID
  draft_id: string;             // UUID — key into DraftArtifactStore
  doc_class: DocClass;
  draft_hash: string;           // SHA-256 of full_text
  intake_hash: string;          // SHA-256 of JSON.stringify(intake)
  template_version: string;
  clause_library_version: string;
  verifier_version: string;
  governance_artifact_status: ArtifactStatus;
  issued_at: string;            // ISO
  expires_at: string;           // ISO — 4 hr TTL
  parent_receipt_id: string | null;
}

// ── Stored artifact ───────────────────────────────────────────────────────────
export interface StoredDraftArtifact {
  draft_id: string;
  parent_draft_id: string | null;
  receipt_id: string;
  doc_class: DocClass;
  intake: DraftIntake;          // trusted — never re-accepted from client
  sections: DraftSection[];
  full_text: string;
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  verifier_result: VerifierResult;
  governance_artifact_status: ArtifactStatus;
  revision_number: number;      // 0 for first draft
  created_at: string;
}

// ── Artifact store ────────────────────────────────────────────────────────────
export interface IDraftArtifactStore {
  put(artifact: StoredDraftArtifact): void;
  get(draft_id: string): StoredDraftArtifact | undefined;
}
// v0: in-process Map singleton — interface defined for DB swap in v1
export const DraftArtifactStore: IDraftArtifactStore;

// ── Receipt functions ─────────────────────────────────────────────────────────
// Single opts object — NOT two separate positional arguments
export function issueDraftReceipt(opts: {
  draft_id: string;
  doc_class: DocClass;
  full_text: string;
  intake: DraftIntake;
  template_version: string;
  clause_library_version: string;
  verifier_version: string;
  governance_artifact_status: ArtifactStatus;
  parent_receipt_id: string | null;
  secret: string;
}): string; // returns base64 token

export function verifyDraftReceipt(
  token: string,
  secret: string,
): { valid: true; receipt: DraftReceipt } | { valid: false; reason: string };

export function hashText(text: string): string; // SHA-256 hex
```

**Implementation notes:**
- Token format: `base64(JSON.stringify({ payload: string, sig: string }))` — same envelope as `MatterReceipt`
- `sig` = HMAC-SHA256 of `payload` string using `SESSION_SECRET`
- Verify uses `crypto.timingSafeEqual` — no string equality
- TTL = 4 hours (`RECEIPT_TTL_HOURS = 4`)
- `DraftArtifactStore` is a module-level singleton (`new Map<string, StoredDraftArtifact>()`) — not recreated per request

---

### 3.2 `startupTemplates.ts`

```typescript
export const TEMPLATE_VERSION = "v1";

export interface DocumentTemplate {
  doc_class: DocClass;
  title_template: string;          // NOT "title" — field is "title_template"
  required_sections: string[];     // ordered; every draft must include all of these
  optional_sections: OptionalSection[];
}

export interface OptionalSection {
  section_id: string;
  condition: (intake: DraftIntake) => boolean;
}

export function getTemplate(doc_class: DocClass): DocumentTemplate;
```

**Required sections per doc class:**

| `co_founder_agreement` | `contractor_ip_assignment` | `advisor_agreement` |
|---|---|---|
| preamble | preamble | preamble |
| equity_split | scope_of_work | advisory_services |
| vesting_schedule | ip_assignment | equity_compensation |
| election_83b | work_made_for_hire | vesting_schedule |
| ip_assignment | moral_rights_waiver | ip_assignment |
| roles_and_responsibilities | prior_inventions_carveout | confidentiality |
| decision_making | confidentiality | no_conflict |
| deadlock_resolution | governing_law | termination |
| transfer_restrictions | representations_and_warranties | governing_law |
| termination_and_buyout | | |
| governing_law | | |

**Optional sections per doc class:**

| Doc class | section_id | Condition |
|---|---|---|
| co_founder | `acceleration_clause` | `intake.equity?.acceleration !== "none" && intake.equity?.acceleration != null` |
| co_founder | `non_solicitation` | `intake.jurisdiction !== "CA"` |
| contractor | `non_solicitation` | `intake.jurisdiction !== "CA"` |
| contractor | `non_compete` | `intake.jurisdiction !== "CA"` |
| advisor | `cash_compensation` | `intake.advisory?.cash_fee != null` |
| advisor | `acceleration_clause` | `intake.equity?.acceleration !== "none" && intake.equity?.acceleration != null` |

---

### 3.3 `clauseLibrary.ts`

```typescript
export const CLAUSE_LIBRARY_VERSION = "v1";

export interface ClauseVariant {
  variant_id: string;
  section: string;
  doc_class: DocClass | "all";
  label: string;
  body: string;                                  // [PLACEHOLDER: field.path] markers allowed
  conditions: string[];                          // documentation only
  jurisdiction_notes: Record<string, string>;
  approved_for_use: boolean;
  reviewed_by: string;
  last_reviewed_at: string;                      // ISO date
  risk_level: "standard" | "elevated" | "requires_counsel";
  allowed_jurisdictions: string[];               // ["*"] = all jurisdictions
}

// Returns best approved variant for (section, doc_class, jurisdiction).
// Preference: exact doc_class match > "all"; standard risk > elevated.
// Returns null if no approved variant exists.
export function selectVariant(
  section: string,
  doc_class: DocClass,
  jurisdiction: string,
  library: ClauseVariant[],
): ClauseVariant | null;

export const CLAUSE_LIBRARY: ClauseVariant[];
```

**Minimum variant set required for all 12 tests to pass:**

| section | variant_ids needed |
|---|---|
| `vesting_schedule` | VS-001 (4yr/1yr), VS-002 (4yr/6mo), VS-003 (3yr/1yr), VS-004 (2yr/6mo) |
| `ip_assignment` | IP-001 (broad, `risk_level: "elevated"`), IP-002 (work_product_only), IP-003 (broad + carve-out) |
| `election_83b` | 83B-001 (full notice) |
| `governing_law` | GL-DE, GL-CA, GL-NY, GL-WA, GL-US |
| `non_solicitation` | NS-001 (12mo, `allowed_jurisdictions: ["DE","NY","WA","TX"]`) |
| `deadlock_resolution` | DR-001 (casting vote) |
| `acceleration_clause` | ACC-001 (single trigger), ACC-002 (double trigger) |
| all other sections | one `"all"` variant each, `approved_for_use: true`, `allowed_jurisdictions: ["*"]` |

**`[PLACEHOLDER: ...]` rule:** Any intake field referenced in a body string must use exactly
`[PLACEHOLDER: field.path]` syntax. `buildDraft` fills these from intake; unresolved ones
remain as-is and trigger `PLACEHOLDER_LEAK` in the verifier.

**Preamble clause — `effective_date` absent rule (no placeholder leakage):**
The preamble variant body MUST NOT contain `[PLACEHOLDER: effective_date]` as a bare marker.
When `effective_date` is absent from intake, the preamble must render a deterministic
fallback string — not leave an unresolved placeholder. The required fallback text is:

```
"the date last signed below"
```

Implement this in the preamble variant body using a conditional fill, not a raw placeholder:

```typescript
// In buildDraft, when filling the preamble body:
const effectiveDateText = intake.effective_date ?? "the date last signed below";
body = body.replace("[PLACEHOLDER: effective_date]", effectiveDateText);
```

This means:
- `effective_date` present → renders the provided date string
- `effective_date` absent → renders `"the date last signed below"` — no `[PLACEHOLDER:` in output
- The preamble variant body MAY contain `[PLACEHOLDER: effective_date]` as a fill target
- After `buildDraft` runs, zero `[PLACEHOLDER:` substrings may remain in any preamble body

This is not a new field. It is a fill-time behavior constraint on the existing `effective_date`
optional field. The `no_placeholder_leak: true` assertion in all three golden fixtures
covers this case.

---

### 3.4 `draftEngine.ts`

```typescript
export interface BuildDraftResult {
  sections: DraftSection[];
  full_text: string;
  section_map: string[];     // ordered list of section_id strings
  assumptions: string[];
  missing_info_flags: string[];
}

export interface RevisionResult {
  new_sections: DraftSection[];    // NOT "sections"
  new_full_text: string;           // NOT "full_text"
  new_section_map: string[];       // NOT "section_map"
  assumptions: string[];
  missing_info_flags: string[];
  not_implemented?: boolean;
}

// Takes intake only — template loaded internally. NOT buildDraft(intake, template).
export function buildDraft(intake: DraftIntake): BuildDraftResult;

export function applyRevision(
  stored: StoredDraftArtifact,
  revision_instruction: string,
  allow_model_rewrite?: boolean,
): RevisionResult;
```

**`buildDraft` behavior:**

1. Apply defaults before section assembly:
   - `equity.acceleration` absent → default `"none"`, push to `assumptions`
   - `equity.vesting_years` absent (co_founder / advisor) → default `4`, `cliff_months` → `12`, push to `assumptions`
   - `ip.scope` absent (co_founder) → default `"broad"`, push to `assumptions`
2. Determine active sections: `required_sections` + optional sections where `condition(intake) === true`
3. For each active section: call `selectVariant(section_id, doc_class, jurisdiction, CLAUSE_LIBRARY)`
   - Variant found: fill `[PLACEHOLDER: ...]` markers from intake; push to `sections`
   - No variant: push `[PLACEHOLDER: <section_id> clause — no approved variant for jurisdiction <X>]` body; push to `missing_info_flags`
4. `full_text` = sections joined with `\n\n---\n\n`, each prefixed `## <title>\n\n<body>`
5. `section_map` = `sections.map(s => s.section_id)`

**`CLAUSE_LIBRARY` must be built at module level from a static import — not inside `buildDraft()`
and not via `require()`.**

**`applyRevision` behavior (deterministic, v0):**

- `allow_model_rewrite = true` → return `{ ...unchanged, not_implemented: true, missing_info_flags: ["model_clause_rewrite_not_implemented"] }`
- Parse `revision_instruction` (case-insensitive) for:
  - `"change vesting to Xyr/Ymo"` or `"use Xyr/Ymo"` → rebuild vesting_schedule section (see §3.4.1)
  - `"switch governing law to XX"` or `"change governing law to XX"` → rebuild governing_law section with new jurisdiction
  - `"remove <section_id>"` → splice section from array
  - Unrecognized → push `"revision_instruction_not_parseable"` to `missing_info_flags`, return draft unchanged
- Trusted intake comes from `stored.intake` — never from the client request

#### 3.4.1 Vesting mutation — exact behavior

When `revision_instruction` matches the vesting pattern (e.g. `"change vesting to 3yr/1yr"`):

**What changes:**
- The `vesting_schedule` section in `new_sections` is replaced with a newly selected variant
- `new_full_text` is rebuilt from the full `new_sections` array
- `new_section_map` is rebuilt from `new_sections.map(s => s.section_id)`

**What does NOT change:**
- `stored.intake` is never mutated — the stored intake retains the original `vesting_years`/`cliff_months`
- All other sections are carried over from `stored.sections` unchanged
- The position of `vesting_schedule` in the array is preserved (same index, not appended)

**Variant selection for vesting mutation:**
Parse `Xyr` → `new_vesting_years: number` and `Ymo` → `new_cliff_months: number` from the instruction.
Call `selectVariant("vesting_schedule", stored.doc_class, stored.intake.jurisdiction, CLAUSE_LIBRARY)`
and pick the variant whose label or `variant_id` best matches the requested years/months.

Matching priority (in order):
1. Exact match: variant body or label contains both `X` year and `Y` month values
2. Nearest match by years first, then cliff: e.g. `"3yr/1yr"` → VS-003 before VS-004
3. If no variant matches at all: push `"no_vesting_variant_for_Xyr_Ymo"` to `missing_info_flags`,
   carry the original vesting section unchanged

**Placeholder fill after variant selection:**
After selecting the new variant, fill `[PLACEHOLDER: ...]` markers using `stored.intake`
(the trusted copy) — not from the revision instruction string. The instruction only
determines which variant to select; intake data populates the clause body.

**`new_sections` construction:**
```typescript
const newSections = stored.sections.map(s =>
  s.section_id === "vesting_schedule" ? newVestingSection : s
);
```
This preserves section order and replaces only the vesting entry.

**`assumptions` and `missing_info_flags` in RevisionResult:**
- Carry forward `stored.assumptions` unchanged
- `missing_info_flags`: empty array unless a matching failure occurred (see above)

---

### 3.5 `draftVerifier.ts`

```typescript
export const VERIFIER_VERSION = "v1";

export interface GovernanceResult {
  artifact_status: ArtifactStatus;
  escalation_required: boolean;
}

export function verifyDraft(
  result: BuildDraftResult,
  intake: DraftIntake,
): VerifierResult;

export function buildDraftGovernance(verifier: VerifierResult): GovernanceResult;
```

**Checks — all deterministic, no model:**

| Check | Bucket | Condition | severity | flag_id / conflict_id |
|---|---|---|---|---|
| Unresolved placeholder | `template_failures` | `/\[PLACEHOLDER:[^\]]+\]/g` matches in `full_text` | `warning` | `PLACEHOLDER_LEAK` |
| Empty section body | `template_failures` | `section.body.trim() === ""` | `blocking` | `MISSING_REQUIRED_SECTION` |
| No approved variant | `template_failures` | body starts with `[PLACEHOLDER:` and contains `"no approved variant"` | `blocking` | `UNAPPROVED_VARIANT` |
| Cliff ≥ total vesting | `legal_conflicts` | `cliff_months >= vesting_years * 12` | `blocking` | `CLIFF_EXCEEDS_TOTAL` |
| Split ≠ 100 | `legal_conflicts` | `abs(sum(split values) - 100) > 0.01` | `blocking` | `EQUITY_SPLIT_NOT_100` |
| CA prohibited covenant | `jurisdiction_escalations` | `jurisdiction === "CA"` AND (`non_solicitation` OR `non_compete` in section_map) | `blocking` | `CA_NONCOMPETE_VOID` |
| 83(b) timing warning | `jurisdiction_escalations` | `election_83b` in section_map (any jurisdiction) | `warning` | `SECTION_83B_TIMING_WARNING` ¹ |
| DE board approval | `jurisdiction_escalations` | `jurisdiction === "DE"` AND (`equity_split` OR `equity_compensation` in section_map) | `warning` | `DE_BOARD_APPROVAL` |
| CA moral rights | `jurisdiction_escalations` | `jurisdiction === "CA"` AND `moral_rights_waiver` in section_map | `warning` | `CA_MORAL_RIGHTS` |

> ¹ **83(b) flag naming:** The legacy identifier `CA_83B_WINDOW_NOTE` is a misnomer — the
> 30-day IRS filing window applies in all US jurisdictions, not only California. The canonical
> v0 identifier is **`SECTION_83B_TIMING_WARNING`**. JR1 must use this name in
> `draftVerifier.ts` and in all test assertions. JR2 must reject any implementation that
> uses `CA_83B_WINDOW_NOTE` in new code.

**`missing_data` flags:** one entry per item in `result.missing_info_flags`.

**`CA_NONCOMPETE_VOID` — Option A (revision-path guard):** This check fires only when a
prohibited section is present in the draft. On the initial draft path, the template correctly
omits `non_solicitation`/`non_compete` for CA — so this flag never fires on a clean CA draft.
It fires only if a revision instruction inserts a prohibited section. Do NOT add proactive
firing logic.

**`buildDraftGovernance` state machine:**

| Condition | `artifact_status` | `escalation_required` |
|---|---|---|
| Any `jurisdiction_escalations` with `severity: "blocking"` | `"blocked"` | `true` |
| Any `template_failures` OR `legal_conflicts` with `severity: "blocking"` | `"needs_revision"` | `true` |
| No blocking flags (warnings only, or all clear) | `"draft_pending_approval"` | `false` |

`missing_data` flags alone do NOT block — draft is produced with placeholders and
`artifact_status: "draft_pending_approval"`.

---

### 3.6 `allow_model_clause_rewrite` — request boundary vs. internal type

This field has two different types depending on where it appears. JR1 must implement both.

**At the HTTP request boundary (raw request body):**
The route handler must accept `boolean | undefined` for this field so that `true` can arrive
and be caught before constructing `DraftIntake`. Use a plain object type or a separate
`DraftRequestBody` interface for the raw body:

```typescript
// In legal.draft.addendum.ts — raw request body type (NOT DraftIntake)
interface DraftRequestBody {
  doc_class: unknown;
  jurisdiction: unknown;
  parties: unknown;
  effective_date?: unknown;
  equity?: unknown;
  ip?: unknown;
  advisory?: unknown;
  user_instruction?: unknown;
  allow_model_clause_rewrite?: boolean;   // accepts true so the 501 guard can fire
}
```

**Validation order in the route handler (exact):**
```
1. Check allow_model_clause_rewrite === true → return 501 immediately
2. Validate doc_class, parties, jurisdiction → return 400 if invalid
3. Construct DraftIntake from validated fields
   (allow_model_clause_rewrite is omitted or set to false in DraftIntake)
4. Call buildDraft(intake)
```

**In `DraftIntake` (internal trusted type, defined in `draftReceiptEngine.ts`):**
`allow_model_clause_rewrite?: false` — only `false` or absent. This is the type that flows
through `buildDraft`, `applyRevision`, `verifyDraft`, and is stored in `DraftArtifactStore`.
A `true` value never reaches `DraftIntake` — it is intercepted at step 1 above.

**Why this matters:** If `DraftIntake` accepted `boolean`, TypeScript would require every
downstream consumer to handle the `true` case. Locking it to `false | undefined` keeps the
internal pipeline clean and makes the 501 guard the single enforcement point.

**`/revise` endpoint:** The `DraftRequestBody` for `/revise` does not include
`allow_model_clause_rewrite` at all — the field is not accepted on revision requests.
The trusted intake is read from `DraftArtifactStore`; its `allow_model_clause_rewrite`
is already `false | undefined`.

---

## 4. Route Contract

> **These definitions are canonical.** Field names, nesting, and status codes must match exactly.

### `POST /api/v1/legal/draft`

**Path registration:** Must be `/v1/legal/draft` in the route handler. The router is mounted
at `/api` — not at `/api/v1/legal`. Registering as `/draft` will silently serve at the wrong path.

**Request body:**

```typescript
{
  // Required
  doc_class: "co_founder_agreement" | "contractor_ip_assignment" | "advisor_agreement";
  jurisdiction: string;
  parties: Array<{ name: string; role: string; entity_type?: string }>; // min 2

  // Optional
  effective_date?: string;
  equity?: {
    split?: Record<string, number>;
    vesting_years?: number;
    cliff_months?: number;
    acceleration?: "single" | "double" | "none";
  };
  ip?: {
    prior_inventions?: string[];
    scope?: "broad" | "work_product_only";
  };
  advisory?: {
    equity_pct?: number;
    services_description?: string;
    cash_fee?: number;
  };
  user_instruction?: string;           // max 500 chars; ignored in v0
  allow_model_clause_rewrite?: boolean; // true → 501; false/absent → proceed
                                        // (boolean at boundary; false|undefined in DraftIntake)
}
```

**Validation → 400:**
- `doc_class` not one of the three valid values
- `parties` has fewer than 2 entries
- `parties` entry missing `name` or `role`
- `jurisdiction` absent or empty string

**→ 501:** `allow_model_clause_rewrite: true`

**Success response (200):**

```typescript
{
  draft_id: string;                 // UUID
  draft_receipt_token: string;      // base64 HMAC-signed receipt
  doc_class: DocClass;
  draft: {
    title: string;                  // filled from title_template
    sections: Array<{
      section_id: string;
      title: string;
      body: string;
      variant_used?: string;
    }>;
    full_text: string;
  };
  section_map: string[];
  assumptions: string[];
  missing_info_flags: string[];
  verifier: {
    passed: boolean;
    missing_data: MissingDataFlag[];
    legal_conflicts: LegalConflictFlag[];
    template_failures: TemplateFailureFlag[];
    jurisdiction_escalations: JurisdictionFlag[];
  };
  governance: {
    artifact_status: "draft_pending_approval" | "needs_revision" | "blocked";
    escalation_required: boolean;
    human_review_required: true;    // hardcoded
    not_legal_advice: true;         // hardcoded
    privilege_warning: string;      // hardcoded (see below)
  };
  trace: {
    draft_id: string;
    doc_class: DocClass;
    template_version: "v1";
    clause_library_version: "v1";
    verifier_version: "v1";
    model_used: null;               // always null in v0
    model_clause_rewrite: false;    // always false in v0
    latency_ms: number;
  };
}
```

**Hardcoded `privilege_warning`:**
```
"This output is generated by an automated system and does not constitute legal advice. Review by qualified counsel is required before execution."
```

---

### `POST /api/v1/legal/draft/revise`

**Path registration:** Must be `/v1/legal/draft/revise`.

**Request body:**

```typescript
{
  draft_receipt_token: string;    // required — from prior /draft or /draft/revise
  revision_instruction: string;   // required — max 500 chars
  // NO intake fields — trusted intake comes from DraftArtifactStore only
  // allow_model_clause_rewrite is NOT accepted here
}
```

**Server-side flow (exact order, do not reorder):**

```
1. Validate body: draft_receipt_token and revision_instruction present → 400 if missing
2. verifyDraftReceipt(token, SESSION_SECRET)
   → { valid: false } → 401 with reason
3. DraftArtifactStore.get(receipt.draft_id)
   → undefined → 404
4. Verify intake integrity:
   hashText(JSON.stringify(stored.intake)) === receipt.intake_hash → 400 if mismatch
5. applyRevision(stored, revision_instruction, false)
6. verifyDraft(revisionResult, stored.intake)
7. buildDraftGovernance(verifierResult)
8. Persist new artifact:
   - new draft_id = crypto.randomUUID()
   - parent_draft_id = receipt.draft_id
   - revision_number = stored.revision_number + 1
9. issueDraftReceipt({ ..., parent_receipt_id: receipt.receipt_id })
10. Return response
```

**Success response (200):** Same shape as `/draft` response, plus:

```typescript
{
  // ... all /draft fields ...
  parent_receipt_id: string;   // receipt_id of the prior draft
  revision_number: number;     // 1 for first revision, increments
}
```

**Error responses:**

| Code | Condition |
|---|---|
| 400 | Missing `draft_receipt_token` or `revision_instruction`; intake hash mismatch |
| 401 | Invalid HMAC signature; expired token |
| 404 | `draft_id` not found in `DraftArtifactStore` |
| 501 | `allow_model_clause_rewrite: true` |
| 500 | Unexpected internal error |

---

## 5. Acceptance Tests

**File:** `src/routes/__tests__/startup.counsel.integration.test.ts`

> **Naming note:** Despite the legacy name `startup.counsel.unit.test.ts` used in prior
> sessions, this file contains **endpoint-level integration tests** — it exercises the full
> request/response cycle through the route handlers, not isolated unit functions. The canonical
> filename is `startup.counsel.integration.test.ts`. If the legacy name already exists in the
> repo, add a comment at the top of the file: `// endpoint-level integration tests — not unit tests`.

**Framework:** Vitest
**No mocks needed.** `DraftArtifactStore` is the in-process Map singleton. No DB, no API keys, no model calls.
**Setup:** `process.env.SESSION_SECRET = "test-secret-v0"` in `beforeAll`.

**12 cases. All must pass. Zero skips.**

```
Case 1 — Happy path: co_founder_agreement, DE, all fields provided
  POST /api/v1/legal/draft with full co-founder intake
  (DE, 50/50 split, 4yr/1yr cliff, single-trigger acceleration, broad IP)
  Assert:
    - HTTP 200
    - governance.artifact_status === "draft_pending_approval"
    - section_map includes all 11 required sections + "acceleration_clause" + "non_solicitation"
    - full_text contains no "[PLACEHOLDER:" substring
    - verifier.jurisdiction_escalations contains flag_id "DE_BOARD_APPROVAL"
    - verifier.jurisdiction_escalations contains flag_id "SECTION_83B_TIMING_WARNING"
    - draft_receipt_token is a non-empty string
    - trace.model_used === null
    - trace.model_clause_rewrite === false

Case 2 — Happy path: contractor_ip_assignment, CA
  POST /api/v1/legal/draft with CA contractor intake (work_product_only IP)
  Assert:
    - HTTP 200
    - governance.artifact_status === "draft_pending_approval"
    - section_map does NOT include "non_solicitation"
    - section_map does NOT include "non_compete"
    - verifier.jurisdiction_escalations contains flag_id "CA_MORAL_RIGHTS"
    - full_text contains no "[PLACEHOLDER:" substring

Case 3 — Happy path: advisor_agreement, DE
  POST /api/v1/legal/draft with DE advisor intake (0.25% equity, 2yr/6mo cliff, no acceleration)
  Assert:
    - HTTP 200
    - governance.artifact_status === "draft_pending_approval"
    - section_map includes "equity_compensation" and "vesting_schedule"
    - section_map does NOT include "acceleration_clause" (acceleration is "none")
    - verifier.jurisdiction_escalations contains flag_id "DE_BOARD_APPROVAL"

Case 4 — Missing-info path: equity.vesting_years absent
  POST /api/v1/legal/draft with co-founder intake, equity.vesting_years omitted
  Assert:
    - HTTP 200
    - governance.artifact_status === "draft_pending_approval"
    - assumptions array contains at least one string mentioning "vesting"
    - full_text contains no "[PLACEHOLDER:" substring (default was applied)
    - verifier.template_failures is empty

Case 5 — Conflict path: cliff_months >= vesting_years * 12
  POST /api/v1/legal/draft with co-founder intake, cliff_months: 48, vesting_years: 4
  Assert:
    - HTTP 200
    - governance.artifact_status === "needs_revision"
    - verifier.legal_conflicts contains conflict_id "CLIFF_EXCEEDS_TOTAL" with severity "blocking"
    - governance.escalation_required === true

Case 6 — Conflict path: equity split sums to 90
  POST /api/v1/legal/draft with co-founder intake, split: { "Alice": 50, "Bob": 40 }
  Assert:
    - HTTP 200
    - governance.artifact_status === "needs_revision"
    - verifier.legal_conflicts contains conflict_id "EQUITY_SPLIT_NOT_100" with severity "blocking"
    - governance.escalation_required === true

Case 7 — Revision loop: valid receipt, "change vesting to 3yr/1yr"
  Step A: POST /api/v1/legal/draft (co-founder, DE, 4yr/1yr)
  Step B: POST /api/v1/legal/draft/revise with token from Step A + instruction "change vesting to 3yr/1yr"
  Assert on Step B response:
    - HTTP 200
    - revision_number === 1
    - parent_receipt_id is a non-empty string and !== draft_receipt_token from Step A
    - draft_id !== draft_id from Step A
    - vesting_schedule section body reflects 3yr/1yr (variant VS-003 or body contains "3" year reference)
    - All other sections are unchanged from Step A (same section_ids, same bodies)
    - section_map order is preserved (vesting_schedule at same index as Step A)

Case 8 — Tampered receipt token
  POST /api/v1/legal/draft/revise with a valid token where one character has been flipped
  Assert: HTTP 401

Case 9 — Expired receipt token
  Construct a receipt with expires_at in the past, sign with SESSION_SECRET, base64-encode
  POST /api/v1/legal/draft/revise with that token
  Assert: HTTP 401

Case 10 — draft_id not in store
  Construct a valid receipt (correct HMAC, not expired) but with a random UUID as draft_id
  POST /api/v1/legal/draft/revise with that token
  Assert: HTTP 404

Case 11 — Invalid doc_class
  POST /api/v1/legal/draft with doc_class: "partnership_agreement"
  Assert: HTTP 400

Case 12 — Model rewrite stub
  POST /api/v1/legal/draft with allow_model_clause_rewrite: true
  Assert: HTTP 501
```

**Token construction for Cases 8–10:** Import `issueDraftReceipt` and `hashText` directly
from `draftReceiptEngine`. For Case 9, override `expires_at` in the payload before signing.
For Case 10, replace `draft_id` in the payload before signing. Re-sign with `"test-secret-v0"`.

---

## 6. Golden Fixture Schema

Three reference JSON files at `src/golden/`. Not runtime dependencies — used by JR2 for
regression spot-checks.

**Shared schema:**

```typescript
{
  "_fixture_version": "v0",
  "_description": string,
  "_section_map_note"?: string,   // explains non-obvious section inclusions/exclusions

  "intake": DraftIntake,          // exact object to POST to /draft

  "expected": {
    "artifact_status": ArtifactStatus,
    "section_map": string[],                    // exact ordered list of section_ids
    "jurisdiction_escalation_ids": string[],    // flag_id values expected present
    "legal_conflict_ids": string[],             // conflict_id values expected present
    "template_failure_ids": string[],           // failure_id values expected present
    "assumptions_contain": string[],            // substrings; each must appear in ≥1 assumption
    "no_placeholder_leak": true                 // full_text must have zero [PLACEHOLDER: ...] matches
  }
}
```

**`golden_cofounder.json`:**

```json
{
  "_fixture_version": "v0",
  "_description": "2 founders, DE, 50/50 split, 4yr/1yr cliff, single-trigger, broad IP + prior inventions carve-out",
  "_section_map_note": "non_solicitation present because jurisdiction is DE (condition: !== CA)",
  "intake": {
    "doc_class": "co_founder_agreement",
    "jurisdiction": "DE",
    "parties": [
      { "name": "Alice Chen", "role": "co_founder" },
      { "name": "Bob Park",   "role": "co_founder" }
    ],
    "equity": {
      "split": { "Alice Chen": 50, "Bob Park": 50 },
      "vesting_years": 4,
      "cliff_months": 12,
      "acceleration": "single"
    },
    "ip": { "scope": "broad", "prior_inventions": ["personal blog engine"] }
  },
  "expected": {
    "artifact_status": "draft_pending_approval",
    "section_map": [
      "preamble", "equity_split", "vesting_schedule", "election_83b",
      "ip_assignment", "roles_and_responsibilities", "decision_making",
      "deadlock_resolution", "transfer_restrictions", "termination_and_buyout",
      "governing_law", "acceleration_clause", "non_solicitation"
    ],
    "jurisdiction_escalation_ids": ["DE_BOARD_APPROVAL", "SECTION_83B_TIMING_WARNING"],
    "legal_conflict_ids": [],
    "template_failure_ids": [],
    "assumptions_contain": [],
    "no_placeholder_leak": true
  }
}
```

**`golden_contractor_ip.json`:**

```json
{
  "_fixture_version": "v0",
  "_description": "Contractor + company, CA, work-product-only IP, prior inventions listed",
  "_section_map_note": "non_solicitation and non_compete omitted — jurisdiction is CA",
  "intake": {
    "doc_class": "contractor_ip_assignment",
    "jurisdiction": "CA",
    "parties": [
      { "name": "Riya Desai",  "role": "contractor" },
      { "name": "Acme Inc.",   "role": "company" }
    ],
    "ip": {
      "scope": "work_product_only",
      "prior_inventions": ["personal blog engine", "open source CLI tool"]
    }
  },
  "expected": {
    "artifact_status": "draft_pending_approval",
    "section_map": [
      "preamble", "scope_of_work", "ip_assignment", "work_made_for_hire",
      "moral_rights_waiver", "prior_inventions_carveout", "confidentiality",
      "governing_law", "representations_and_warranties"
    ],
    "jurisdiction_escalation_ids": ["CA_MORAL_RIGHTS"],
    "legal_conflict_ids": [],
    "template_failure_ids": [],
    "assumptions_contain": [],
    "no_placeholder_leak": true
  }
}
```

**`golden_advisor.json`:**

```json
{
  "_fixture_version": "v0",
  "_description": "Advisor + company, DE, 0.25% equity, 2yr/6mo cliff, no acceleration",
  "intake": {
    "doc_class": "advisor_agreement",
    "jurisdiction": "DE",
    "parties": [
      { "name": "Marcus Webb",      "role": "advisor" },
      { "name": "Nexus Labs Inc.",  "role": "company" }
    ],
    "equity": {
      "vesting_years": 2,
      "cliff_months": 6,
      "acceleration": "none"
    },
    "advisory": {
      "equity_pct": 0.25,
      "services_description": "strategic introductions and go-to-market advisory"
    }
  },
  "expected": {
    "artifact_status": "draft_pending_approval",
    "section_map": [
      "preamble", "advisory_services", "equity_compensation", "vesting_schedule",
      "ip_assignment", "confidentiality", "no_conflict", "termination", "governing_law"
    ],
    "jurisdiction_escalation_ids": ["DE_BOARD_APPROVAL"],
    "legal_conflict_ids": [],
    "template_failure_ids": [],
    "assumptions_contain": [],
    "no_placeholder_leak": true
  }
}
```

---

## 7. Definition of Done

v0 is landed when **every item below is checked**. JR2 owns this list.

### Code completeness
- [ ] All 7 implementation files exist at the exact paths in Section 1
- [ ] All 3 golden fixtures exist at `src/golden/`
- [ ] No extra files created (`draftIntakeSchemas.ts`, `counselResponse.ts`, `intakeQuestions.ts` must not exist)
- [ ] `tsc --noEmit` exits 0 — zero new TS errors (pre-existing errors on `legal.ts` lines 1620/1634/1778 are exempt)
- [ ] Zero `require()` calls in any of the 7 implementation files — ESM `import` only
- [ ] `CLAUSE_LIBRARY` array is built at module level in `clauseLibrary.ts` — not inside any function

### Singletons and state
- [ ] `DraftArtifactStore` is a module-level singleton — same instance across all requests in a process
- [ ] `DraftArtifactStore` is NOT re-created per request or per test file

### Route registration — MANDATORY
- [ ] `import draftRouter from "./legal.draft.addendum"` added to `legal.ts`
- [ ] `router.use(draftRouter)` added to `legal.ts` after existing route registrations
- [ ] `POST /api/v1/legal/draft` responds at exactly that path (not 404)
- [ ] `POST /api/v1/legal/draft/revise` responds at exactly that path (not 404)
- [ ] Only these two lines added to `legal.ts` — no other edits
- [ ] `/revise` does NOT accept any intake fields from the client

### Signature correctness
- [ ] `issueDraftReceipt` takes a single opts object (not two positional arguments)
- [ ] `buildDraft` takes only `intake` — no template argument
- [ ] `RevisionResult` fields are `new_sections`, `new_full_text`, `new_section_map`
- [ ] `DocumentTemplate` field is `title_template` (not `title`)

### Type boundary correctness
- [ ] Route handler accepts `allow_model_clause_rewrite?: boolean` in raw request body type
- [ ] `DraftIntake` has `allow_model_clause_rewrite?: false` (not `boolean`)
- [ ] 501 guard fires before `DraftIntake` is constructed — `true` never reaches internal pipeline
- [ ] `/revise` request body type does not include `allow_model_clause_rewrite`

### Preamble / effective_date
- [ ] Preamble variant body uses `[PLACEHOLDER: effective_date]` as a fill target (not hardcoded)
- [ ] `buildDraft` fills `effective_date` with `intake.effective_date ?? "the date last signed below"`
- [ ] No `[PLACEHOLDER:` substring remains in preamble body after `buildDraft` runs
- [ ] Case 4 (vesting_years absent) passes with `no_placeholder_leak` — confirms default fill works

### Vesting mutation (applyRevision)
- [ ] `stored.intake` is never mutated by `applyRevision`
- [ ] `new_sections` is the full section array with vesting_schedule replaced in-place (same index)
- [ ] `new_section_map` is rebuilt from `new_sections.map(s => s.section_id)`
- [ ] `new_full_text` is rebuilt from the full `new_sections` array
- [ ] All non-vesting sections are identical to `stored.sections` after revision
- [ ] Case 7 asserts section order is preserved and only vesting body changed

### Flag naming
- [ ] 83(b) timing flag is `SECTION_83B_TIMING_WARNING` — not `CA_83B_WINDOW_NOTE`
- [ ] No occurrence of `CA_83B_WINDOW_NOTE` in any new file

### Tests
- [ ] Test file is named `startup.counsel.integration.test.ts` OR legacy name has the endpoint-level comment at top
- [ ] `vitest run startup.counsel.integration.test.ts` → 12/12 pass, 0 skipped
- [ ] Case 1 asserts `SECTION_83B_TIMING_WARNING` (not `CA_83B_WINDOW_NOTE`)
- [ ] Case 2 asserts `CA_MORAL_RIGHTS` — clean CA contractor draft has no prohibited section to flag
- [ ] Case 6 asserts `EQUITY_SPLIT_NOT_100` with split summing to 90
- [ ] Case 7 asserts all non-vesting sections unchanged and section order preserved

### Verifier behavior
- [ ] `CA_NONCOMPETE_VOID` does NOT fire on a clean CA contractor draft
- [ ] `CA_NONCOMPETE_VOID` DOES fire if a revision inserts `non_solicitation` into a CA draft
- [ ] `EQUITY_SPLIT_NOT_100` fires when split sum deviates from 100 by more than 0.01
- [ ] `CLIFF_EXCEEDS_TOTAL` fires when `cliff_months >= vesting_years * 12`
- [ ] `missing_data` flags alone do not change `artifact_status` from `draft_pending_approval`

### Golden fixtures
- [ ] Posting each golden `intake` to `/draft` returns `artifact_status` matching `expected.artifact_status`
- [ ] Posting each golden `intake` returns `section_map` matching `expected.section_map` exactly (order matters)
- [ ] Posting each golden `intake` returns all `expected.jurisdiction_escalation_ids` present in response
- [ ] No golden response contains a `[PLACEHOLDER:` substring in `full_text`

### No regressions
- [ ] Existing routes (`/matter`, `/action`, `/extract-clause`, `/cofounder/analyze`, `/playbook/run`) return unchanged responses
- [ ] `legalActionEngine.ts`, `cofounderCorpus.ts`, `governanceEngine.ts` are unmodified (git diff clean)

---

## Appendix: Pitfall Reference

Every item here caused a real bug in prior implementation passes.

| Pitfall | Correct behavior |
|---|---|
| Route registered as `"/draft"` | Must be `"/v1/legal/draft"` — router mounts at `/api`, not `/api/v1/legal` |
| `router.use(draftRouter)` not added to `legal.ts` | **MANDATORY** — routes are unreachable without it; 404 is the symptom |
| `issueDraftReceipt(receipt, secret)` | Takes one opts object: `{ draft_id, doc_class, full_text, intake, ..., secret }` |
| `template.title` | Field is `template.title_template` |
| `revisionResult.sections` | Fields are `new_sections`, `new_full_text`, `new_section_map` |
| `buildDraft(intake, template)` | Signature is `buildDraft(intake)` — template loaded internally |
| `CA_83B_WINDOW_NOTE` in new code | Use `SECTION_83B_TIMING_WARNING` — the 30-day window is not CA-specific |
| `CA_NONCOMPETE_VOID` fires on clean CA draft | Must NOT — template omits the section; verifier only fires if section is present |
| `non_solicitation` absent from DE co-founder `section_map` | Must be present — condition is `jurisdiction !== "CA"`, true for DE |
| `DraftArtifactStore` re-created per request | Must be module singleton — revision loop requires the same instance |
| `require()` inside `buildDraft` | Use static `import` at top of file; build `CLAUSE_LIBRARY` at module level |
| `EQUITY_SPLIT_NOT_100` test uses split summing to 100 | Test must use a split that sums to ≠ 100 (e.g., `{ "Alice": 50, "Bob": 40 }` = 90) |
| `allow_model_clause_rewrite: boolean` in `DraftIntake` | `DraftIntake` locks to `false \| undefined`; raw request body accepts `boolean` |
| `effective_date` absent → `[PLACEHOLDER: effective_date]` in output | Fill with `"the date last signed below"` — never leave bare placeholder in preamble |
| `applyRevision` mutates `stored.intake` | Intake is read-only; only `new_sections` / `new_full_text` / `new_section_map` change |
| `new_sections` appends revised section instead of replacing in-place | Use `.map()` to replace at same index — section order must be preserved |

---

*v0.5 planning resumes after all DoD checkboxes are checked by JR2.*
